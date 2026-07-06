import getSupabase from '../../lib/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  const { method } = req;
  
  if (method !== 'GET' && method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sessionToken = method === 'GET' ? req.query.sessionToken : req.body.sessionToken;
  const id = method === 'GET' ? req.query.id : req.body.id;

  // sessionToken is required — prevents UUID-enumeration attacks
  if (!sessionToken) {
    return res.status(401).json({ error: 'sessionToken is required' });
  }

  try {
    const supabase = getSupabase();

    if (method === 'DELETE') {
      if (!id || !UUID_RE.test(id)) {
        return res.status(400).json({ error: 'Invalid or missing document id format' });
      }

      // Check ownership
      const { data: doc, error: docError } = await supabase
        .from('documents')
        .select('id, session_token')
        .eq('id', id)
        .single();

      if (docError || !doc) {
        return res.status(404).json({ error: 'Document not found' });
      }

      if (doc.session_token !== sessionToken) {
        return res.status(403).json({ error: 'Access denied: invalid session token' });
      }

      // Delete chunks first to avoid foreign key violations in case Cascade delete is not set up/working in Supabase
      const { error: chunksDeleteError } = await supabase
        .from('chunks')
        .delete()
        .eq('document_id', id);

      if (chunksDeleteError) {
        console.warn('[/api/documents] Warning: chunk deletion returned error (might be ignored if database handled cascade):', chunksDeleteError);
      }

      // Now delete the document
      const { error: deleteError } = await supabase
        .from('documents')
        .delete()
        .eq('id', id);

      if (deleteError) throw deleteError;

      return res.status(200).json({ success: true, message: 'Document deleted successfully' });
    }

    if (id) {
      // ── Single document fetch ──
      if (!UUID_RE.test(id)) {
        return res.status(400).json({ error: 'Invalid document id format' });
      }

      const { data, error } = await supabase
        .from('documents')
        .select('id, title, page_count, chunk_count, truncated, created_at')
        .eq('id', id)
        .eq('session_token', sessionToken)  // ownership enforced in DB query
        .single();

      if (error || !data) {
        // 404 regardless of whether document exists — prevents information leakage
        return res.status(404).json({ error: 'Document not found' });
      }

      return res.status(200).json(data);
    } else {
      // ── All documents for this session token ──
      const { data, error } = await supabase
        .from('documents')
        .select('id, title, page_count, chunk_count, truncated, created_at')
        .eq('session_token', sessionToken)
        .order('created_at', { ascending: false });

      if (error) throw error;

      return res.status(200).json({ documents: data ?? [] });
    }
  } catch (err) {
    console.error('[/api/documents]', err);
    return res.status(500).json({ error: err.message });
  }
}
