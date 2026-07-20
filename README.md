# DocRAG — AI Document Chatbot with Document Intelligence

DocRAG is a lightweight, secure, and production-ready Document RAG (Retrieval-Augmented Generation) Chatbot built with Next.js and Tailwind CSS. It allows users to upload PDF documents, automatically chunks and indexes their text, and enables real-time interactive chat with Claude AI using precise context injection and source citation matching.

---

## ⚡ Key Features

* **PDF Upload & Processing:** Multi-stage processing (`Uploading...` $\rightarrow$ `Processing chunks...` $\rightarrow$ `Ready!`) with token-saving cost-cap limits (up to 200 chunks per document).
* **True Document Isolation:** All vector searches are isolated strictly to the selected document ID, preventing cross-document answers and reducing AI hallucinations.
* **Stream-Based RAG Chat:** Real-time token streaming using Server-Sent Events (SSE) featuring low-relevance warnings when question search overlaps fall below 35%.
* **Source Citation Panel:** Interactive citations dropdown showing chunk indices, estimated document pages, relevance match percentages, and precise text snippets.
* **Inline Document Management:** Standard sidebar listing user-uploaded documents with an inline confirm-to-delete prompt that removes embeddings and files cleanly.
* **Zero-Setup Mock Fallback Mode:** If database credentials or API keys are missing in `.env.local`, the application automatically runs in a local mock simulation mode (persisting rows to `lib/mock_db.json` and simulating embeddings & chat stream responses) so developers can demo the UI out-of-the-box.

---

## 🛠️ Technology Stack

* **Frontend Framework:** Next.js (Pages Router)
* **Styling:** Tailwind CSS & PostCSS
* **Vector Database:** Supabase (Postgres with `pgvector` extension)
* **Embeddings Model:** Jina AI `jina-embeddings-v3` (384 dimensions)
* **LLM Engines:** Anthropic Claude (`claude-sonnet-4-5`), Google Gemini (`gemini-1.5-flash`), and Groq (`llama-3.3-70b-versatile`)
* **Utilities:** `multer` (file processing), `pdf-parse` (PDF extraction)

---

## ⚙️ Configuration & Setup

### 1. Prerequisites
Ensure you have Node.js (v18+) and Git installed.

### 2. Install Dependencies
```bash
npm install
```

### 3. Environment Variables
Create a `.env.local` file in the root directory and add your credentials:
```env
# Supabase Database credentials
NEXT_PUBLIC_SUPABASE_URL=https://<your-project-id>.supabase.co
SUPABASE_SERVICE_KEY=<your-service-role-key>

# Embeddings API
JINA_API_TOKEN=<your-jina-api-token>

# LLM APIs
ANTHROPIC_API_KEY=<your-anthropic-api-key>
GEMINI_API_KEY=<your-gemini-api-key>
GROQ_API_KEY=<your-groq-api-key>
```
*Note: If these variables contain `<` or are left as placeholders, the application will default to **Mock mode** allowing local testing without API connections.*

### 4. Database Setup (Supabase SQL)
Run the queries in [sql/enable-pgvector.sql](file:///d:/finlaticswebdev_project3-main/sql/enable-pgvector.sql) in your Supabase SQL editor to create:
1. `vector` extension enablement.
2. `documents` metadata table.
3. `chunks` embeddings table with HNSW indexing.
4. `match_chunks` and `get_existing_hashes` Postgres RPC search functions.

---

## 🚀 Running the App

### Development Server
Start the local server with hot reloading:
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### Production Build
Build and optimize the application for Vercel/production deployment:
```bash
npm run build
npm start
```
