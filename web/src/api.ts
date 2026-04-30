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
  emailVerified: boolean;
  models: Record<AIProvider, ModelChoices>;
}

export async function verifyEmail(token: string): Promise<User> {
  const res = await fetch('/api/auth/verify-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `${res.status}`);
  }
  const data = (await res.json()) as { user: User };
  return data.user;
}

export async function resendVerifyEmail(): Promise<void> {
  const res = await fetch('/api/auth/resend-verify', {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(data.message || data.error || `${res.status}`);
  }
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
  total_calls: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
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

export interface UsageByModel {
  provider: AIProvider;
  model: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  prompt_chars: number;
  completion_chars: number;
  is_estimated: boolean;
  cost_usd: number;
}

export interface UsageTotals {
  calls: number;
  tokens_in: number;
  tokens_out: number;
  prompt_chars: number;
  completion_chars: number;
  cost_usd: number;
}

export interface UsageRow {
  id: number;
  username: string;
  real_name: string | null;
  nickname: string | null;
  tier: Tier;
  totals: UsageTotals;
  by_model: UsageByModel[];
}

export interface MyUsage {
  totals: UsageTotals;
  by_model: UsageByModel[];
}

export async function getMyUsage(): Promise<MyUsage> {
  const res = await fetch('/api/auth/usage', { credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<MyUsage>;
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

export async function signup(fields: {
  email: string;
  password: string;
  nickname?: string;
  username?: string;
}): Promise<User> {
  const res = await fetch('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Sign up failed: ${res.status}`);
  }
  const data = await res.json();
  return data.user as User;
}

export interface ResetInfo {
  username: string;
  email: string | null;
  nickname: string | null;
  isInvite: boolean;
}

export async function getResetInfo(token: string): Promise<ResetInfo> {
  const res = await fetch(
    `/api/auth/reset-info?token=${encodeURIComponent(token)}`,
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `${res.status}`);
  }
  return res.json() as Promise<ResetInfo>;
}

export async function forgotPassword(identifier: string): Promise<void> {
  const res = await fetch('/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`${res.status}`);
}

export async function resetPassword(
  token: string,
  password: string,
  username?: string,
): Promise<void> {
  const res = await fetch('/api/auth/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password, username }),
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

// Agent-mode session metadata. Stored in chat_sessions.roles_json on
// creation so clicking a sidebar entry can restore mode + AI + extras.
export interface AgentSessionMeta {
  provider?: AIProvider;
  profession?: string;
  imageModel?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  mode: ChatMode;
  // For Agent modes: AgentSessionMeta. For Multi sequential modes:
  // ModeRoles. For free mode: null.
  meta: AgentSessionMeta | ModeRoles | null;
  created_at: number;
  updated_at: number;
  msg_count: number;
}

export interface SessionDetail {
  session: {
    id: string;
    title: string;
    mode: ChatMode;
    meta: AgentSessionMeta | ModeRoles | null;
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

export async function abortChat(sessionId: string): Promise<void> {
  await fetch(`/api/chat/abort/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    credentials: 'include',
  }).catch(() => {});
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
    email: string;
    tier: Tier;
    nickname?: string;
    real_name?: string;
  },
): Promise<{ inviteUrl: string; username: string; emailSent: boolean }> {
  const data = (await adminFetch('/users/invite', {
    method: 'POST',
    body: JSON.stringify(fields),
  })) as { inviteUrl: string; username: string; emailSent: boolean };
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

export interface ModelStatRow {
  // Vendor that gets billed: Anthropic / OpenAI / Google / xAI / OpenRouter
  provider: string;
  // Which AI character the user picked: Claude / GPT / Gemini / Grok
  family: string;
  // CLI subprocess vs direct API (OpenRouter is always API)
  method: 'CLI' | 'API';
  model: string;
  attempts: number;
  successes: number;
  failures: number;
  success_rate: number | null;
  last_seen: number | null;
  recent_errors: Array<{ code: string; n: number }>;
}

export async function adminGetModelStats(): Promise<ModelStatRow[]> {
  const data = (await adminFetch('/model-stats')) as { stats: ModelStatRow[] };
  return data.stats;
}

export interface ApiKeyChannel {
  channel: string;
  total_calls: number;
  total_cost_usd: number;
  models: Array<{
    provider: string;
    model: string;
    calls: number;
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
  }>;
}

export async function adminGetApiKeySpending(): Promise<ApiKeyChannel[]> {
  const data = (await adminFetch('/api-key-spending')) as { channels: ApiKeyChannel[] };
  return data.channels;
}

export async function adminRunDigest(): Promise<{ ok: boolean; error?: string }> {
  return (await adminFetch('/digest/run', { method: 'POST' })) as {
    ok: boolean;
    error?: string;
  };
}

// === Forum ===

export interface ForumPostSummary {
  id: number;
  category: string;
  sourceMode: string | null;
  title: string;
  bodyPreview: string;
  // Username for fetching the OP's avatar at /api/auth/avatar/:username.
  // Null when the post is anonymous (avatar falls back to AnonAvatar).
  authorUsername: string | null;
  authorDisplay: string;
  isAnonymous: boolean;
  thumbsCount: number;
  commentCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ForumPostDetail extends ForumPostSummary {
  body: string;
  // Snapshot of the profession persona at share time (e.g. "按摩師"
  // for a 指定職業 session). UI uses this in place of the bare AI
  // provider name on AI comments. Null when not applicable.
  aiPersona: string | null;
  liked: boolean;
}

export interface ForumComment {
  id: number;
  authorType: 'user' | 'ai';
  authorDisplay: string;
  // For named user comments only — used to fetch their avatar at
  // /api/auth/avatar/:username. Null when anonymous or AI.
  authorUsername: string | null;
  authorAvatarPath: string | null;
  authorAiProvider?: AIProvider;
  body: string;
  isAnonymous: boolean;
  isImported: boolean;
  thumbsCount: number;
  createdAt: number;
  liked: boolean;
}

export interface AIProfileResponse {
  provider: AIProvider;
  stats: {
    totalComments: number;
    totalLikes: number;
  };
  recent: Array<{
    id: number;
    body: string;
    thumbsCount: number;
    createdAt: number;
    isImported: boolean;
    postId: number;
    postTitle: string;
    postCategory: string;
  }>;
}

export async function getAIProfile(
  provider: AIProvider,
): Promise<AIProfileResponse> {
  const res = await fetch(`/api/forum/ai/${provider}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<AIProfileResponse>;
}

export interface ForumLiker {
  username: string;
  nickname: string | null;
  hasAvatar: boolean;
  createdAt: number;
}

export async function listForumLikers(
  targetType: 'post' | 'comment',
  targetId: number,
): Promise<ForumLiker[]> {
  const res = await fetch(
    `/api/forum/likers/${targetType}/${targetId}`,
    { credentials: 'include' },
  );
  if (!res.ok) throw new Error(`${res.status}`);
  const data = (await res.json()) as { likers: ForumLiker[] };
  return data.likers;
}

export interface ForumCategoryCount {
  category: string;
  count: number;
}

export async function listForumCategories(): Promise<ForumCategoryCount[]> {
  const res = await fetch('/api/forum/categories');
  if (!res.ok) throw new Error(`${res.status}`);
  const data = (await res.json()) as { categories: ForumCategoryCount[] };
  return data.categories;
}

export async function listForumPosts(opts: {
  category?: string;
  page?: number;
}): Promise<{ posts: ForumPostSummary[]; page: number; pageSize: number }> {
  const params = new URLSearchParams();
  if (opts.category) params.set('category', opts.category);
  if (opts.page) params.set('page', String(opts.page));
  const qs = params.toString();
  const res = await fetch(`/api/forum${qs ? '?' + qs : ''}`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<{
    posts: ForumPostSummary[];
    page: number;
    pageSize: number;
  }>;
}

// Per-AI stats inlined on the post-detail response — feeds the
// comment hover card (level + likes) without a fetch per comment.
export interface AIStat {
  totalComments: number;
  totalLikes: number;
}
export type AIStatsMap = Record<AIProvider, AIStat>;

export async function getForumPost(
  postId: number,
): Promise<{
  post: ForumPostDetail;
  comments: ForumComment[];
  aiStats: AIStatsMap;
}> {
  const res = await fetch(`/api/forum/${postId}`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<{
    post: ForumPostDetail;
    comments: ForumComment[];
    aiStats: AIStatsMap;
  }>;
}

export async function shareSessionToForum(body: {
  sessionId: string;
  category: string;
  isAnonymous?: boolean;
  title?: string;
}): Promise<{ postId: number; appended: number; isNew: boolean }> {
  const res = await fetch('/api/forum/share', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `${res.status}`);
  }
  return res.json() as Promise<{
    postId: number;
    appended: number;
    isNew: boolean;
  }>;
}

export async function postForumComment(
  postId: number,
  body: { body: string; isAnonymous?: boolean },
): Promise<void> {
  const res = await fetch(`/api/forum/${postId}/comments`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `${res.status}`);
  }
}

export async function toggleForumLike(body: {
  targetType: 'post' | 'comment';
  targetId: number;
}): Promise<{ liked: boolean }> {
  const res = await fetch('/api/forum/like', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `${res.status}`);
  }
  return res.json() as Promise<{ liked: boolean }>;
}

// Streams chat events via SSE. Calls onEvent for each SSEEvent until 'finish'
// or an abort. Returns when the stream ends.
export async function streamChat(
  body: {
    text: string;
    mode: ChatMode;
    roles?: ModeRoles;
    // Single-AI Agent modes (personal / profession / reasoning) carry
    // exactly one provider here instead of a roles map.
    singleProvider?: AIProvider;
    // Profession persona for `profession` mode (e.g. "醫生", "律師").
    profession?: string;
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
    // Server returns a JSON error body — surface its `message` (lang-aware)
    // or `error` field instead of the raw JSON blob.
    const text = await res.text().catch(() => '');
    let msg = text || `Chat failed: ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      msg = parsed.message || parsed.error || msg;
    } catch {
      // not JSON; keep raw
    }
    throw new Error(msg);
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
