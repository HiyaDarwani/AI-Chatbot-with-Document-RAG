import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { isMockMode } from './db';

const anthropic = new Anthropic({ 
  apiKey: isMockMode() ? 'mock-key' : (process.env.ANTHROPIC_API_KEY || 'mock-key') 
});

// Timeout for Claude streaming — prevents hanging requests on slow networks
const STREAM_TIMEOUT_MS = 30_000;

// Similarity below which we warn the user their question may not match the document well
const LOW_RELEVANCE_THRESHOLD = 0.50;

// Max previous messages to include (3 user + 3 assistant turns)
const MAX_HISTORY_MESSAGES = 6;

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
 * Prune and sanitize the chat history before sending to Claude.
 * - Removes the auto-generated greeting message
 * - Filters out messages with empty content or invalid roles
 * - Keeps only the last MAX_HISTORY_MESSAGES entries
 * - Ensures alternating user/assistant turns (required by Claude API)
 *
 * @param {Array} history
 * @returns {Array<{role: string, content: string}>}
 */
function prepareHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return [];

  const valid = history
    .filter(m =>
      (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string' &&
      m.content.trim().length > 0 &&
      // Skip the auto-generated greeting injected by the frontend on doc select
      !m.isSystemGenerated
    )
    .map(m => ({ role: m.role, content: m.content.trim() }));

  // Keep only the most recent MAX_HISTORY_MESSAGES messages
  return valid.slice(-MAX_HISTORY_MESSAGES);
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
 * @param {Array}  history — previous chat messages
 */
export async function streamRAGResponse(question, chunks, res, history = []) {
  const context = buildContext(chunks);

  // Warn early if even the best matching chunk is below the relevance threshold
  const maxSimilarity = chunks.length > 0 ? Math.max(...chunks.map(c => c.similarity)) : 0;
  const isLowRelevance = chunks.length > 0 && maxSimilarity < LOW_RELEVANCE_THRESHOLD;

  const systemPrompt = `You are a helpful, knowledgeable AI assistant that specialises in answering questions about uploaded documents.

Your primary goal is to give clear, accurate, and useful answers grounded in the provided document context.

Guidelines:
- If the question is a greeting or small talk (e.g. "hi", "hello", "how are you"), respond with a friendly greeting, introduce yourself as the document assistant, and ask how you can help them with the document.
- Base your answers on the provided context chunks. When the context clearly covers the topic, answer from it and cite the relevant source(s) (e.g., "According to Source 2…").
- If the context only partially covers the question, answer what you can from it and briefly note what additional information is missing.
- If the context does not cover the topic at all, and it is not a greeting, say so honestly: "The document doesn't appear to cover this."
- Use markdown formatting (bullet points, bold, headers) where it improves readability.
- Be concise but thorough — avoid padding or unnecessary repetition.
- When multiple sources are relevant, synthesise them into a coherent answer rather than listing them one by one.
- Maintain a helpful, conversational tone. It's fine to acknowledge follow-up context from prior messages.`;

  const userMessage = `Here are the most relevant sections from the document (${chunks.length} source${chunks.length > 1 ? 's' : ''}):

${context}

---

Question: ${question}

Please answer based on the context above, citing which source number(s) support your answer.`;

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
      const q = question.toLowerCase().trim();
      let answerText = "";

      const queryCount = Array.isArray(history) 
        ? history.filter(m => m.role === 'user').length 
        : 0;

      // ── Intent Classifier ──
      const greetings = ['hi', 'hello', 'hey', 'help', 'greeting', 'greetings'];
      const acknowledgements = ['ok', 'okk', 'okay', 'got it', 'cool', 'sure', 'thanks', 'thank you', 'great', 'nice', 'awesome', 'fine', 'alright'];
      const followUps = ['more', 'yes', 'continue', 'go on', 'explain', 'pls', 'please', 'next', 'further', 'elaborate'];
      const summaryKeywords = ['summar', 'what is it about', 'what is the document', 'overview', 'key points', 'main points', 'what does this document'];
      const listKeywords = ['list', 'all', 'every', 'enumerate', 'what are the'];
      const compareKeywords = ['compare', 'difference', 'vs', 'versus', 'contrast'];
      const defineKeywords = ['define', 'what does', 'what is', 'meaning of', 'explain what'];

      const matchesGreeting   = greetings.includes(q);
      const matchesAck        = acknowledgements.includes(q) || q.startsWith('thank') || (q.startsWith('ok') && q.length <= 5);
      const matchesFollowUp   = followUps.some(w => q.includes(w)) && !matchesAck;
      const matchesSummary    = summaryKeywords.some(p => q.includes(p));
      const matchesList       = listKeywords.some(p => q.includes(p));
      const matchesCompare    = compareKeywords.some(p => q.includes(p));
      const matchesDefine     = defineKeywords.some(p => q.startsWith(p) || q.includes(p));

      // ── Helper: pull clean sentences from a chunk ──
      const extractSentences = (text, count = 4) =>
        text.split(/(?<=[.!?])\s+/)
          .map(s => s.trim())
          .filter(s => s.length > 15)
          .slice(0, count);

      // ── Helper: build a formatted list from chunk sentences ──
      const buildBulletList = (sentences) =>
        sentences.map(s => `• ${s}`).join('\n\n');

      if (matchesGreeting) {
        answerText = `Hello! I'm ready to help you explore this document. You can ask me to summarise it, look up specific topics, explain concepts, or compare sections. What would you like to know?`;

      } else if (matchesAck) {
        const responses = [
          "Got it! Feel free to ask anything else about this document.",
          "Sure thing! Let me know what else you'd like to explore.",
          "Happy to help further — what's your next question?",
          "No problem! What else would you like to know from this document?"
        ];
        answerText = responses[queryCount % responses.length];

      } else if (matchesSummary) {
        const allSentences = chunks.flatMap(c => extractSentences(c.content, 3));
        const sliced = allSentences.slice(0, 5);
        answerText = `Here's an overview based on the document's key sections:\n\n${buildBulletList(sliced)}\n\nWould you like me to dive deeper into any of these points?`;

      } else if (matchesList) {
        const allSentences = chunks.flatMap(c => extractSentences(c.content, 3));
        answerText = `Based on the document, here are the relevant items I found:\n\n${buildBulletList(allSentences.slice(0, 6))}\n\nLet me know if you'd like more detail on any of these.`;

      } else if (matchesCompare) {
        const [c1, c2] = chunks;
        const s1 = extractSentences(c1?.content || '', 2);
        const s2 = extractSentences(c2?.content || '', 2);
        answerText = `Here's what the document covers from two different sections:\n\n**Source 1:**\n${s1.join(' ')}\n\n**Source 2:**\n${s2.join(' ')}\n\nThese sections highlight different aspects of the topic. Let me know if you'd like me to elaborate.`;

      } else if (matchesDefine) {
        // Find the chunk most likely to contain a definition
        const stopWords = new Set(['define', 'what', 'does', 'mean', 'is', 'the', 'a', 'an', 'of', 'explain']);
        const terms = q.split(/\s+/).filter(w => !stopWords.has(w) && w.length > 2);
        let bestChunk = chunks[0];
        let bestScore = 0;
        for (const chunk of chunks) {
          const lower = chunk.content.toLowerCase();
          const score = terms.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0);
          if (score > bestScore) { bestScore = score; bestChunk = chunk; }
        }
        const sentences = extractSentences(bestChunk.content, 3);
        const sourceNum = chunks.indexOf(bestChunk) + 1;
        answerText = `According to **Source ${sourceNum}** in the document:\n\n${sentences.join(' ')}\n\nLet me know if you'd like more context around this.`;

      } else if (matchesFollowUp) {
        const nextIdx = (queryCount + 1) % chunks.length;
        const nextChunk = chunks[nextIdx] || chunks[0];
        const sentences = extractSentences(nextChunk.content, 3);
        const sourceNum = nextIdx + 1;
        answerText = `Here's more from **Source ${sourceNum}** in the document:\n\n${sentences.join(' ')}`;

      } else {
        // ── Keyword search fallback ──
        const stopWords = new Set([
          'should', 'hire', 'someone', 'with', 'this', 'resume', 'document', 'pdf', 'project',
          'file', 'what', 'about', 'tell', 'give', 'show', 'here', 'find', 'does', 'have',
          'please', 'extract', 'explain', 'good', 'info', 'text', 'section', 'part', 'page'
        ]);
        const terms = q.split(/\s+/)
          .map(w => w.replace(/[^a-z0-9]/g, ''))
          .filter(w => w.length > 2 && !stopWords.has(w));

        const previousAnswers = Array.isArray(history)
          ? history.filter(m => m.role === 'assistant').map(m => m.content.toLowerCase())
          : [];

        // Find best-matching chunk by keyword overlap
        let bestChunk = chunks[queryCount % chunks.length];
        if (terms.length > 0) {
          let bestMatchCount = 0;
          for (const chunk of chunks) {
            const lower = chunk.content.toLowerCase();
            const matches = terms.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0);
            if (matches > bestMatchCount) {
              bestMatchCount = matches;
              bestChunk = chunk;
            }
          }
        }

        // Find a non-duplicate answer
        let finalAnswer = "";
        const startIdx = chunks.indexOf(bestChunk);

        outerLoop:
        for (let attempt = 0; attempt < chunks.length; attempt++) {
          const candidateChunk = chunks[(startIdx + attempt) % chunks.length];
          if (!candidateChunk) continue;

          const sentences = extractSentences(candidateChunk.content, 5);
          if (sentences.length === 0) continue;

          const offset = (queryCount + attempt) % Math.max(1, sentences.length - 2);
          const sliced = sentences.slice(offset, offset + 3).length >= 2
            ? sentences.slice(offset, offset + 3)
            : sentences.slice(0, 3);

          const sourceNum = (startIdx + attempt) % chunks.length + 1;
          const intros = [
            `According to the document (**Source ${sourceNum}**), `,
            `The document (**Source ${sourceNum}**) states that `,
            `Based on **Source ${sourceNum}**, `,
            `From **Source ${sourceNum}** in the document, `
          ];
          const intro = intros[(queryCount + attempt) % intros.length];
          const body = sliced.join(' ');
          const candidate = `${intro}${body.charAt(0).toLowerCase() + body.slice(1)}`;

          const isDuplicate = previousAnswers.some(prev =>
            prev.includes(sliced[0]?.toLowerCase().slice(0, 40) || '')
          );

          if (!isDuplicate) {
            finalAnswer = candidate;
            break outerLoop;
          }
        }

        answerText = finalAnswer || "I couldn't find a relevant match in the document for that question. Try rephrasing or asking about a different topic.";
      }

      // Stream the answer word-by-word to simulate real streaming
      const words = answerText.split(" ");
      for (const word of words) {
        sendEvent({ type: 'token', text: word + " " });
        await new Promise(resolve => setTimeout(resolve, 20));
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

  // ── Real Gemini/Claude/Groq streaming ──

  // AbortController for the stream timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);

  if (process.env.GROQ_API_KEY) {
    try {
      const historyMessages = prepareHistory(history);
      const messages = [
        { role: 'system', content: systemPrompt },
        ...historyMessages.map(m => ({
          role: m.role,
          content: m.content
        })),
        { role: 'user', content: userMessage }
      ];

      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages,
          stream: true,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Groq API error: ${response.status} ${response.statusText} - ${body}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const cleanLine = line.trim();
          if (!cleanLine || cleanLine === 'data: [DONE]') continue;
          if (cleanLine.startsWith('data: ')) {
            try {
              const json = JSON.parse(cleanLine.slice(6));
              const text = json.choices[0]?.delta?.content || '';
              if (text) {
                sendEvent({ type: 'token', text });
              }
            } catch (e) {
              // ignore
            }
          }
        }
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
      const message = err.name === 'AbortError'
        ? 'Response timed out after 30 seconds. Please try again.'
        : err.message;
      console.error('[claudeRAG] Groq streaming error:', err);
      sendEvent({ type: 'error', message });
    } finally {
      clearTimeout(timeout);
      if (!res.writableEnded) res.end();
    }
    return;
  }

  if (process.env.GEMINI_API_KEY) {
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

      const historyMessages = prepareHistory(history);
      const contents = historyMessages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));
      contents.push({
        role: 'user',
        parts: [{ text: userMessage }]
      });

      const result = await model.generateContentStream({
        contents,
        systemInstruction: systemPrompt,
      }, { signal: controller.signal });

      for await (const chunk of result.stream) {
        const text = chunk.text();
        sendEvent({ type: 'token', text });
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
      const message = err.name === 'AbortError'
        ? 'Response timed out after 30 seconds. Please try again.'
        : err.message;
      console.error('[claudeRAG] Gemini streaming error:', err);
      sendEvent({ type: 'error', message });
    } finally {
      clearTimeout(timeout);
      if (!res.writableEnded) res.end();
    }
    return;
  }

  try {
    // Build message payload: pruned history + current question
    const historyMessages = prepareHistory(history);
    const messagesPayload = [...historyMessages, { role: 'user', content: userMessage }];

    const stream = anthropic.messages.stream(
      {
        model: 'claude-sonnet-4-5',
        max_tokens: 2048,
        system: systemPrompt,
        messages: messagesPayload,
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
      ? 'Response timed out after 30 seconds. Please try again.'
      : err.message;
    console.error('[claudeRAG] Streaming error:', err);
    sendEvent({ type: 'error', message });
  } finally {
    clearTimeout(timeout);
    if (!res.writableEnded) res.end();
  }
}
