import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

let supabaseInstance = null;

export function isMockMode() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const dbKey = process.env.SUPABASE_SERVICE_KEY;
  const oaiKey = process.env.OPENAI_API_KEY;
  const antKey = process.env.ANTHROPIC_API_KEY;

  const isMissing = !url || !dbKey || !oaiKey || !antKey;
  const isPlaceholder = (url && (url.includes('your_') || url.includes('<'))) ||
                        (dbKey && (dbKey.includes('your_') || dbKey.includes('<'))) ||
                        (oaiKey && (oaiKey.includes('your_') || oaiKey.includes('<'))) ||
                        (antKey && (antKey.includes('your_') || antKey.includes('<')));

  return !!(isMissing || isPlaceholder);
}

const DB_FILE = path.join(process.cwd(), 'lib', 'mock_db.json');

function readDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Error reading mock db file:', e);
  }
  return { documents: [], chunks: [] };
}

function writeDb(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('Error writing mock db file:', e);
  }
}

class MockSupabaseClient {
  constructor() {
    // Initial load
    const db = readDb();
    if (!global._mock_db) {
      global._mock_db = db;
    }
  }

  from(table) {
    const db = global._mock_db;
    if (!db[table]) {
      db[table] = [];
    }

    const builder = {
      insert: (payload) => {
        const rows = Array.isArray(payload) ? payload : [payload];
        const newRows = rows.map(r => {
          const newRow = {
            id: r.id || randomUUID(),
            created_at: new Date().toISOString(),
            chunk_count: r.chunk_count || 0,
            truncated: r.truncated || false,
            ...r
          };
          db[table].push(newRow);
          return newRow;
        });

        writeDb(db);

        const selectBuilder = {
          select: (fields) => {
            const singleBuilder = {
              single: async () => {
                return { data: newRows[0], error: null };
              },
              then: (resolve) => resolve({ data: newRows, error: null })
            };
            return singleBuilder;
          },
          then: (resolve) => resolve({ data: newRows, error: null }),
          catch: (reject) => reject(null)
        };
        return selectBuilder;
      },

      select: (fields) => {
        let filtered = [...db[table]];

        const filterBuilder = {
          eq: (field, value) => {
            filtered = filtered.filter(row => row[field] === value);
            return filterBuilder;
          },
          order: (field, { ascending } = {}) => {
            filtered.sort((a, b) => {
              const valA = new Date(a[field] || 0);
              const valB = new Date(b[field] || 0);
              if (valA < valB) return ascending ? -1 : 1;
              if (valA > valB) return ascending ? 1 : -1;
              return 0;
            });
            return filterBuilder;
          },
          single: async () => {
            if (filtered.length === 0) {
              return { data: null, error: { message: 'Row not found' } };
            }
            return { data: filtered[0], error: null };
          },
          then: (resolve) => {
            resolve({ data: filtered, error: null });
          }
        };
        return filterBuilder;
      },

      update: (payload) => {
        const updateBuilder = {
          eq: async (field, value) => {
            const targets = [];
            db[table].forEach(row => {
              if (row[field] === value) {
                Object.assign(row, payload);
                targets.push(row);
              }
            });
            writeDb(db);
            return { data: targets, error: null };
          },
          then: (resolve) => resolve({ data: [], error: null })
        };
        return updateBuilder;
      },

      delete: () => {
        const deleteBuilder = {
          eq: async (field, value) => {
            const toDelete = db[table].filter(row => row[field] === value);
            db[table] = db[table].filter(row => row[field] !== value);

            if (table === 'documents') {
              toDelete.forEach(doc => {
                db.chunks = db.chunks.filter(c => c.document_id !== doc.id);
              });
            }
            writeDb(db);
            return { error: null };
          },
          then: (resolve) => resolve({ error: null })
        };
        return deleteBuilder;
      }
    };

    return builder;
  }

  async rpc(fn, args) {
    const db = global._mock_db;
    if (!db.chunks) db.chunks = [];

    if (fn === 'get_existing_hashes') {
      const hashes = db.chunks
        .filter(c => c.document_id === args.doc_id)
        .map(c => ({ content_hash: c.content_hash }));
      return { data: hashes, error: null };
    }

    if (fn === 'match_chunks') {
      const { filter_doc_id } = args;
      const matched = db.chunks.filter(c => !filter_doc_id || c.document_id === filter_doc_id);

      const results = matched.map((c, i) => ({
        id: c.id,
        document_id: c.document_id,
        content: c.content,
        content_hash: c.content_hash,
        chunk_index: c.chunk_index,
        source_page: c.source_page || (i + 1),
        similarity: 0.4 + (Math.sin(i) * 0.3) + 0.2
      }))
      .filter(r => r.similarity >= (args.min_similarity || 0.35))
      .slice(0, args.match_count || 5);

      return { data: results, error: null };
    }

    return { data: [], error: null };
  }
}

/**
 * Returns a lazily initialized Supabase client.
 * Catches configuration errors inside route execution rather than crashing module imports.
 *
 * @returns {object} SupabaseClient
 */
export default function getSupabase() {
  if (supabaseInstance) return supabaseInstance;

  if (isMockMode()) {
    console.log('[db] Running in MOCK mode — local database simulation active');
    supabaseInstance = new MockSupabaseClient();
    return supabaseInstance;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || url.includes('your_') || url.includes('<')) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is not configured with a valid URL in .env.local');
  }
  if (!key || key.includes('your_') || key.includes('<')) {
    throw new Error('SUPABASE_SERVICE_KEY is not configured with a valid key in .env.local');
  }

  try {
    supabaseInstance = createClient(url, key, {
      auth: { persistSession: false },
    });
    return supabaseInstance;
  } catch (err) {
    throw new Error(`Supabase initialization failed: ${err.message}`);
  }
}
