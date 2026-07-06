import { chunkText } from '../../lib/chunker';
import { embedBatch, hashContent, EmbeddingError } from '../../lib/embedder';
import { getExistingHashes } from '../../lib/vectorSearch';
import getSupabase from '../../lib/db';

export const config = { api: { bodyParser: true } };

// UUID v4 regex — validates documentId format
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DB_BATCH_SIZE = 50; // Supabase payload limit per insert

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { documentId, sessionToken } = req.body;

  // ── 1. Input validation ──
  if (!documentId || !UUID_RE.test(documentId)) {
    return res.status(400).json({ error: 'Invalid or missing documentId' });
  }
  if (!sessionToken) {
    return res.status(401).json({ error: 'sessionToken is required' });
  }

  try {
    const supabase = getSupabase();

    // ── 2. Ownership check — verify sessionToken matches document ──
    const { data: doc, error: docError } = await supabase
      .from('documents')
      .select('id, title, raw_text, session_token')
      .eq('id', documentId)
      .single();

    if (docError || !doc) {
      return res.status(404).json({ error: 'Document not found' });
    }
    if (doc.session_token !== sessionToken) {
      return res.status(403).json({ error: 'Access denied: invalid session token' });
    }
    if (!doc.raw_text || doc.raw_text.trim().length === 0) {
      return res.status(422).json({ error: 'Document has no extractable text to process' });
    }

    // ── 3. Chunk the stored raw text ──
    const allChunks = await chunkText(doc.raw_text);

    if (allChunks.length === 0) {
      return res.status(422).json({ error: 'No usable text chunks produced from this document' });
    }

    // ── 4. Hash each chunk content for deduplication ──
    const chunksWithHash = allChunks.map(chunk => ({
      ...chunk,
      hash: hashContent(chunk.content),
    }));

    // ── 5. Fetch hashes already stored for this document ──
    //       (safe for re-processing — skips chunks already embedded)
    const existingHashes = await getExistingHashes(documentId);

    const newChunks = chunksWithHash.filter(c => !existingHashes.has(c.hash));
    const skipped   = chunksWithHash.length - newChunks.length;

    if (skipped > 0) {
      console.log(`[/api/process] Skipping ${skipped} already-embedded chunks for doc ${documentId}`);
    }

    if (newChunks.length === 0) {
      // All chunks already embedded — document was re-uploaded unchanged
      return res.status(200).json({
        chunksCreated: 0,
        chunksSkipped: skipped,
        truncated: false,
        documentId,
        message: 'All chunks already indexed (no re-embedding needed)',
      });
    }

    // ── 6. Batch-embed new chunks (respects 200-chunk cost cap) ──
    const contents = newChunks.map(c => c.content);
    let embeddings, truncated;

    try {
      ({ embeddings, truncated } = await embedBatch(contents));
    } catch (err) {
      if (err instanceof EmbeddingError) {
        const status = err.retryable ? 503 : 422;
        return res.status(status).json({
          error: err.message,
          retryable: err.retryable,
        });
      }
      throw err;
    }

    // Slice chunks to match embeddings if truncated
    const chunksToStore = newChunks.slice(0, embeddings.length);

    // ── 7. Build DB rows ──
    const rows = chunksToStore.map((chunk, i) => ({
      document_id:  documentId,
      content:      chunk.content,
      content_hash: chunk.hash,
      chunk_index:  chunk.chunkIndex,
      source_page:  null,
      embedding:    embeddings[i],
    }));

    // ── 8. Bulk insert in batches (rollback on failure) ──
    let insertedCount = 0;
    try {
      for (let i = 0; i < rows.length; i += DB_BATCH_SIZE) {
        const batch = rows.slice(i, i + DB_BATCH_SIZE);
        const { error } = await supabase.from('chunks').insert(batch);
        if (error) throw error;
        insertedCount += batch.length;
      }
    } catch (insertErr) {
      // Partial insert failed — rollback all chunks for this document to stay consistent
      console.error('[/api/process] Insert failed, rolling back chunks:', insertErr);
      await supabase.from('chunks').delete().eq('document_id', documentId);
      throw new Error(`Failed to store chunks: ${insertErr.message}`);
    }

    // ── 9. Update document metadata ──
    const totalChunks = existingHashes.size + insertedCount;
    await supabase
      .from('documents')
      .update({ chunk_count: totalChunks, truncated })
      .eq('id', documentId);

    return res.status(200).json({
      chunksCreated: insertedCount,
      chunksSkipped: skipped,
      truncated,
      documentId,
    });
  } catch (err) {
    console.error('[/api/process] Unexpected error:', err);
    return res.status(500).json({ error: err.message });
  }
}
