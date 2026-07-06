import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

/**
 * Split raw PDF text into overlapping chunks.
 *
 * Strategy:
 *  - chunkSize: 500 tokens (~2000 chars, good balance of context vs cost)
 *  - chunkOverlap: 50 tokens — prevents answers being split across boundaries
 *  - separators: paragraph → sentence → word — sentence-aware splitting
 *
 * @param {string} text - Raw extracted text from PDF
 * @returns {Promise<Array<{content: string, chunkIndex: number}>>}
 */
export async function chunkText(text) {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 2000,          // ~500 tokens (4 chars ≈ 1 token)
    chunkOverlap: 200,        // ~50 tokens of overlap
    separators: [
      '\n\n',                 // paragraphs first
      '\n',                   // newlines
      '. ',                   // sentences
      ', ',                   // clauses
      ' ',                    // words
      '',                     // characters (last resort)
    ],
  });

  const docs = await splitter.createDocuments([text]);

  return docs.map((doc, index) => ({
    content: doc.pageContent.trim(),
    chunkIndex: index,
  })).filter(chunk => chunk.content.length > 50); // drop tiny noise chunks
}
