import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage, ChatMode } from '../shared/types';
import { AI_PROVIDERS } from '../shared/constants';
import ProviderAvatar from './ProviderAvatar';
import { modeDesc, modeHowto, modeName, useT } from '../i18n';
import { avatarUrl, type User } from '../api';

interface Props {
  messages: ChatMessage[];
  mode: ChatMode;
  user: User;
  avatarBust: number;
  onRegenerate?: (messageId: string) => void;
  regeneratingId?: string | null;
}

// Pretty-print a raw model id like "claude-opus-4-7" → "Claude Opus 4.7"
// or "anthropic/claude-3-haiku" → "Claude 3 Haiku". Drops vendor prefix
// for readability — admin already sees the stage label separately so
// the vendor is implied.
function prettyModel(raw: string): string {
  let m = raw;
  if (m.includes('/')) m = m.split('/').pop() ?? m;
  // Trailing -X-Y → -X.Y so "claude-opus-4-7" reads "4.7" not "4 7".
  m = m.replace(/-(\d+)-(\d+)$/, '-$1.$2');
  m = m
    .replace(/^claude/, 'Claude')
    .replace(/^gpt/, 'GPT')
    .replace(/^gemini/, 'Gemini')
    .replace(/^grok/, 'Grok')
    .replace(/^kimi/, 'Kimi')
    .replace(/^llama/, 'Llama')
    .replace(/^gemma/, 'Gemma')
    .replace(/^mistral/, 'Mistral')
    .replace(/^qwen/, 'Qwen');
  // dash-separated tokens become space-separated capitalized words.
  m = m.replace(/-([a-z])/g, (_, c) => ' ' + c.toUpperCase());
  return m;
}

function prettyStage(stage: string): string {
  if (stage === 'cli') return 'CLI';
  if (stage.endsWith('_api')) return 'API';
  if (stage === 'openrouter') return 'OpenRouter';
  if (stage === 'nvidia') return 'NVIDIA';
  return stage;
}

// Roughly: collapse if message has > 3 newlines or > 220 chars (~3 lines wide).
function isLong(text: string): boolean {
  if (text.split('\n').length > 3) return true;
  return text.length > 220;
}

// Strip a leading/trailing pipe and split a markdown table row into cells.
function parseRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((s) => s.trim());
}

// Pull all GFM-style markdown tables out of the message. Each entry is a
// 2D array of strings — first row is the header, rest are data rows.
function extractTables(md: string): string[][][] {
  const lines = md.split('\n');
  const tables: string[][][] = [];
  for (let i = 0; i < lines.length; i++) {
    const isPipe = /^\s*\|.+\|\s*$/.test(lines[i]);
    const next = lines[i + 1] ?? '';
    const isSep = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(next);
    if (isPipe && isSep) {
      const rows: string[][] = [parseRow(lines[i])];
      i += 2;
      while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      i--;
      if (rows.length > 1) tables.push(rows);
    }
  }
  return tables;
}

