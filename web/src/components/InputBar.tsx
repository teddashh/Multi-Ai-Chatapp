import React, { useRef, useState } from 'react';
import { uploadFile } from '../api';
import type { MessageAttachment } from '../shared/types';
import { useT } from '../i18n';

interface Props {
  onSend: (text: string, attachments: MessageAttachment[]) => void;
  onCancel: () => void;
  disabled: boolean;
  isProcessing: boolean;
}

const MAX_FILES = 5;
const MAX_BYTES = 20 * 1024 * 1024;

function kindIcon(kind: MessageAttachment['kind']): string {
  switch (kind) {
    case 'image': return '🖼';
    case 'pdf': return '📕';
    case 'text': return '📝';
    default: return '📎';
  }
}

export default function InputBar({ onSend, onCancel, disabled, isProcessing }: Props) {
  const t = useT();
  const [text, setText] = useState('');
  const [pending, setPending] = useState<MessageAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const handlePick = () => {
    fileRef.current?.click();
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError('');
    setUploading(true);
    try {
      const slots = MAX_FILES - pending.length;
      const incoming = Array.from(files).slice(0, slots);
      const uploaded: MessageAttachment[] = [];
      for (const f of incoming) {
        if (f.size > MAX_BYTES) {
          setError(t.inputFileTooLarge(f.name, MAX_BYTES / (1024 * 1024)));
          continue;
        }
        const att = await uploadFile(f);
        uploaded.push(att);
      }
      setPending((prev) => [...prev, ...uploaded]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removeAttachment = (id: string) => {
    setPending((prev) => prev.filter((a) => a.id !== id));
  };

  const handleSend = () => {
    if ((!text.trim() && pending.length === 0) || disabled) return;
    onSend(text.trim(), pending);
    setText('');
    setPending([]);
    setError('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex-none p-3 border-t border-gray-800 space-y-2">
      {pending.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {pending.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-1.5 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs"
            >
              <span>{kindIcon(a.kind)}</span>
              <span className="max-w-[140px] truncate" title={a.filename}>{a.filename}</span>
              <button
                onClick={() => removeAttachment(a.id)}
                className="text-gray-500 hover:text-red-400 ml-1"
                title={t.remove}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {uploading && <p className="text-xs text-gray-500">{t.uploading}</p>}

      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={handlePick}
          disabled={disabled || uploading || pending.length >= MAX_FILES}
          className="flex-none px-3 py-2 text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
          title={t.inputAttachTitle(pending.length, MAX_FILES)}
        >
          📎
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,application/pdf,text/*,.md,.csv,.json,.ts,.tsx,.js,.jsx,.py,.go,.java,.cs,.rs,.cpp,.c,.h,.html,.css,.yaml,.yml,.toml,.ini,.sh,.sql"
          onChange={(e) => handleFiles(e.target.files)}
          className="hidden"
        />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isProcessing ? t.inputPlaceholderProcessing : t.inputPlaceholderIdle
          }
          rows={2}
          disabled={disabled && !isProcessing}
          className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm resize-none focus:outline-none focus:border-blue-500 disabled:opacity-50"
        />
        {isProcessing ? (
          <button
            onClick={onCancel}
            className="flex-none px-4 py-2 bg-red-600 hover:bg-red-700 rounded text-sm font-medium"
          >
            {t.stop}
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={(!text.trim() && pending.length === 0) || disabled}
            className="flex-none px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium"
          >
            {t.send}
          </button>
        )}
      </div>
    </div>
  );
}
