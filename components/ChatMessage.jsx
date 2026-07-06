import React from 'react';

/**
 * ChatMessage — simple styling using Tailwind CSS.
 *
 * Props:
 *   role        — 'user' | 'assistant'
 *   content     — message text
 *   isStreaming — show blinking cursor if true
 */
export default function ChatMessage({ role, content, isStreaming }) {
  const isUser = role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4 items-end space-x-2`}>
      {!isUser && (
        <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center text-sm flex-shrink-0">
          AI
        </div>
      )}

      <div className={`max-w-[80%] rounded-lg px-4 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words ${
        isUser ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-800 border border-gray-200'
      }`}>
        {content}
        {isStreaming && <span className="inline-block w-1.5 h-4 bg-current ml-1 animate-pulse" />}
      </div>

      {isUser && (
        <div className="w-8 h-8 rounded-full bg-gray-300 text-gray-700 flex items-center justify-center text-sm flex-shrink-0">
          ME
        </div>
      )}
    </div>
  );
}