// CSV-quote a single cell. Wraps in double-quotes when the cell contains
// a comma, quote, or newline; doubles any embedded quotes.
function csvCell(v: string): string {
  if (/["\n,]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function tablesToCsv(tables: string[][][]): string {
  return tables
    .map((rows) =>
      rows.map((row) => row.map(csvCell).join(',')).join('\n'),
    )
    .join('\n\n');
}

function downloadBlob(content: string, filename: string, mime: string): void {
  // Prepend a UTF-8 BOM so Excel opens Chinese / non-ASCII content
  // without garbling.
  const blob = new Blob(['\uFEFF' + content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// AI replies are markdown — headings, bold, lists, code blocks. Without
// this they read as raw `**text**` / `## title` / `- item` on screen,
// which is especially bad on mobile where horizontal space is scarce.
// Tailwind `prose` would do the heavy lifting if we had the typography
// plugin; absent that, we hand-tune component styles.
function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdown-body text-sm leading-relaxed break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
          h1: ({ children }) => (
            <h1 className="text-base font-bold mt-3 mb-1.5">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-sm font-bold mt-3 mb-1.5">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-semibold mt-2 mb-1">{children}</h3>
          ),
          ul: ({ children }) => (
            <ul className="my-1.5 ml-5 list-disc space-y-0.5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-1.5 ml-5 list-decimal space-y-0.5">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-snug">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-dotted underline-offset-2 hover:opacity-80"
            >
              {children}
            </a>
          ),
          code: ({ className, children, ...rest }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code className="px-1 py-0.5 rounded bg-black/30 font-mono text-[0.85em]" {...rest}>
                  {children}
                </code>
              );
            }
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-2 p-2 rounded bg-black/40 overflow-x-auto text-xs font-mono">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2 pl-3 border-l-2 border-gray-500/60 opacity-80">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-gray-600/40" />,
          table: ({ children }) => (
            <div className="overflow-x-auto my-2">
              <table className="text-xs border-collapse">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-gray-600/40 px-2 py-1 font-semibold text-left">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-gray-600/40 px-2 py-1">{children}</td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default function ChatArea({
  messages,
  mode,
  user,
  avatarBust,
  onRegenerate,
  regeneratingId,
}: Props) {
  const t = useT();
  const userDisplayName = user.nickname || user.username;
  const userInitial = userDisplayName.slice(0, 1).toUpperCase();
  const isSequential = mode !== 'free';
  const retryLabel = isSequential ? t.retrySeqIdle : t.retryFreeIdle;
  const retryBusyLabel = isSequential ? t.retrySeqBusy : t.retryFreeBusy;
  const retryTitle = isSequential ? t.retrySeqTitle : t.retryFreeTitle;
  const endRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Tracks the most recently "copied" message id for the inline
  // "Copy / Copied" toggle. Cleared after a couple of seconds.
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyMessage = (id: string, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => {
        setCopiedId((prev) => (prev === id ? null : prev));
      }, 1800);
    });
  };

  const downloadTablesAsCsv = (id: string, tables: string[][][]) => {
    if (tables.length === 0) return;
    const csv = tablesToCsv(tables);
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    downloadBlob(csv, `${id}-${ts}.csv`, 'text/csv;charset=utf-8');
  };

  // True .xlsx — preserves table-per-sheet structure so multi-table
  // exports land cleanly in Excel without manual splitting. The xlsx
  // library is ~300KB gzipped, so lazy-load it on first click instead
  // of bloating the initial chat bundle.
  const downloadTablesAsXlsx = async (id: string, tables: string[][][]) => {
    if (tables.length === 0) return;
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    tables.forEach((rows, i) => {
      const ws = XLSX.utils.aoa_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, `Table ${i + 1}`);
    });
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    XLSX.writeFile(wb, `${id}-${ts}.xlsx`);
  };

  // PDF: open a fresh window with the rendered markdown styled for
  // print, then call window.print() so the user can save as PDF via
  // their browser's native dialog. No PDF library needed and the
  // result is text-searchable.
  const exportMessageAsPdf = (msg: ChatMessage) => {
    const w = window.open('', '_blank', 'width=820,height=1000');
    if (!w) return;
    const provider = msg.provider ? AI_PROVIDERS[msg.provider]?.name : '';
    // Naive but safe: rely on the browser's own markdown-aware preview
    // by writing the message as preformatted markdown inside a <pre>.
    // Anything fancier (tables / code) would need a markdown -> HTML
    // pass; not worth the complexity for a v1.
    const escape = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const title = `${provider ?? 'AI'}${msg.modeRole ? ' (' + msg.modeRole + ')' : ''}`;
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>
  body { font-family: -apple-system, system-ui, "Helvetica Neue", "PingFang TC", sans-serif; max-width: 720px; margin: 24px auto; padding: 0 24px; color: #111; line-height: 1.55; }
  h1.title { font-size: 14px; color: #555; margin-bottom: 8px; border-bottom: 1px solid #ddd; padding-bottom: 6px; }
  pre { white-space: pre-wrap; word-break: break-word; font: inherit; }
  @media print { body { max-width: none; margin: 0; padding: 0 16px; } }
</style>
</head><body>
<h1 class="title">${escape(title)}</h1>
<pre>${escape(msg.content)}</pre>
<script>setTimeout(function(){window.print();},150);<\/script>
</body></html>`);
    w.document.close();
  };

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      {messages.length === 0 ? (
        <div className="max-w-md mx-auto pt-12 px-4">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
            <h2 className="text-base font-bold text-white mb-2">
              {modeName(t, mode)}
            </h2>
            <p className="text-xs text-gray-400 mb-3">{modeDesc(t, mode)}</p>
            <ul className="text-xs text-gray-300 space-y-2 leading-relaxed">
              {modeHowto(t, mode).map((line, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-gray-600 flex-none">•</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-gray-500 mt-4">{t.chatStartHere}</p>
          </div>
        </div>
      ) : (
        messages.map((msg) => {
          if (msg.role === 'user') {
            return (
              <div key={msg.id} className="flex gap-2 items-start justify-end">
                <div className="flex-1 min-w-0 max-w-[85%] flex flex-col items-end">
                  <div
                    className="text-xs font-semibold mb-1.5 text-blue-300"
                  >
                    {userDisplayName}
                  </div>
                  <div className="bg-blue-600/20 border border-blue-700/40 rounded-lg p-3 text-sm whitespace-pre-wrap">
                    {msg.content && <div>{msg.content}</div>}
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2 justify-end">
                        {msg.attachments.map((a) => {
                          if (a.kind === 'image') {
                            return (
                              <a
                                key={a.id}
                                href={`/api/sessions/attachments/${a.id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={a.filename}
                              >
                                <img
                                  src={`/api/sessions/attachments/${a.id}`}
                                  alt={a.filename}
                                  className="max-h-32 max-w-[160px] rounded object-cover border border-blue-800/40"
                                />
                              </a>
                            );
                          }
                          return (
                            <a
                              key={a.id}
                              href={`/api/sessions/attachments/${a.id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1.5 bg-blue-900/30 border border-blue-800/40 rounded px-2 py-1 text-xs hover:bg-blue-900/50"
                              title={a.filename}
                            >
                              <span>
                                {(() => {
                                  const ext = a.filename.toLowerCase().split('.').pop() ?? '';
                                  if (['xlsx', 'xls', 'ods'].includes(ext)) return '📊';
                                  if (['docx', 'odt'].includes(ext)) return '📄';
                                  if (['pptx', 'odp'].includes(ext)) return '📑';
                                  if (a.kind === 'pdf') return '📕';
                                  if (a.kind === 'text') return '📝';
                                  return '📎';
                                })()}
                              </span>
                              <span className="max-w-[140px] truncate">{a.filename}</span>
                            </a>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
                {user.hasAvatar ? (
                  <img
                    src={avatarUrl(user.username, avatarBust)}
                    alt={userDisplayName}
                    className="w-9 h-9 rounded-full object-cover border border-gray-700 flex-none"
                  />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-gray-700 flex items-center justify-center text-xs font-bold flex-none">
                    {userInitial}
                  </div>
                )}
              </div>
            );
          }
          const info = msg.provider ? AI_PROVIDERS[msg.provider] : undefined;
          const name = info?.name ?? msg.provider ?? 'AI';
          const color = info?.color ?? '#9ca3af';
          const open = expanded.has(msg.id);
          const long = isLong(msg.content);
          const showCollapse = long && !open;
          const tables = extractTables(msg.content);

          return (
            <div key={msg.id} className="flex gap-2 items-start">
              {msg.provider ? (
                <ProviderAvatar provider={msg.provider} size={36} />
              ) : (
                <div className="w-9 h-9 rounded-full bg-gray-700 flex items-center justify-center text-xs flex-none">
                  ⚠
                </div>
              )}
              <div className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg p-3 text-sm">
                <div
                  className="text-xs font-semibold mb-1.5"
                  style={{ color }}
                >
                  {name}
                  {msg.modeRole ? (
                    <span className="ml-1 text-gray-500 font-normal">
                      ({msg.modeRole})
                    </span>
                  ) : null}
                  {/* Admin-only provenance badge. Hidden in print (PDF
                      export uses window.print) and never shipped to
                      non-admin users by the server. */}
                  {user.tier === 'admin' && msg.answeredModel ? (
                    <span className="ml-2 text-[10px] text-gray-500 font-normal print:hidden">
                      {prettyModel(msg.answeredModel)}
                      {msg.answeredStage
                        ? ` / ${prettyStage(msg.answeredStage)}`
                        : ''}
                    </span>
                  ) : null}
                </div>
                <div
                  className={showCollapse ? 'line-clamp-3 overflow-hidden' : ''}
                >
                  <MarkdownText text={msg.content} />
                </div>
                <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1.5">
                  {long && (
                    <button
                      onClick={() => toggle(msg.id)}
                      className="text-xs text-gray-500 hover:text-white inline-flex items-center gap-1"
                    >
                      {open ? t.chatCollapse : t.chatExpand}
                    </button>
                  )}
                  {!msg.id.endsWith('-streaming') && msg.content && (
                    <button
                      onClick={() => copyMessage(msg.id, msg.content)}
                      className="text-xs text-gray-500 hover:text-white inline-flex items-center gap-1"
                    >
                      {copiedId === msg.id ? t.msgCopied : t.msgCopy}
                    </button>
                  )}
                  {!msg.id.endsWith('-streaming') && tables.length > 0 && (
                    <>
                      <button
                        onClick={() => downloadTablesAsXlsx(msg.id, tables)}
                        className="text-xs text-gray-500 hover:text-white inline-flex items-center gap-1"
                      >
                        {t.msgExportTablesXlsx(tables.length)}
                      </button>
                      <button
                        onClick={() => downloadTablesAsCsv(msg.id, tables)}
                        className="text-xs text-gray-500 hover:text-white inline-flex items-center gap-1"
                      >
                        {t.msgExportTablesCsv(tables.length)}
                      </button>
                    </>
                  )}
                  {!msg.id.endsWith('-streaming') && msg.content && (
                    <button
                      onClick={() => exportMessageAsPdf(msg)}
                      className="text-xs text-gray-500 hover:text-white inline-flex items-center gap-1"
                    >
                      {t.msgExportPdf}
                    </button>
                  )}
                  {onRegenerate &&
                    msg.provider &&
                    !msg.id.endsWith('-streaming') &&
                    /^\d+$/.test(msg.id) && (
                      <button
                        onClick={() => onRegenerate(msg.id)}
                        disabled={regeneratingId !== null}
                        className="text-xs text-gray-500 hover:text-white inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                        title={retryTitle}
                      >
                        {regeneratingId === msg.id ? retryBusyLabel : retryLabel}
                      </button>
                    )}
                </div>
              </div>
            </div>
          );
        })
      )}
      <div ref={endRef} />
    </div>
  );
}
