import Anthropic from '@anthropic-ai/sdk';
import { isMockMode } from './db';

const anthropic = new Anthropic({ 
  apiKey: isMockMode() ? 'mock-key' : (process.env.ANTHROPIC_API_KEY || 'mock-key') 
});

// Timeout for Claude streaming — prevents hanging requests on slow networks
const STREAM_TIMEOUT_MS = 25_000;

// Similarity below which we warn the user their question may not match the document well
const LOW_RELEVANCE_THRESHOLD = 0.50;

/**
 * Trim an excerpt to ≤ maxLen characters, breaking cleanly at a sentence boundary.
 * Prevents the citations panel from showing half-sentences.
 *
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function sentenceExcerpt(text, maxLen = 300) {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  // Walk back to the last sentence-ending punctuation
  const lastStop = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('? '),
    truncated.lastIndexOf('! '),
  );
  return lastStop > maxLen * 0.6
    ? truncated.slice(0, lastStop + 1) + ' …'
    : truncated + '…';
}

/**
 * Build a numbered context string from retrieved chunks with source labels.
 *
 * @param {Array<{content: string, chunk_index: number, source_page: number|null, similarity: number}>} chunks
 * @returns {string}
 */
function buildContext(chunks) {
  return chunks
    .map((chunk, i) => {
      const pageLabel = chunk.source_page ? ` | Page ~${chunk.source_page}` : '';
      const pct = (chunk.similarity * 100).toFixed(1);
      return `[Source ${i + 1} | Chunk #${chunk.chunk_index}${pageLabel} | Relevance: ${pct}%]\n${chunk.content}`;
    })
    .join('\n\n---\n\n');
}

/**
 * Stream a RAG-powered answer from Claude given a question and context chunks.
 * Writes Server-Sent Events to a Node.js ServerResponse.
 *
 * SSE event types:
 *   { type: "token",        text: string }           — incremental text token
 *   { type: "low_relevance", maxSimilarity: number } — best match still weak
 *   { type: "sources",      sources: [...] }         — citation metadata at end
 *   { type: "done" }                                 — stream complete
 *   { type: "error",        message: string }        — stream-level error
 *
 * @param {string} question
 * @param {Array}  chunks  — top-k chunks from vectorSearch (already filtered)
 * @param {object} res     — Next.js ServerResponse
 */
export async function streamRAGResponse(question, chunks, res) {
  const context = buildContext(chunks);

  // Warn early if even the best matching chunk is below the relevance threshold
  const maxSimilarity = Math.max(...chunks.map(c => c.similarity));
  const isLowRelevance = maxSimilarity < LOW_RELEVANCE_THRESHOLD;

  const systemPrompt = `You are a precise AI assistant that answers questions based strictly on the provided document context.

RULES:
- Answer ONLY from the provided context chunks. Do not use outside knowledge.
- If the context does not contain enough information to answer, explicitly say "The document does not appear to cover this topic."
- Be concise but thorough. Use markdown formatting where it improves readability.
- Always cite which source number(s) support your answer (e.g., "According to Source 2…").
- If multiple sources are relevant, synthesise them coherently.
- Never fabricate information not present in the context.`;

  const userMessage = `Here are the most relevant sections from the document (${chunks.length} source${chunks.length > 1 ? 's' : ''}):

${context}

---

Question: ${question}

Answer based only on the context above. Cite source numbers.`;

  // ── SSE headers ──
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');   // disable nginx buffering

  const sendEvent = (data) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  // Emit low-relevance warning before the answer so the UI can show a banner
  if (isLowRelevance) {
    sendEvent({ type: 'low_relevance', maxSimilarity });
  }

  if (isMockMode()) {
    try {
      const bestChunk = chunks[0];
      const textContent = bestChunk ? bestChunk.content : "";
      
      // Extract clean sentences from the actual PDF text chunk
      const sentences = textContent
        .split(/(?<=[.!?])\s+/)
        .map(s => s.trim())
        .filter(s => s.length > 12)
        .slice(0, 3);

      let summaryText = "";
      if (sentences.length > 0) {
        summaryText = `Based on the document context (specifically **Source 1**), here is the relevant text retrieved:\n\n` +
          sentences.map((s, idx) => `* ${s}`).join("\n") +
          `\n\nWould you like me to look up any other details from this section?`;
      } else {
        summaryText = "The document section retrieved appears to be empty or contains unreadable text. Please verify the document content.";
      }

      const words = summaryText.split(" ");
      for (const word of words) {
        sendEvent({ type: 'token', text: word + " " });
        await new Promise(resolve => setTimeout(resolve, 25));
      }

      const sources = chunks.map((c, i) => ({
        label:      `Source ${i + 1}`,
        chunkIndex: c.chunk_index,
        sourcePage: c.source_page ?? null,
        similarity: parseFloat((c.similarity * 100).toFixed(1)),
        excerpt:    sentenceExcerpt(c.content, 300),
      }));

      sendEvent({ type: 'sources', sources });
      sendEvent({ type: 'done' });
    } catch (err) {
      console.error('[claudeRAG] Mock streaming error:', err);
      sendEvent({ type: 'error', message: err.message });
    } finally {
      if (!res.writableEnded) res.end();
    }
    return;
  }

  // AbortController for the 25-second stream timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);

  try {
    const stream = anthropic.messages.stream(
      {
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      },
      { signal: controller.signal }
    );

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta?.type === 'text_delta'
      ) {
        sendEvent({ type: 'token', text: event.delta.text });
      }
    }

    // Emit citations with sentence-aware excerpts
    const sources = chunks.map((c, i) => ({
      label:      `Source ${i + 1}`,
      chunkIndex: c.chunk_index,
      sourcePage: c.source_page ?? null,
      similarity: parseFloat((c.similarity * 100).toFixed(1)),
      excerpt:    sentenceExcerpt(c.content, 300),
    }));

    sendEvent({ type: 'sources', sources });
    sendEvent({ type: 'done' });
  } catch (err) {
    const message = err.name === 'AbortError'
      ? 'Response timed out after 25 seconds. Please try again.'
      : err.message;
    console.error('[claudeRAG] Streaming error:', err);
    sendEvent({ type: 'error', message });
  } finally {
    clearTimeout(timeout);
    if (!res.writableEnded) res.end();
  }
}
