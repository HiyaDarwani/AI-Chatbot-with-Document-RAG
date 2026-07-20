/**
 * One-time migration script: updates the Supabase schema from
 * vector(1536) → vector(384) for Jina AI embeddings.
 *
 * Run with: node scripts/migrate-to-384.js
 * Delete this file after running successfully.
 */

import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const { Client } = pg;

// Derive direct DB connection from Supabase project URL
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!supabaseUrl || supabaseUrl.includes('<')) {
  console.error('❌  NEXT_PUBLIC_SUPABASE_URL not set in .env.local');
  process.exit(1);
}

// Extract project ref: https://[ref].supabase.co
const projectRef = supabaseUrl.replace('https://', '').split('.')[0];
const DB_PASSWORD = process.argv[2];

if (!DB_PASSWORD) {
  console.error(`
❌  Database password required.

Usage:
  node scripts/migrate-to-384.js <your-db-password>

Where to find your DB password:
  Supabase Dashboard → Settings → Database → Database Password
  (or reset it there if you've forgotten it)
`);
  process.exit(1);
}

const client = new Client({
  host:     `db.${projectRef}.supabase.co`,
  port:     5432,
  database: 'postgres',
  user:     'postgres',
  password: DB_PASSWORD,
  ssl:      { rejectUnauthorized: false },
});

const SQL = `
-- Drop old HNSW index (required before changing column type)
DROP INDEX IF EXISTS chunks_embedding_idx;

-- Change embedding column from 1536 (OpenAI) to 384 (Jina AI)
ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(384)
  USING embedding::text::vector(384);

-- Recreate HNSW index with new dimension
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
  ON chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Update match_chunks function to accept 384-dim vectors
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
`;

async function main() {
  console.log(`🔗  Connecting to db.${projectRef}.supabase.co...`);
  try {
    await client.connect();
    console.log('✅  Connected.\n🚀  Running migration...\n');
    await client.query(SQL);
    console.log('✅  Migration complete! Schema updated to vector(384).');
    console.log('    You can now delete scripts/migrate-to-384.js');
  } catch (err) {
    console.error('❌  Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
