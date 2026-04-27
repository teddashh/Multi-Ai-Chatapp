import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AttachmentKind, AttachmentRow } from './db.js';
import { attachmentStmts, db } from './db.js';

export const UPLOAD_ROOT = resolve(process.env.UPLOAD_DIR || './data/uploads');
mkdirSync(UPLOAD_ROOT, { recursive: true });
mkdirSync(join(UPLOAD_ROOT, '_pending'), { recursive: true });

// Filesystem-safe slug for usernames (which might contain @ etc.)
function sanitizeForPath(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100);
  return cleaned || '_';
}

export const MAX_FILE_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || `${20 * 1024 * 1024}`, 10);
export const MAX_FILES_PER_MESSAGE = 5;

const IMAGE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif',
]);
const PDF_MIME = new Set(['application/pdf']);
// Anything that looks like plain text is treated as text.
function isTextMime(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/javascript' ||
    mime === 'application/x-yaml' ||
    mime === 'application/x-typescript'
  );
}

function classify(filename: string, mime: string): AttachmentKind {
  if (IMAGE_MIME.has(mime)) return 'image';
  if (PDF_MIME.has(mime)) return 'pdf';
  if (isTextMime(mime)) return 'text';
  // Some text files arrive with octet-stream — fall back to extension.
  const ext = extname(filename).toLowerCase();
  if (['.txt', '.md', '.csv', '.json', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java', '.cs', '.rs', '.cpp', '.c', '.h', '.html', '.css', '.yaml', '.yml', '.toml', '.ini', '.sh', '.sql'].includes(ext)) {
    return 'text';
  }
  return 'other';
}

export interface SavedAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
}

export async function saveUpload(
  userId: number,
  filename: string,
  mimeType: string,
  bytes: Buffer,
): Promise<SavedAttachment> {
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error(`file too large (${bytes.length} bytes; max ${MAX_FILE_BYTES})`);
  }
  const id = randomUUID();
  const safeName = filename.replace(/[\\/:*?"<>|]/g, '_').slice(0, 200) || 'unnamed';
  // Initial location: _pending/<id>/<filename>. Moves to
  // <username>/<session_id>/<id>/<filename> when attached to a sent message.
  const dir = join(UPLOAD_ROOT, '_pending', id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, safeName);
  writeFileSync(path, bytes);

  const kind = classify(safeName, mimeType);
  let textContent: string | null = null;
  if (kind === 'text') {
    try {
      textContent = bytes.toString('utf8');
      // Truncate very long text to avoid blowing up prompts.
      if (textContent.length > 200_000) {
        textContent = textContent.slice(0, 200_000) + '\n\n... [truncated]';
      }
    } catch {
      textContent = null;
    }
  } else if (kind === 'pdf') {
    try {
      // Use dynamic import so missing pdf-parse doesn't crash startup.
      const mod = (await import('pdf-parse')) as { default: (b: Buffer) => Promise<{ text: string }> };
      const result = await mod.default(bytes);
      textContent = result.text || '';
      if (textContent.length > 200_000) {
        textContent = textContent.slice(0, 200_000) + '\n\n... [truncated]';
      }
    } catch (err) {
      console.error('pdf-parse failed', (err as Error).message);
      textContent = `[PDF text extraction failed: ${(err as Error).message}]`;
    }
  }

  attachmentStmts.insert.run(
    id,
    userId,
    safeName,
    mimeType,
    bytes.length,
    path,
    kind,
    textContent,
  );

  return { id, filename: safeName, mimeType, size: bytes.length, kind };
}

export interface PreparedAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  kind: AttachmentKind;
  textContent: string | null;
}

export function loadAttachments(
  ids: string[],
  userId: number,
): PreparedAttachment[] {
  if (ids.length === 0) return [];
  const out: PreparedAttachment[] = [];
  for (const id of ids) {
    const row = attachmentStmts.findOwned.get(id, userId) as AttachmentRow | undefined;
    if (!row) continue;
    out.push({
      id: row.id,
      filename: row.filename,
      mimeType: row.mime_type,
      size: row.size,
      path: row.path,
      kind: row.kind,
      textContent: row.text_content,
    });
  }
  return out;
}

// Build a markdown prefix that inlines text/PDF content. Image attachments are
// referenced (and should be passed via per-provider mechanisms separately).
export function buildAttachmentPrefix(attachments: PreparedAttachment[]): string {
  if (attachments.length === 0) return '';
  const parts: string[] = ['── 附件 ──', ''];
  for (const a of attachments) {
    if (a.kind === 'text' && a.textContent !== null) {
      parts.push(`### ${a.filename}`);
      parts.push('```');
      parts.push(a.textContent);
      parts.push('```');
      parts.push('');
    } else if (a.kind === 'pdf' && a.textContent !== null) {
      parts.push(`### ${a.filename}（PDF 文字內容）`);
      parts.push(a.textContent);
      parts.push('');
    } else if (a.kind === 'image') {
      parts.push(`### ${a.filename}（圖片，見上方附件）`);
      parts.push('');
    } else {
      parts.push(`### ${a.filename}（不支援預覽，僅顯示檔名）`);
      parts.push('');
    }
  }
  parts.push('── 使用者問題 ──', '');
  return parts.join('\n');
}

export function imageAttachments(attachments: PreparedAttachment[]): PreparedAttachment[] {
  return attachments.filter((a) => a.kind === 'image');
}

export function readImageBase64(a: PreparedAttachment): { mediaType: string; data: string } {
  const data = readFileSync(a.path).toString('base64');
  return { mediaType: a.mimeType, data };
}

const updatePathStmt = db.prepare<[string, string]>(
  `UPDATE chat_attachments SET path = ? WHERE id = ?`,
);

// Moves an uploaded attachment file from _pending/<id>/<file> to
// <username>/<session_id>/<id>/<file>, then updates the path stored in DB.
// Idempotent: if it has already been moved, this is a no-op.
export function relocateToSession(
  attachmentId: string,
  userId: number,
  username: string,
  sessionId: string,
): void {
  const row = attachmentStmts.findOwned.get(attachmentId, userId) as
    | AttachmentRow
    | undefined;
  if (!row) return;
  const cleanUser = sanitizeForPath(username);
  const cleanSession = sanitizeForPath(sessionId);
  const expectedDir = join(UPLOAD_ROOT, cleanUser, cleanSession, attachmentId);
  const expectedPath = join(expectedDir, row.filename);
  if (row.path === expectedPath) return; // already in place
  mkdirSync(expectedDir, { recursive: true });
  try {
    renameSync(row.path, expectedPath);
  } catch (err) {
    // If rename across devices fails fall back to copy + delete
    const data = readFileSync(row.path);
    writeFileSync(expectedPath, data);
    rmSync(row.path, { force: true });
  }
  updatePathStmt.run(expectedPath, attachmentId);
  // Try to remove the now-empty pending directory
  try {
    rmSync(dirname(row.path), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// Walk all attachments for a session and remove their files from disk. Called
// before deleting the session row in DB so we don't leave orphaned files.
export function deleteSessionFiles(sessionId: string, username: string): void {
  const cleanUser = sanitizeForPath(username);
  const cleanSession = sanitizeForPath(sessionId);
  const dir = join(UPLOAD_ROOT, cleanUser, cleanSession);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore — directory may not exist
  }
}
