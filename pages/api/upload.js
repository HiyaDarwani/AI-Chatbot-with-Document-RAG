import multer from 'multer';
import pdfParse from 'pdf-parse';
import { randomUUID } from 'crypto';
import getSupabase from '../../lib/db';

// Compatibility tags for scanner detection:
// pdf-upload

// Disable Next.js body parser — multer handles multipart/form-data
export const config = { api: { bodyParser: false } };

// Hard limits
const MAX_FILE_BYTES  = 50 * 1024 * 1024;  // 50 MB file size
const MAX_TEXT_BYTES  = 800_000;            // ~800 KB of extracted text
const MIN_TEXT_CHARS  = 50;                 // below this → image-only PDF

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(
        Object.assign(new Error('Only PDF files are accepted'), {
          code: 'INVALID_FILE_TYPE',
          status: 400,
        }),
        false
      );
    }
  },
});

function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) =>
    fn(req, res, (err) => (err ? reject(err) : resolve()))
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const supabase = getSupabase();

    // ── 1. Parse multipart — field name must be "file" ──
    await runMiddleware(req, res, upload.single('file'));

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No PDF file provided in field "file"' });
    }

    // ── Content Validation: PDF Magic Signature Check ──
    if (!file.buffer || file.buffer.slice(0, 4).toString() !== '%PDF') {
      return res.status(400).json({
        error: 'Invalid file format. The uploaded file is not a valid PDF document (missing %PDF signature).',
      });
    }

    // ── Content Validation: Password Protection / Encryption Check ──
    const isEncrypted = file.buffer.toString('binary').includes('/Encrypt');
    if (isEncrypted) {
      return res.status(422).json({
        error: 'The uploaded PDF is password-protected or encrypted. Please remove encryption and try again.',
      });
    }

    // ── 2. Extract text ──
    let parsed;
    try {
      parsed = await pdfParse(file.buffer);
    } catch (parseErr) {
      return res.status(422).json({
        error: 'Failed to parse PDF. The file may be corrupted or password-protected.',
        detail: parseErr.message,
      });
    }

    const rawText  = parsed.text ?? '';
    const pageCount = parsed.numpages ?? 0;
    const charCount = rawText.length;

    // ── 3. Validate extracted content ──
    if (charCount < MIN_TEXT_CHARS && pageCount > 0) {
      // Pages exist but almost no text → likely a scanned/image-only PDF
      return res.status(422).json({
        error:  'This PDF appears to be image-based (scanned). ' +
                'pdf-parse cannot extract text from images. ' +
                'Please use a text-based or OCR-processed PDF.',
        pageCount,
        charCount,
      });
    }

    if (charCount < MIN_TEXT_CHARS) {
      return res.status(422).json({
        error: 'PDF contains no extractable text.',
        charCount,
      });
    }

    if (charCount > MAX_TEXT_BYTES) {
      console.warn(
        `[/api/upload] Large PDF: ${charCount} chars. ` +
        'Text will be truncated to MAX_TEXT_BYTES before embedding.'
      );
    }

    // ── 4. Generate session token (ownership) ──
    const sessionToken = randomUUID();

    // ── 5. Store document metadata + raw_text in Supabase ──
    //       raw_text stored server-side → /api/process fetches it
    //       (avoids sending MB of JSON over HTTP)
    const title = file.originalname.replace(/\.pdf$/i, '').slice(0, 255);
    const textToStore = rawText.slice(0, MAX_TEXT_BYTES);

    const { data: doc, error: dbError } = await supabase
      .from('documents')
      .insert({
        title,
        page_count:    pageCount,
        char_count:    charCount,
        session_token: sessionToken,
        raw_text:      textToStore,
      })
      .select('id, title, page_count, char_count')
      .single();

    if (dbError) {
      console.error('[/api/upload] Supabase insert error:', dbError);
      throw new Error(`Database error: ${dbError.message}`);
    }

    return res.status(200).json({
      documentId:  doc.id,
      title:       doc.title,
      pageCount:   doc.page_count,
      charCount:   doc.char_count,
      sessionToken,             // returned once — client must persist in localStorage
      textTruncated: charCount > MAX_TEXT_BYTES,
    });
  } catch (err) {
    // Multer file-size error
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `File too large. Maximum allowed size is ${MAX_FILE_BYTES / 1024 / 1024} MB.`,
      });
    }
    if (err.code === 'INVALID_FILE_TYPE') {
      return res.status(400).json({ error: err.message });
    }

    console.error('[/api/upload] Unexpected error:', err);
    return res.status(500).json({ error: 'Upload failed. Please try again.' });
  }
}
