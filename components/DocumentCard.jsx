import React, { useState } from 'react';

/**
 * DocumentCard — displays document info + action buttons.
 *
 * Props:
 *   id, title, pageCount, chunkCount, createdAt, onDelete, onSelect, isSelected
 */
export default function DocumentCard({ id, title, pageCount, chunkCount, createdAt, onDelete, onSelect, isSelected }) {
  const formattedDate = createdAt
    ? new Date(createdAt).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      })
    : null;

  const [deleting, setDeleting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const handleDelete = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDeleting(true);
    try {
      await onDelete?.(id);
    } catch {
      setDeleting(false);
      setShowConfirm(false);
    }
  };

  return (
    <div className={`p-4 border rounded-lg flex flex-col gap-3 transition-colors ${
      isSelected ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white'
    }`}>
      <div className="flex items-start gap-3">
        <div className="text-2xl">📄</div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-gray-900 truncate" title={title}>
            {title}
          </h3>
          {formattedDate && (
            <p className="text-xs text-gray-500">
              Uploaded {formattedDate}
            </p>
          )}
        </div>
      </div>

      <div className="flex gap-2 text-xs flex-wrap">
        {pageCount != null && (
          <span className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded">
            {pageCount} {pageCount === 1 ? 'page' : 'pages'}
          </span>
        )}
        {chunkCount != null && (
          <span className="px-2 py-0.5 bg-purple-100 text-purple-800 rounded">
            {chunkCount} chunks
          </span>
        )}
      </div>

      {showConfirm ? (
        <div className="flex items-center justify-between gap-2 mt-auto pt-2 border-t border-gray-100">
          <span className="text-xs font-semibold text-red-600">Delete this document?</span>
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={deleting}
              onClick={handleDelete}
              className="px-2 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-xs font-semibold disabled:opacity-50"
            >
              {deleting ? '...' : 'Yes'}
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setShowConfirm(false);
              }}
              className="px-2 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-xs font-semibold disabled:opacity-50"
            >
              No
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 mt-auto">
          <button
            type="button"
            onClick={() => onSelect?.(id)}
            className={`flex-1 px-3 py-1.5 rounded text-xs font-semibold border ${
              isSelected
                ? 'bg-blue-600 border-blue-600 text-white hover:bg-blue-700'
                : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >
            {isSelected ? 'Selected' : 'Chat Now'}
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setShowConfirm(true);
            }}
            disabled={deleting}
            className="px-3 py-1.5 bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 rounded text-xs font-semibold disabled:opacity-50"
            aria-label="Delete document"
          >
            🗑️
          </button>
        </div>
      )}
    </div>
  );
}
