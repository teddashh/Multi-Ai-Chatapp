import type { ChatMode, ModeRoles, SSEEvent, Tier } from './shared/types';

export interface User {
  username: string;
  tier: Tier;
}

export interface AdminUser {
  id: number;
  username: string;
  tier: Tier;
  created_at: number;
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
  username: string,
  password: string,
  tier: Tier,
): Promise<void> {
  await adminFetch('/users', {
    method: 'POST',
    body: JSON.stringify({ username, password, tier }),
  });
}

export async function updateUser(
  username: string,
  patch: { password?: string; tier?: Tier },
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

// Streams chat events via SSE. Calls onEvent for each SSEEvent until 'finish'
// or an abort. Returns when the stream ends.
export async function streamChat(
  body: { text: string; mode: ChatMode; roles?: ModeRoles },
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
