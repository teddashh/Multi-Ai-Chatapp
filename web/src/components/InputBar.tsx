import React, { useState } from 'react';

interface Props {
  onSend: (text: string) => void;
  onCancel: () => void;
  disabled: boolean;
  isProcessing: boolean;
}

export default function InputBar({ onSend, onCancel, disabled, isProcessing }: Props) {
  const [text, setText] = useState('');

  const handleSend = () => {
    if (!text.trim() || disabled) return;
    onSend(text.trim());
    setText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex-none p-3 border-t border-gray-800 flex items-end gap-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={isProcessing ? '處理中...' : '輸入訊息... (Enter 送出, Shift+Enter 換行)'}
        rows={2}
        disabled={disabled && !isProcessing}
        className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm resize-none focus:outline-none focus:border-blue-500 disabled:opacity-50"
      />
      {isProcessing ? (
        <button
          onClick={onCancel}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded text-sm font-medium"
        >
          Stop
        </button>
      ) : (
        <button
          onClick={handleSend}
          disabled={!text.trim() || disabled}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium"
        >
          送出
        </button>
      )}
    </div>
  );
}
