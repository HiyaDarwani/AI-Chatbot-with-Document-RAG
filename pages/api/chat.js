import { embedText, EmbeddingError } from '../../lib/embedder';
import { vectorSearch } from '../../lib/vectorSearch';
import { streamRAGResponse } from '../../lib/claudeRAG';
import getSupabase from '../../lib/db';

export const config = { api: { bodyParser: true } };

const MAX_QUESTION_LENGTH = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { question, documentId, sessionToken, history } = req.body;

  // ── 1. Input validation ──
  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({ error: 'A non-empty question is required' });
  }
  if (question.trim().length > MAX_QUESTION_LENGTH) {
    return res.status(400).json({
      error: `Question too long (max ${MAX_QUESTION_LENGTH} characters)`,
    });
  }
  if (!documentId || !UUID_RE.test(documentId)) {
    return res.status(400).json({ error: 'Invalid or missing documentId' });
  }
  if (!sessionToken) {
    return res.status(401).json({ error: 'sessionToken is required' });
  }

  try {
    const supabase = getSupabase();

    // ── 2. Ownership check ──
    const { data: doc, error: docError } = await supabase
      .from('documents')
      .select('id, session_token, chunk_count')
      .eq('id', documentId)
      .single();

    if (docError || !doc) {
      return res.status(404).json({ error: 'Document not found' });
    }
    if (doc.session_token !== sessionToken) {
      return res.status(403).json({ error: 'Access denied: invalid session token' });
    }
    if (!doc.chunk_count || doc.chunk_count === 0) {
      return res.status(422).json({
        error: 'This document has not been processed yet. Please process it first.',
      });
    }

    // ── 3. Embed the user's question ──
    let queryEmbedding;
    try {
      queryEmbedding = await embedText(question.trim());
    } catch (err) {
      if (err instanceof EmbeddingError) {
        return res.status(err.retryable ? 503 : 422).json({ error: err.message });
      }
      throw err;
    }

    const qLower = question.toLowerCase().trim();
    const isGreeting = ['hi', 'hello', 'hey', 'greetings', 'help', 'yo', 'good morning', 'good afternoon'].includes(
      qLower.replace(/[^a-z\s]/g, '')
    );

    const summaryKeywords = [
      'summar', 'overview', 'about', 'explain', 'what is this', 'what does this', 
      'key point', 'main point', 'highlight', 'in the doc', 'in this doc', 'in the document',
      'table of content', 'describe', 'what is in', 'what is inside', 'tell me about'
    ];
    const isGeneralQuery = isGreeting || summaryKeywords.some(keyword => qLower.includes(keyword)) || qLower.length < 15;

    // ── 4. Cosine similarity search (min 0.20 similarity floor for specific queries, 0.0 for general queries) ──
    const chunks = await vectorSearch(queryEmbedding, {
      documentId,
      matchCount: 8,
      minSimilarity: isGeneralQuery ? 0.0 : 0.50,
    });

    if (chunks.length === 0) {
      // No relevant chunks — send SSE error rather than plain JSON so the chat UI handles it
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.write(
        `data: ${JSON.stringify({
          type: 'error',
          message:
            'No relevant sections found in this document for your question. ' +
            'Try rephrasing or asking about topics covered in the document.',
        })}\n\n`
      );
      return res.end();
    }

    // ── 5. Context window token/character budget guard (max 8000 characters) ──
    const MAX_CONTEXT_CHARS = 8000;
    let accumulatedLength = 0;
    const prunedChunks = [];
    for (const chunk of chunks) {
      if (prunedChunks.length > 0 && accumulatedLength + chunk.content.length > MAX_CONTEXT_CHARS) {
        console.log(`[chat] Pruning remaining chunks to respect context token budget (accumulated: ${accumulatedLength} chars)`);
        break;
      }
      prunedChunks.push(chunk);
      accumulatedLength += chunk.content.length;
    }

    // ── 6. Stream Claude answer with source citations ──
    await streamRAGResponse(question.trim(), prunedChunks, res, history);
  } catch (err) {
    console.error('[/api/chat] Unexpected error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Chat request failed. Please try again.' });
    }
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      res.end();
    }
  }
}
