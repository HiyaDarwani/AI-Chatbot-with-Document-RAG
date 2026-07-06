import OpenAI from 'openai';
import { createHash } from 'crypto';
import { isMockMode } from './db';

const openai = new OpenAI({ 
  apiKey: isMockMode() ? 'mock-key' : (process.env.OPENAI_API_KEY || 'mock-key') 
});

const EMBEDDING_MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 100;       // OpenAI allows up to 2048; we stay conservative
const MAX_CHUNKS  = 200;      // Cost guard: ~$0.0004 max per document at 200 chunks

// ── Typed error so callers can distinguish API failures from logic errors ──
export class EmbeddingError extends Error {
  constructor(message, { retryable = false, cause } = {}) {
    super(message);
    this.name = 'EmbeddingError';
    this.retryable = retryable;
    this.cause = cause;
  }
}

/**
 * Compute SHA-256 hex hash of a string.
 * Used to detect duplicate chunks — avoids re-embedding identical text.
 *
 * @param {string} text
 * @returns {string} 64-char hex string
 */
export function hashContent(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Embed a single string — for embedding the user's query at chat time.
 *
 * @param {string} text
 * @returns {Promise<number[]>} 1536-dimensional embedding vector
 */
export async function embedText(text) {
  if (!text || text.trim().length === 0) {
    throw new EmbeddingError('Cannot embed empty text');
  }

  if (isMockMode()) {
    // Return a stable mock 1536-dimensional vector based on the string length and contents
    return Array.from({ length: 1536 }, (_, i) => Math.sin(i + text.length));
  }

  try {
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text.replace(/\n/g, ' ').slice(0, 8000), // token safety cap
    });
    return response.data[0].embedding;
  } catch (err) {
    throw new EmbeddingError(
      `OpenAI embedding request failed: ${err.message}`,
      { retryable: err.status >= 500, cause: err }
    );
  }
}

/**
 * Batch-embed an array of strings for document chunks.
 *
 * Cost control:
 *  - text-embedding-3-small = $0.02 / 1M tokens
 *  - Average chunk ≈ 500 tokens → 200 chunks ≈ 100K tokens ≈ $0.002 per document
 *  - Batches of 100 reduce API round-trips by 2× vs. one-at-a-time
 *
 * @param {string[]} texts — must be <= MAX_CHUNKS entries
 * @returns {Promise<{ embeddings: number[][], truncated: boolean }>}
 */
export async function embedBatch(texts) {
  let truncated = false;
  let input = texts;

  if (texts.length > MAX_CHUNKS) {
    console.warn(
      `[embedder] Chunk count ${texts.length} exceeds MAX_CHUNKS ${MAX_CHUNKS}. ` +
      'Truncating to control embedding cost.'
    );
    input = texts.slice(0, MAX_CHUNKS);
    truncated = true;
  }

  if (isMockMode()) {
    const embeddings = input.map((t, idx) => 
      Array.from({ length: 1536 }, (_, i) => Math.sin(i + t.length + idx))
    );
    return { embeddings, truncated };
  }

  const allEmbeddings = [];

  for (let i = 0; i < input.length; i += BATCH_SIZE) {
    const batch = input
      .slice(i, i + BATCH_SIZE)
      .map(t => t.replace(/\n/g, ' ').slice(0, 8000));

    try {
      const response = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: batch,
      });
      // Sort by index — API guarantees order but we're defensive
      const sorted = response.data.sort((a, b) => a.index - b.index);
      allEmbeddings.push(...sorted.map(item => item.embedding));
    } catch (err) {
      throw new EmbeddingError(
        `OpenAI batch embedding failed at offset ${i}: ${err.message}`,
        { retryable: err.status >= 500, cause: err }
      );
    }
  }

  return { embeddings: allEmbeddings, truncated };
}
