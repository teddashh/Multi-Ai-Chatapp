import type {
  AIProvider,
  ChatMode,
  MessageAttachment,
  ModeRoles,
  SSEEvent,
  Tier,
} from './shared/types';

export interface ModelChoices {
  default: string;
  options: string[];
}

export type ThemeId =
  | 'winter'
  | 'summer'
  | 'claude'
  | 'gemini'
  | 'grok'
  | 'chatgpt';

export interface User {
  username: string;
  nickname: string | null;
  email: string | null;
  tier: Tier;
  lang: 'zh-TW' | 'en';
  hasAvatar: boolean;
  theme: ThemeId;
  models: Record<AIProvider, ModelChoices>;
}

export async function updateProfile(patch: {
  lang?: 'zh-TW' | 'en';
  nickname?: string | null;
  password?: string | null;
  theme?: ThemeId;
}): Promise<User> {
  const res = await fetch('/api/auth/profile', {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `${res.status}`);
  }
  const data = (await res.json()) as { user: User };
  return data.user;
}

export async function uploadAvatar(file: File): Promise<User> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/auth/avatar', {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `${res.status}`);
  }
  const data = (await res.json()) as { user: User };
  return data.user;
}

export async function deleteAvatar(): Promise<User> {
  const res = await fetch('/api/auth/avatar', {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const data = (await res.json()) as { user: User };
  return data.user;
}

export function avatarUrl(username: string, bust: number = Date.now()): string {
  return `/api/auth/avatar/${encodeURIComponent(username)}?t=${bust}`;
}

export interface AdminUser {
  id: number;
  username: string;
  tier: Tier;
  created_at: number;
  nickname: string | null;
  email: string | null;
  real_name: string | null;
  has_avatar: boolean;
}

export interface AdminSessionSummary {
  id: string;
  title: string;
  mode: ChatMode;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  msg_count: number;
}

export interface AdminSessionDetail {
  session: {
    id: string;
    title: string;
    mode: ChatMode;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
    owner: {
      username: string;
      nickname: string | null;
      real_name: string | null;
    } | null;
  };
  messages: SessionDetail['messages'];
}

export interface AuditEntry {
  id: number;
  admin: string | null;
  target_user: string | null;
  target_session_id: string | null;
  action: string;
  metadata: Record<string, unknown> | null;
  timestamp: number;
}

export interface UsageRow {
  id: number;
  username: string;
  real_name: string | null;
  nickname: string | null;
  tier: Tier;
  totals: {
    calls: number;
    tokens_in: number;
    tokens_out: number;
    prompt_chars: number;
    completion_chars: number;
  };
  by_model: Array<{
    provider: AIProvider;
    model: string;
    calls: number;
    tokens_in: number;
    tokens_out: number;
    prompt_chars: number;
    completion_chars: number;
    is_estimated: boolean;
  }>;
}

export async function me(): Promise<User | null> {
  const res = await fetch('/api/auth/me', { credentials: 'include' });
  if (!res.ok) return null;
  const data = await res.json();
  return data.user as User;
}

export async function login(username: string, password: string): Promise<User> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Login failed: ${res.status}`);
  }
  const data = await res.json();
  return data.user as User;
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
}

export async function forgotPassword(identifier: string): Promise<void> {
  const res = await fetch('/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`${res.status}`);
}

export async function resetPassword(token: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `${res.status}`);
  }
}

// === Attachments ===

export async function uploadFile(file: File): Promise<MessageAttachment> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/chat/upload', {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `${res.status}`);
  }
  const data = (await res.json()) as { attachment: MessageAttachment };
  return data.attachment;
}

// === Sessions ===

export interface SessionSummary {
  id: string;
  title: string;
  mode: ChatMode;
  created_at: number;
  updated_at: number;
  msg_count: number;
}

export interface SessionDetail {
  session: {
    id: string;
    title: string;
    mode: ChatMode;
    created_at: number;
    updated_at: number;
  };
  messages: Array<{
    id: string;
    role: 'user' | 'ai';
    provider?: AIProvider;
    modeRole?: string;
    content: string;
    timestamp: number;
    attachments?: MessageAttachment[];
  }>;
}

export async function listSessions(): Promise<SessionSummary[]> {
  const res = await fetch('/api/sessions', { credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status}`);
  const data = (await res.json()) as { sessions: SessionSummary[] };
  return data.sessions;
}

