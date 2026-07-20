import React, { useState, useEffect, useRef, useCallback } from 'react';
import Head from 'next/head';
import PdfUploader from '../components/PdfUploader';
import DocumentCard from '../components/DocumentCard';
import ChatMessage from '../components/ChatMessage';
import ChunkSourceList from '../components/ChunkSourceList';

const SESSION_KEY = 'docrag_session';

const getSessionToken = () =>
  typeof window !== 'undefined' ? localStorage.getItem(SESSION_KEY) : null;

export default function HomeDashboard() {
  const [documents, setDocuments] = useState([]);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [selectedDocId, setSelectedDocId] = useState(null);
  const [selectedDoc, setSelectedDoc] = useState(null);

  // Chat state
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [chatError, setChatError] = useState('');
  const [lowRelevance, setLowRelevance] = useState(false);

  const messagesEndRef = useRef(null);
  const chatInputRef = useRef(null);

  // Fetch documents on mount
  useEffect(() => {
    fetchDocuments();
  }, []);

  const safeParseJson = async (response) => {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Server error (${response.status}). Verify your .env.local API keys are configured.`);
    }
  };

  // Fetch documents matching session token
  const fetchDocuments = async () => {
    const token = getSessionToken();
    if (!token) {
      setDocuments([]);
      setLoadingDocs(false);
      return;
    }
    setLoadingDocs(true);
    try {
      const res = await fetch(`/api/documents?sessionToken=${token}`);
      if (res.ok) {
        const data = await safeParseJson(res);
        setDocuments(data.documents || []);
      }
    } catch (err) {
      console.error('Failed to fetch documents', err);
    } finally {
      setLoadingDocs(false);
    }
  };

  // Sync selected document object when selectedDocId or documents change
  useEffect(() => {
    if (selectedDocId) {
      const found = documents.find(d => d.id === selectedDocId);
      setSelectedDoc(found || null);
    } else {
      setSelectedDoc(null);
    }
  }, [selectedDocId, documents]);

  // Set chat greeting when selected doc changes
  useEffect(() => {
    if (selectedDoc) {
      setMessages([
        {
          role: 'assistant',
          content: `Hi! I have read **${selectedDoc.title}** and I'm ready to answer your questions about it. Ask me anything!`,
          sources: null,
        },
      ]);
      setChatError('');
      setLowRelevance(false);
    } else {
      setMessages([]);
    }
  }, [selectedDoc]);

  // Auto-scroll chat area
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleUploadSuccess = (docData) => {
    // Append doc to list
    const newDoc = {
      id: docData.documentId,
      title: docData.title,
      page_count: docData.pageCount,
      chunk_count: docData.chunksCreated,
      created_at: new Date().toISOString(),
    };
    setDocuments(prev => [newDoc, ...prev]);
    // Auto-select newly processed doc
    setSelectedDocId(docData.documentId);
  };

  const handleDeleteDocument = async (docId) => {
    const token = getSessionToken();
    if (!token) return;

    try {
      const res = await fetch('/api/documents', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: docId, sessionToken: token }),
      });

      if (res.ok) {
        setDocuments(prev => prev.filter(doc => doc.id !== docId));
        if (selectedDocId === docId) {
          setSelectedDocId(null);
        }
      } else {
        const errData = await safeParseJson(res);
        throw new Error(errData.error || 'Failed to delete');
      }
    } catch (err) {
      alert(`Error deleting document: ${err.message}`);
      throw err;
    }
  };

  const handleSendMessage = async (e) => {
    e?.preventDefault();
    const question = input.trim();
    if (!question || isStreaming || !selectedDocId) return;

    setInput('');
    setChatError('');
    setLowRelevance(false);

    // Add user question
    setMessages(prev => [...prev, { role: 'user', content: question, sources: null }]);
    // Add empty assistant response bubble
    setMessages(prev => [...prev, { role: 'assistant', content: '', sources: null, streaming: true }]);
    setIsStreaming(true);

    try {
      const sessionToken = getSessionToken();
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          documentId: selectedDocId,
          sessionToken,
          history: messages, // Send previous chat history (excluding the current typing exchange)
        }),
      });

      if (!response.ok) {
        const errData = await safeParseJson(response);
        throw new Error(errData.error || 'Chat request failed');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          let evt;
          try { evt = JSON.parse(jsonStr); } catch { continue; }

          if (evt.type === 'token') {
            setMessages(prev => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last && last.role === 'assistant') {
                updated[updated.length - 1] = {
                  ...last,
                  content: last.content + evt.text,
                };
              }
              return updated;
            });
          } else if (evt.type === 'low_relevance') {
            setLowRelevance(true);
          } else if (evt.type === 'sources') {
            setMessages(prev => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last && last.role === 'assistant') {
                updated[updated.length - 1] = {
                  ...last,
                  sources: evt.sources,
                  streaming: false,
                };
              }
              return updated;
            });
          } else if (evt.type === 'error') {
            setChatError(evt.message);
          } else if (evt.type === 'done') {
            setMessages(prev => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last && last.role === 'assistant') {
                updated[updated.length - 1] = {
                  ...last,
                  streaming: false,
                };
              }
              return updated;
            });
          }
        }
      }
    } catch (err) {
      setChatError(err.message);
      setMessages(prev => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last && last.role === 'assistant' && !last.content) {
          updated.pop(); // remove empty bubble if we failed immediately
        }
        return updated;
      });
    } finally {
      setIsStreaming(false);
      setTimeout(() => chatInputRef.current?.focus(), 50);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <>
      <Head>
        <title>DocRAG — AI Document Chatbot</title>
      </Head>

      <div className="min-h-screen bg-gray-50 flex flex-col">
        {/* Navigation Bar */}
        <header className="bg-white border-b border-gray-200 py-4 px-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">⚡</span>
            <h1 className="text-lg font-bold text-gray-900">DocRAG</h1>
          </div>
          <p className="text-xs text-gray-500">Document Intelligence Dashboard</p>
        </header>

        {/* Main Content Layout */}
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden max-w-7xl w-full mx-auto p-4 gap-4">
          
          {/* LEFT SIDEBAR: Upload & Document Management */}
          <aside className="w-full md:w-80 flex flex-col gap-4 flex-shrink-0">
            {/* Upload Box */}
            <div className="flex flex-col gap-2">
              <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider">
                Upload Document
              </h2>
              <PdfUploader
                onSuccess={handleUploadSuccess}
                onError={(err) => console.error(err)}
              />
            </div>

            {/* Document Management List */}
            <div className="flex-1 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider">
                  Indexed Documents ({documents.length})
                </h2>
                {documents.length > 0 && (
                  <button
                    onClick={fetchDocuments}
                    className="text-xs text-blue-600 hover:text-blue-700 font-semibold"
                  >
                    Refresh
                  </button>
                )}
              </div>

              <div className="flex-1 overflow-y-auto space-y-3 bg-white p-4 border border-gray-200 rounded-lg max-h-[350px] md:max-h-none">
                {loadingDocs ? (
                  <div className="flex items-center gap-2 text-sm text-gray-500 py-4 justify-center">
                    <div className="spinner" />
                    <span>Loading documents...</span>
                  </div>
                ) : documents.length === 0 ? (
                  <div className="text-center py-8 text-gray-400 text-sm">
                    No documents uploaded yet. Choose a PDF above.
                  </div>
                ) : (
                  documents.map(doc => (
                    <DocumentCard
                      key={doc.id}
                      id={doc.id}
                      title={doc.title}
                      pageCount={doc.page_count}
                      chunkCount={doc.chunk_count}
                      createdAt={doc.created_at}
                      onDelete={handleDeleteDocument}
                      onSelect={setSelectedDocId}
                      isSelected={selectedDocId === doc.id}
                    />
                  ))
                )}
              </div>
            </div>
          </aside>

          {/* RIGHT CONTENT: Chat Interface */}
          <main className="flex-1 bg-white border border-gray-200 rounded-lg flex flex-col overflow-hidden min-h-[400px] md:min-h-0">
            {selectedDoc ? (
              <div className="flex-1 flex flex-col overflow-hidden">
                {/* Chat Header */}
                <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-gray-900 text-sm truncate max-w-md">
                      Chatting: {selectedDoc.title}
                    </h3>
                    <p className="text-xs text-gray-500">
                      {selectedDoc.page_count} pages · {selectedDoc.chunk_count} chunks indexed
                    </p>
                  </div>
                  <button
                    onClick={() => setSelectedDocId(null)}
                    className="text-xs text-gray-500 hover:text-gray-700 font-medium"
                  >
                    Close Chat
                  </button>
                </div>

                {/* Messages Display Area */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  {messages.map((msg, i) => (
                    <div key={i}>
                      <ChatMessage
                        role={msg.role}
                        content={msg.content}
                        isStreaming={msg.streaming}
                      />
                      {msg.role === 'assistant' && msg.sources && (
                        <ChunkSourceList sources={msg.sources} />
                      )}
                    </div>
                  ))}

                  {lowRelevance && !chatError && (
                    <div className="p-3 bg-yellow-50 border border-yellow-200 text-yellow-800 text-xs rounded-md ml-10">
                      ⚠️ <strong>Low relevance:</strong> The retrieved document sections may not contain exact answers. Try rephrasing.
                    </div>
                  )}

                  {chatError && (
                    <div className="p-3 bg-red-50 border border-red-200 text-red-800 text-xs rounded-md ml-10 flex justify-between items-center">
                      <span>⚠️ {chatError}</span>
                      <button onClick={() => setChatError('')} className="font-bold">✕</button>
                    </div>
                  )}

                  <div ref={messagesEndRef} />
                </div>

                {/* Input Bar */}
                <div className="p-4 border-t border-gray-200 bg-gray-50">
                  <form onSubmit={handleSendMessage} className="flex gap-2 items-end">
                    <textarea
                      ref={chatInputRef}
                      placeholder="Ask a question about the document... (Enter to send)"
                      value={input}
                      onChange={e => setInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                      disabled={isStreaming}
                      rows={1}
                      className="flex-1 min-h-[44px] max-h-32 p-3 border border-gray-300 rounded text-sm text-gray-900 focus:outline-none focus:border-blue-500 resize-none"
                      style={{ height: 'auto' }}
                      onInput={e => {
                        e.target.style.height = 'auto';
                        e.target.style.height = e.target.scrollHeight + 'px';
                      }}
                    />
                    <button
                      type="submit"
                      disabled={!input.trim() || isStreaming}
                      className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white font-semibold py-2.5 px-4 rounded text-sm min-h-[44px] flex items-center justify-center transition-colors"
                    >
                      {isStreaming ? <div className="spinner border-white" /> : 'Ask'}
                    </button>
                  </form>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-gray-500">
                <span className="text-5xl mb-4">💬</span>
                <h3 className="font-semibold text-gray-800 mb-1">No document selected</h3>
                <p className="text-sm max-w-sm">
                  Upload a PDF using the left sidebar or select an existing document to begin chatting.
                </p>
              </div>
            )}
          </main>

        </div>
      </div>
    </>
  );
}
