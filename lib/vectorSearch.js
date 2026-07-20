import getSupabase from './db';

// Minimum cosine similarity to consider a chunk "relevant".
// 0.30 means the chunk shares at least 30% directional similarity with the query.
// Below this threshold chunks are typically off-topic noise that cause hallucinations.
const DEFAULT_MIN_SIMILARITY = 0.50;

/**
 * Find the top-k most relevant chunks for a query embedding
 * using cosine similarity via the match_chunks Postgres RPC.
 *
 * Only returns chunks with similarity >= minSimilarity to ensure
 * Claude's context window contains genuinely relevant content.
 *
 * @param {number[]} queryEmbedding  — 384-dim embedding of the user's question
 * @param {object}   options
 * @param {string}   [options.documentId]       — restrict search to a specific document
 * @param {number}   [options.matchCount=5]      — max chunks to return
 * @param {number}   [options.minSimilarity]     — similarity floor (0–1)
 * @returns {Promise<Array<{
 *   id: string, document_id: string, content: string, content_hash: string,
 *   chunk_index: number, source_page: number, similarity: number
 * }>>}
 */
export async function vectorSearch(
  queryEmbedding,
  {
    documentId   = null,
    matchCount   = 5,
    minSimilarity = DEFAULT_MIN_SIMILARITY,
  } = {}
) {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('match_chunks', {
    query_embedding: queryEmbedding,
    match_count:     matchCount,
    filter_doc_id:   documentId,
    min_similarity:  minSimilarity,
  });

  if (error) {
    console.error('[vectorSearch] Supabase RPC error:', error);
    throw new Error(`Vector search failed: ${error.message}`);
  }

  return data ?? [];
}

/**
 * Fetch already-stored content hashes for a document.
 * Used by /api/process to skip re-embedding duplicate chunks.
 *
 * @param {string} documentId
 * @returns {Promise<Set<string>>} Set of SHA-256 hex strings
 */
export async function getExistingHashes(documentId) {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('get_existing_hashes', {
    doc_id: documentId,
  });

  if (error) {
    console.error('[getExistingHashes] Supabase RPC error:', error);
    // Non-fatal: if we can't check, we'll re-embed (safe fallback)
    return new Set();
  }

  return new Set((data ?? []).map(row => row.content_hash));
}
