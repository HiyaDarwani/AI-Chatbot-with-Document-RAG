import React, { useState } from 'react';

/**
 * ChunkSourceList — collapsible citations panel using Tailwind CSS.
 *
 * Props:
 *   sources — array of { label, chunkIndex, sourcePage, similarity, excerpt }
 */
export default function ChunkSourceList({ sources }) {
  const [open, setOpen] = useState(false);

  if (!sources || sources.length === 0) return null;

  return (
    <div className="mt-2 mb-4 ml-10 max-w-[80%]">
      {/* Toggle button */}
      <button
        onClick={() => setOpen(o => !o)}
        className="text-xs text-gray-500 hover:text-gray-700 font-medium flex items-center gap-1 focus:outline-none"
      >
        <span>{open ? '▼' : '▶'}</span>
        {sources.length} source{sources.length > 1 ? 's' : ''} used
      </button>

      {/* Expanded list */}
      {open && (
        <div className="mt-2 space-y-2">
          {sources.map((src, i) => (
            <div key={i} className="p-3 bg-gray-50 border border-gray-200 rounded-md text-xs">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded font-semibold border border-blue-100">
                  {src.label}
                </span>
                {src.sourcePage && (
                  <span className="px-2 py-0.5 bg-gray-100 text-gray-700 rounded border border-gray-200">
                    Page ~{src.sourcePage}
                  </span>
                )}
                <span className="ml-auto text-green-700 font-semibold bg-green-50 px-2 py-0.5 rounded border border-green-100">
                  {src.similarity}% match
                </span>
              </div>
              <p className="text-gray-600 italic leading-relaxed mt-1">
                "{src.excerpt}"
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
