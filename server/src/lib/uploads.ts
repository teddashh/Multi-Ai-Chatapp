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
mkdirSync(join(UPLOAD_ROOT, '_avatars'), { recursive: true });
mkdirSync(join(UPLOAD_ROOT, '_forum-media'), { recursive: true });

const AVATAR_DIR = join(UPLOAD_ROOT, '_avatars');
const FORUM_MEDIA_DIR = join(UPLOAD_ROOT, '_forum-media');
const AVATAR_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
export const MAX_AVATAR_BYTES = 4 * 1024 * 1024;

export function isSupportedAvatarMime(mime: string): boolean {
  return mime in AVATAR_MIME_EXT;
}

// Saves the avatar bytes for a user, replacing any prior file. Returns
// the *relative* filename (`<id>.<ext>`) to persist in users.avatar_path.
// Storing only the filename keeps the row portable — moving the uploads
// dir or renaming UPLOAD_DIR (e.g. the Apr-29 dev/prod split that broke
// scarletlin / tedjchuang avatars) won't invalidate the DB.
export function saveAvatar(
  userId: number,
  mime: string,
  buffer: Buffer,
): string {
  const ext = AVATAR_MIME_EXT[mime];
  if (!ext) throw new Error(`unsupported avatar mime ${mime}`);
  // Wipe any prior file (different ext) so we don't accumulate stale variants.
  for (const e of Object.values(AVATAR_MIME_EXT)) {
    try {
      rmSync(join(AVATAR_DIR, `${userId}.${e}`));
    } catch {
      // ignore — file may not exist
    }
  }
  const filename = `${userId}.${ext}`;
  writeFileSync(join(AVATAR_DIR, filename), buffer);
  return filename;
}

// Accepts either the new relative `<id>.<ext>` or a legacy absolute path
// (pre-v5 backfill). Heuristic: bare filenames have no path separator.
export function readAvatar(ref: string): Buffer | null {
  const abs = ref.includes('/') || ref.includes('\\') ? ref : join(AVATAR_DIR, ref);
  try {
    return readFileSync(abs);
  } catch {
    return null;
  }
}

// ── Forum media (post galleries + AI persona galleries) ──────────────
export const MAX_FORUM_MEDIA_BYTES = 8 * 1024 * 1024;
const FORUM_MEDIA_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function isSupportedForumMediaMime(mime: string): boolean {
  return mime in FORUM_MEDIA_MIME_EXT;
}

export function forumMediaExt(mime: string): string {
  const ext = FORUM_MEDIA_MIME_EXT[mime];
  if (!ext) throw new Error(`unsupported forum media mime ${mime}`);
  return ext;
}

// Writes the bytes under _forum-media/<uuid>.<ext> and returns the bare
// filename for storage in forum_media.path. Same portability rationale
// as users.avatar_path — moving UPLOAD_DIR doesn't invalidate rows.
export function saveForumMedia(mime: string, buffer: Buffer): string {
  const ext = forumMediaExt(mime);
  const filename = `${randomUUID()}.${ext}`;
  writeFileSync(join(FORUM_MEDIA_DIR, filename), buffer);
  return filename;
}

export function readForumMedia(filename: string): Buffer | null {
  try {
    return readFileSync(join(FORUM_MEDIA_DIR, filename));
  } catch {
    return null;
  }
}

export function deleteForumMedia(filename: string): void {
  try {
    rmSync(join(FORUM_MEDIA_DIR, filename));
  } catch {
    // ignore — file may already be missing
  }
}

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
// Office formats — extracted to text via officeparser at upload time.
const OFFICE_EXTS = new Set([
  '.docx', '.xlsx', '.xls', '.pptx', '.odt', '.ods', '.odp',
]);
const OFFICE_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
  'application/vnd.ms-excel', // xls
  'application/vnd.oasis.opendocument.text', // odt
  'application/vnd.oasis.opendocument.spreadsheet', // ods
  'application/vnd.oasis.opendocument.presentation', // odp
]);

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

function isOfficeFile(filename: string, mime: string): boolean {
  if (OFFICE_MIMES.has(mime)) return true;
  return OFFICE_EXTS.has(extname(filename).toLowerCase());
}

function classify(filename: string, mime: string): AttachmentKind {
  if (IMAGE_MIME.has(mime)) return 'image';
  if (PDF_MIME.has(mime)) return 'pdf';
  if (isTextMime(mime)) return 'text';
  // Office files — DB schema uses 'text' (their content is text-extracted
  // at upload time), display side keys off the filename extension to
  // pick a sensible icon.
  if (isOfficeFile(filename, mime)) return 'text';
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
  const officeFile = isOfficeFile(safeName, mimeType);
  let textContent: string | null = null;
  if (officeFile) {
    // docx / xlsx / pptx / odt / ods / odp — extract text via officeparser.
    // The library returns a structured AST; .toText() flattens it.
    try {
      const { OfficeParser } = (await import('officeparser')) as typeof import('officeparser');
      const ast = await OfficeParser.parseOffice(bytes);
      textContent = ast.toText();
      if (textContent.length > 200_000) {
        textContent = textContent.slice(0, 200_000) + '\n\n... [truncated]';
      }
    } catch (err) {
      console.error('officeparser failed', (err as Error).message);
      textContent = `[Office file text extraction failed: ${(err as Error).message}]`;
    }
  } else if (kind === 'text') {
    try {
      textContent = bytes.toString('utf8');
      if (textContent.length > 200_000) {
        textContent = textContent.slice(0, 200_000) + '\n\n... [truncated]';
      }
    } catch {
      textContent = null;
    }
  } else if (kind === 'pdf') {
    try {
      // Dynamic import so missing pdf-parse doesn't crash startup.
      const mod = (await import('pdf-parse')) as {
        default: (b: Buffer) => Promise<{ text: string }>;
      };
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

// Tag an attachment by its filename extension for prompt + UI hints.
// Returns a short suffix the prompt header can use ("Excel 試算表",
// "Word 文件", etc) so the model knows what kind of document it's
// reading (helpful for table-heavy xlsx vs prose-heavy docx).
function officeKind(filename: string): string | null {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case '.xlsx':
    case '.xls':
    case '.ods':
      return 'Excel 試算表';
    case '.docx':
    case '.odt':
      return 'Word 文件';
    case '.pptx':
    case '.odp':
      return 'PowerPoint 簡報';
    default:
      return null;
  }
}

// Build a markdown prefix that inlines text/PDF/Office content. Image
// attachments are referenced (and should be passed via per-provider
// mechanisms separately).
export function buildAttachmentPrefix(attachments: PreparedAttachment[]): string {
  if (attachments.length === 0) return '';
  const parts: string[] = ['── 附件 ──', ''];
  for (const a of attachments) {
    const officeLabel = officeKind(a.filename);
    if (officeLabel && a.textContent !== null) {
      parts.push(`### ${a.filename}（${officeLabel}文字內容）`);
      parts.push(a.textContent);
      parts.push('');
    } else if (a.kind === 'text' && a.textContent !== null) {
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
