-- ============================================================
-- 1. Enable the pgvector extension
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- 2. Documents table — one row per uploaded PDF
--    session_token: lightweight ownership (UUID returned to client)
--    raw_text:      stores extracted text server-side (avoids large HTTP body)
-- ============================================================
CREATE TABLE IF NOT EXISTS documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  page_count    INT,
  char_count    INT,
  chunk_count   INT DEFAULT 0,
  truncated     BOOLEAN DEFAULT FALSE,  -- TRUE if chunk cap was hit
  session_token TEXT NOT NULL,          -- ownership: returned to uploader only
  raw_text      TEXT,                   -- stored server-side for /api/process
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Fast lookup by session_token (ownership checks on every request)
CREATE INDEX IF NOT EXISTS documents_session_token_idx
  ON documents (session_token);

-- ============================================================
-- 3. Chunks table — one row per text chunk + its embedding
--    content_hash: SHA-256 of content — prevents re-embedding identical text
-- ============================================================
CREATE TABLE IF NOT EXISTS chunks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  UUID REFERENCES documents(id) ON DELETE CASCADE,
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL,           -- SHA-256 hex; used for deduplication
  chunk_index  INT NOT NULL,
  source_page  INT,
  embedding    vector(384),             -- Jina AI jina-embeddings-v3 (384 dimensions)
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- HNSW index for fast approximate nearest-neighbour search (cosine distance)
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
  ON chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- B-tree index for hash-based deduplication lookups
CREATE INDEX IF NOT EXISTS chunks_content_hash_idx
  ON chunks (content_hash);

-- ============================================================
-- 4. match_chunks RPC — cosine similarity search with minimum threshold
--    min_similarity: filters out low-relevance chunks (default 0.0 = no filter)
--    Set to 0.35 in application code to avoid hallucination from weak matches
-- ============================================================
CREATE OR REPLACE FUNCTION match_chunks(
  query_embedding  vector(384),
  match_count      INT     DEFAULT 5,
  filter_doc_id    UUID    DEFAULT NULL,
  min_similarity   FLOAT   DEFAULT 0.0
)
RETURNS TABLE (
  id           UUID,
  document_id  UUID,
  content      TEXT,
  content_hash TEXT,
  chunk_index  INT,
  source_page  INT,
  similarity   FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.document_id,
    c.content,
    c.content_hash,
    c.chunk_index,
    c.source_page,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM chunks c
  WHERE
    (filter_doc_id IS NULL OR c.document_id = filter_doc_id)
    AND (1 - (c.embedding <=> query_embedding)) >= min_similarity
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================================
-- 5. get_existing_hashes — returns hashes already stored for a document
--    Used by /api/process to skip re-embedding duplicate chunks
-- ============================================================
CREATE OR REPLACE FUNCTION get_existing_hashes(doc_id UUID)
RETURNS TABLE (content_hash TEXT)
LANGUAGE sql
AS $$
  SELECT content_hash FROM chunks WHERE document_id = doc_id;
$$;