export async function getSession(id: string): Promise<SessionDetail> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<SessionDetail>;
}

export async function renameSession(id: string, title: string): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`${res.status}`);
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`${res.status}`);
}

// Re-run a single AI message. Streams back the new content via the same SSE
// shape as /send (chunk → done → finish).
export async function streamRegenerate(
  body: {
    messageId: string;
    modelOverrides?: Partial<Record<AIProvider, string>>;
  },
  onEvent: (event: SSEEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/chat/regenerate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Regenerate failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const data = dataLine.slice(5).trim();
      if (!data) continue;
      try {
        const event = JSON.parse(data) as SSEEvent;
        onEvent(event);
        if (event.type === 'finish') return;
      } catch {
        // ignore
      }
    }
  }
}

// === Admin (super tier only) ===

async function adminFetch(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`/api/admin${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `${res.status}`);
  }
  return res.json();
}

export async function listUsers(): Promise<AdminUser[]> {
  const data = (await adminFetch('/users')) as { users: AdminUser[] };
  return data.users;
}

export async function createUser(
  fields: {
    username: string;
    password: string;
    tier: Tier;
    nickname?: string;
    email?: string;
    real_name?: string;
  },
): Promise<void> {
  await adminFetch('/users', {
    method: 'POST',
    body: JSON.stringify(fields),
  });
}

export async function inviteUser(
  fields: {
    username: string;
    email: string;
    tier: Tier;
    nickname?: string;
    real_name?: string;
  },
): Promise<{ inviteUrl: string }> {
  const data = (await adminFetch('/users/invite', {
    method: 'POST',
    body: JSON.stringify(fields),
  })) as { inviteUrl: string };
  return data;
}

export async function updateUser(
  username: string,
  patch: {
    password?: string;
    tier?: Tier;
    nickname?: string;
    email?: string;
    real_name?: string;
  },
): Promise<void> {
  await adminFetch(`/users/${encodeURIComponent(username)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deleteUser(username: string): Promise<void> {
  await adminFetch(`/users/${encodeURIComponent(username)}`, {
    method: 'DELETE',
  });
}

export async function adminListUserSessions(
  username: string,
): Promise<AdminSessionSummary[]> {
  const data = (await adminFetch(
    `/users/${encodeURIComponent(username)}/sessions`,
  )) as { sessions: AdminSessionSummary[] };
  return data.sessions;
}

export async function adminGetSession(id: string): Promise<AdminSessionDetail> {
  const data = (await adminFetch(`/sessions/${encodeURIComponent(id)}`)) as
    AdminSessionDetail;
  return data;
}

export async function adminListAudit(limit = 200): Promise<AuditEntry[]> {
  const data = (await adminFetch(`/audit?limit=${limit}`)) as {
    audit: AuditEntry[];
  };
  return data.audit;
}

export async function adminGetUsage(): Promise<UsageRow[]> {
  const data = (await adminFetch('/usage')) as { users: UsageRow[] };
  return data.users;
}

// Streams chat events via SSE. Calls onEvent for each SSEEvent until 'finish'
// or an abort. Returns when the stream ends.
export async function streamChat(
  body: {
    text: string;
    mode: ChatMode;
    roles?: ModeRoles;
    modelOverrides?: Partial<Record<AIProvider, string>>;
    sessionId?: string;
    attachmentIds?: string[];
  },
  onEvent: (event: SSEEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/chat/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Chat failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE messages are separated by blank lines
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      const dataLine = block
        .split('\n')
        .find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      const data = dataLine.slice(5).trim();
      if (!data) continue;
      try {
        const event = JSON.parse(data) as SSEEvent;
        onEvent(event);
        if (event.type === 'finish') return;
      } catch {
        // ignore malformed events
      }
    }
  }
}
