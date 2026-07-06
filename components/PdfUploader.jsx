import React, { useState } from 'react';

const SESSION_KEY = 'docrag_session';

export default function PdfUploader({ onSuccess, onError }) {
  const [selectedFile, setSelectedFile] = useState(null);
  const [status, setSelectedStatus] = useState(''); // 'Uploading...', 'Processing chunks...', 'Ready!', or error
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState(null);

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      if (file.type !== 'application/pdf') {
        alert('Please select a valid PDF file.');
        e.target.value = '';
        return;
      }
      if (file.size > 50 * 1024 * 1024) {
        alert('File size exceeds 50 MB limit.');
        e.target.value = '';
        return;
      }
      setSelectedFile(file);
      setSelectedStatus('');
      setSummary(null);
    }
  };

  const handleUpload = async (e) => {
    e.preventDefault();
    if (!selectedFile) {
      alert('Please choose a PDF file first.');
      return;
    }

    setLoading(true);
    setSelectedStatus('Uploading...');
    setSummary(null);

    const safeParseJson = async (response) => {
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Server returned status ${response.status}. Please check that your database and API keys are configured in .env.local.`);
      }
    };

    try {
      // Step 1: Upload & extract text
      const formData = new FormData();
      formData.append('file', selectedFile);

      const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
      const uploadData = await safeParseJson(uploadRes);

      if (!uploadRes.ok) {
        throw new Error(uploadData.error || 'Upload failed');
      }

      if (uploadData.sessionToken) {
        localStorage.setItem(SESSION_KEY, uploadData.sessionToken);
      }

      // Step 2: Chunk & embed
      setSelectedStatus('Processing chunks...');

      const sessionToken = localStorage.getItem(SESSION_KEY);
      const processRes = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: uploadData.documentId,
          sessionToken,
        }),
      });
      const processData = await safeParseJson(processRes);

      if (!processRes.ok) {
        throw new Error(processData.error || 'Processing failed');
      }

      setSelectedStatus('Ready!');
      setSummary({
        chunks: processData.chunksCreated,
        truncated: processData.truncated,
      });

      onSuccess?.({
        documentId: uploadData.documentId,
        title: uploadData.title,
        pageCount: uploadData.pageCount,
        chunksCreated: processData.chunksCreated,
        truncated: processData.truncated,
      });

      // Clear selection
      setSelectedFile(null);
      const inputEl = document.getElementById('pdf-file-field');
      if (inputEl) inputEl.value = '';

    } catch (err) {
      setSelectedStatus(`Error: ${err.message}`);
      onError?.(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white p-5 rounded-lg border border-gray-200">
      <form onSubmit={handleUpload} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="pdf-file-field" className="text-xs font-semibold text-gray-700">
            Choose PDF file (max 50MB)
          </label>
          <input
            id="pdf-file-field"
            type="file"
            accept="application/pdf"
            onChange={handleFileChange}
            disabled={loading}
            className="p-2 border border-gray-300 rounded text-sm bg-gray-50 text-gray-800 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
          />
        </div>

        <button
          type="submit"
          disabled={!selectedFile || loading}
          className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white font-semibold py-2 px-4 rounded text-sm transition-colors"
        >
          {loading ? 'Processing...' : 'Upload & Process PDF'}
        </button>
      </form>

      {status && (
        <div className={`mt-4 p-3 rounded text-sm border ${
          status.startsWith('Error') ? 'bg-red-50 text-red-700 border-red-200'
          : status === 'Ready!' ? 'bg-green-50 text-green-700 border-green-200'
          : 'bg-gray-50 text-gray-700 border-gray-200'
        }`}>
          <div className="flex items-center gap-2">
            {(status === 'Uploading...' || status === 'Processing chunks...') && (
              <div className="spinner" />
            )}
            <span>{status}</span>
          </div>

          {status === 'Ready!' && summary && (
            <div className="mt-2 flex gap-2 flex-wrap text-xs">
              <span className="bg-green-100 px-2 py-0.5 rounded font-semibold text-green-800">
                🧩 {summary.chunks} chunks
              </span>
              {summary.truncated && (
                <span className="bg-yellow-100 px-2 py-0.5 rounded font-semibold text-yellow-800">
                  ⚠️ Cap hit: first 200 chunks indexed
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
