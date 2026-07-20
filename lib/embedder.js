import { createHash } from 'crypto';
import { isMockMode } from './db';

// Jina AI Embeddings API — 1M free tokens, no credit card required
// Sign up at: jina.ai to get your free token
// Model: jina-embeddings-v3 with 384-dim output (matches our Supabase schema)
const JINA_API_URL = 'https://api.jina.ai/v1/embeddings';
const JINA_MODEL   = 'jina-embeddings-v3';
const DIMENSIONS   = 384;

const MAX_CHUNKS   = 200;
const BATCH_SIZE   = 10;   // Jina supports batching
const BATCH_DELAY  = 500;  // ms between batches

// ── Typed error ──────────────────────────────────────────────────────────────
export class EmbeddingError extends Error {
  constructor(message, { retryable = false, cause } = {}) {
    super(message);
    this.name = 'EmbeddingError';
    this.retryable = retryable;
    this.cause = cause;
  }
}

/**
 * Compute SHA-256 hex hash — used to skip re-embedding duplicate chunks.
 */
export function hashContent(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Call Jina AI embeddings API with an array of texts.
 * Returns an array of 384-dim float arrays.
 *
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
async function callJinaAPI(texts) {
  const token = process.env.JINA_API_TOKEN;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  let res;
  try {
    res = await fetch(JINA_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: JINA_MODEL,
        dimensions: DIMENSIONS,
        task: 'retrieval.passage',   // optimized for RAG document chunks
        input: texts.map(t => t.replace(/\n/g, ' ').slice(0, 8000)),
      }),
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }

  const data = await res.json();
  // Jina returns: { data: [{ embedding: number[] }, ...] }
  return data.data.map(item => item.embedding);
}

/**
 * Embed a single query string (used at chat time).
 * @returns {Promise<number[]>} 384-dim vector
 */
export async function embedText(text) {
  if (!text || text.trim().length === 0) {
    throw new EmbeddingError('Cannot embed empty text');
  }

  if (isMockMode()) {
    return Array.from({ length: DIMENSIONS }, (_, i) => Math.sin(i + text.length));
  }

  try {
    const token = process.env.JINA_API_TOKEN;
    const res = await fetch(JINA_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: JINA_MODEL,
        dimensions: DIMENSIONS,
        task: 'retrieval.query',   // optimized for query embedding
        input: [text.replace(/\n/g, ' ').slice(0, 8000)],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status} ${res.statusText}: ${body}`);
    }

    const data = await res.json();
    return data.data[0].embedding;
  } catch (err) {
    throw new EmbeddingError(
      `Jina embedding request failed: ${err.message}`,
      { retryable: err.message.includes('429') || err.message.startsWith('5'), cause: err }
    );
  }
}

/**
 * Batch-embed document chunks using Jina AI.
 * Jina supports true batching — sends multiple texts in one API call.
 *
 * @param {string[]} texts
 * @returns {Promise<{ embeddings: number[][], truncated: boolean }>}
 */
export async function embedBatch(texts) {
  let truncated = false;
  let input = texts;

  if (texts.length > MAX_CHUNKS) {
    console.warn(`[embedder] Truncating ${texts.length} chunks to ${MAX_CHUNKS}`);
    input = texts.slice(0, MAX_CHUNKS);
    truncated = true;
  }

  if (isMockMode()) {
    return {
      embeddings: input.map((t, idx) =>
        Array.from({ length: DIMENSIONS }, (_, i) => Math.sin(i + t.length + idx))
      ),
      truncated,
    };
  }

  const allEmbeddings = [];

  for (let i = 0; i < input.length; i += BATCH_SIZE) {
    const batch = input.slice(i, i + BATCH_SIZE);

    try {
      const embeddings = await callJinaAPI(batch);
      allEmbeddings.push(...embeddings);
    } catch (err) {
      throw new EmbeddingError(
        `Jina embedding failed at offset ${i}: ${err.message}`,
        { retryable: err.message.includes('429') || err.message.startsWith('5'), cause: err }
      );
    }

    if (i + BATCH_SIZE < input.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  return { embeddings: allEmbeddings, truncated };
}
