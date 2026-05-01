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
  | 'spring'
  | 'summer'
  | 'fall'
  | 'winter'
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
  // Compact price label per model SKU — "$5/$30 /M" for text models,
  // "$0.07/img" for image models. Server-built from prices.ts so the
  // client doesn't drift from the source of truth. Empty string when
  // we have no quote for that SKU.
  priceLabels: Record<string, string>;
  // Self-edited public bio shown on the user's forum profile page.
  // Empty string when not set.
  bio: string;
  // Birth + astrology + MBTI. /me always includes the raw values so
  // the user can see their own data; the show* flags only gate the
  // public /forum/user/<username> response.
  birthAt: number | null;     // UTC unix seconds
  birthTz: string | null;     // IANA zone
  sunSign: string | null;
  moonSign: string | null;
  risingSign: string | null;
  mbti: string | null;
  showBirthday: boolean;
  showBirthTime: boolean;
  showMbti: boolean;
  showSigns: boolean;
  showBirthYear: boolean;
  // Persona dice seed — null until the user has rolled. Decoded
  // client-side via personaMatrix.ts to pick one of 5 variant
  // phrasings per matrix cell.
  personaSeed: number | null;
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
  bio?: string;
  birthAt?: number | null;
  birthTz?: string | null;
  sunSign?: string | null;
  moonSign?: string | null;
  risingSign?: string | null;
  mbti?: string | null;
  showBirthday?: boolean;
  showBirthTime?: boolean;
  showMbti?: boolean;
  showSigns?: boolean;
  showBirthYear?: boolean;
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

// Roll the persona dice — server picks a fresh seed, charges the user
// a synthetic LLM-call cost, and returns the updated user. Errors
// (typically 400 "fill in birth + MBTI first") propagate via .message.
export async function rollPersona(): Promise<User> {
  const res = await fetch('/api/auth/persona/roll', {
    method: 'POST',
    credentials: 'include',
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
  // Soft-disabled timestamp (epoch seconds) or null when active.
  disabled_at: number | null;
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

// Permanently delete the caller's account and every row tied to it.
// Documented to users on /data-deletion. Requires re-typing username and
// password as a guardrail against accidental clicks. Server returns
// 200 on success, 401 / 400 / 404 with an error message otherwise.
export async function purgeAccount(payload: {
  password: string;
  confirmUsername: string;
}): Promise<void> {
  const res = await fetch('/api/auth/me', {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Delete failed: ${res.status}`);
  }
}

// Soft-disable (停用) the caller's account. Less destructive than
// purgeAccount: data stays, but the account can't sign in until support
// re-enables it. Cookie is cleared by the server on success.
export async function disableMyAccount(payload: {
  password: string;
}): Promise<void> {
  const res = await fetch('/api/auth/me/disable', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Disable failed: ${res.status}`);
  }
}

// Admin-side soft disable / re-enable for any user. Requires admin tier.
export async function adminSetUserDisabled(
  username: string,
  disabled: boolean,
): Promise<{ ok: true; disabledAt: number | null }> {
  const res = await fetch(
    `/api/admin/users/${encodeURIComponent(username)}/disabled`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled }),
    },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `${res.status}`);
  }
  return res.json() as Promise<{ ok: true; disabledAt: number | null }>;
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
  replies: ForumCommentReply[];
}

// PTT-style reply attached to a comment. vote='up' = 推 (+1 ❤), 'down'
// = 噓 (-1 ❤), 'none' = → (just text). Multiple 'none' replies allowed
// per user; ±-votes are gated to one per user per parent comment.
export interface ForumCommentReply {
  id: number;
  vote: 'up' | 'down' | 'none';
  body: string;
  createdAt: number;
  authorUsername: string;
  authorDisplay: string;
  authorAvatarPath: string | null;
}

export interface PostCommentReplyResult {
  ok: true;
  replyId: number;
  effectiveVote: 'up' | 'down' | 'none';
  voteOverridden: { previousVote: 'up' | 'down' } | null;
}

export async function postCommentReply(
  commentId: number,
  body: { vote: 'up' | 'down' | 'none'; body: string },
): Promise<PostCommentReplyResult> {
  const res = await fetch(`/api/forum/comments/${commentId}/replies`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `${res.status}`);
  }
  return res.json() as Promise<PostCommentReplyResult>;
}

export async function deleteCommentReply(
  commentId: number,
  replyId: number,
): Promise<void> {
  const res = await fetch(
    `/api/forum/comments/${commentId}/replies/${replyId}`,
    { method: 'DELETE', credentials: 'include' },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `${res.status}`);
  }
}

export interface AIProfileResponse {
  provider: AIProvider;
  // Tier badge — AIs are 'admin' tier per spec.
  tier: 'admin';
  // Hardcoded astrology / MBTI / archetype — same shape as user
  // profile but always public (no visibility flag for AIs).
  birthAt: number | null;
  birthTz: string | null;
  showBirthTime: boolean;
  showBirthYear: boolean;
  sunSign: string | null;
  moonSign: string | null;
  risingSign: string | null;
  mbti: string | null;
  archetype: string | null;
  archetypeNote: string | null;
  stats: {
    totalComments: number;
    totalLikes: number;
    // Lifetime usage across every user that hit this provider.
    totalTokens: number;
    totalCalls: number;
    totalCost: number;
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

export interface UserProfileResponse {
  username: string;
  nickname: string | null;
  hasAvatar: boolean;
  memberSince: number;
  tier: Tier;
  bio: string;
  // Visibility-gated fields — null when the user has hidden them.
  // The `showBirthTime` flag is included separately so the UI can
  // render "1990/01/15" vs "1990/01/15 14:30" based on whether the
  // user opted to expose the time.
  birthAt: number | null;
  birthTz: string | null;
  showBirthTime: boolean;
  showBirthYear: boolean;
  sunSign: string | null;
  moonSign: string | null;
  risingSign: string | null;
  mbti: string | null;
  // Null when the user hasn't rolled the persona dice yet — the
  // archetype line is hidden client-side in that case.
  personaSeed: number | null;
  stats: {
    totalPosts: number;
    totalComments: number;
    totalLikes: number;
    // Lifetime API usage by this user.
    totalTokens: number;
    totalCalls: number;
    totalCost: number;
  };
  recentPosts: Array<{
    id: number;
    title: string;
    category: string;
    bodyPreview: string;
    thumbsCount: number;
    commentCount: number;
    createdAt: number;
  }>;
  recentComments: Array<{
    id: number;
    body: string;
    thumbsCount: number;
    createdAt: number;
    postId: number;
    postTitle: string;
    postCategory: string;
  }>;
}

export async function getUserProfile(
  username: string,
): Promise<UserProfileResponse> {
  const res = await fetch(`/api/forum/user/${encodeURIComponent(username)}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<UserProfileResponse>;
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
  // Filter by source chat mode (free/debate/consult/coding/...)
  // Backs the breadcrumb's "多方諮詢" link on the post detail page.
  mode?: string;
  page?: number;
  // 'latest' default — 'trending' is global only (server ignores it
  // when category is set so the per-看板 list stays chronological).
  sort?: 'latest' | 'trending';
  // 1–50, defaults to server PAGE_SIZE (20). Used by the homepage
  // sections — 6 collapsed, 15 when "查看全部" is clicked.
  limit?: number;
}): Promise<{ posts: ForumPostSummary[]; page: number; pageSize: number }> {
  const params = new URLSearchParams();
  if (opts.category) params.set('category', opts.category);
  if (opts.mode) params.set('mode', opts.mode);
  if (opts.page) params.set('page', String(opts.page));
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.limit) params.set('limit', String(opts.limit));
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

// Bulk-fetch posts by id, preserving the order the caller sent. Used
// by the homepage "你剛看過" row which keeps recently-viewed ids in
// localStorage and asks the server for fresh post-summary data so
// counts (likes / comments) stay current.
export async function bulkFetchForumPosts(
  ids: number[],
): Promise<ForumPostSummary[]> {
  if (ids.length === 0) return [];
  const qs = `ids=${ids.join(',')}`;
  const res = await fetch(`/api/forum/bulk?${qs}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status}`);
  const data = (await res.json()) as { posts: ForumPostSummary[] };
  return data.posts;
}

// Per-AI stats inlined on the post-detail response — feeds the
// comment hover card without a fetch per comment.
export interface AIStat {
  totalComments: number;
  totalLikes: number;
  totalTokens: number;
  totalCalls: number;
  totalCost: number;
}
export type AIStatsMap = Record<AIProvider, AIStat>;

// Per-user stats inlined on the post-detail response — feeds the user
// hover card. Keyed by username; only non-anonymous participants are
// included.
export interface UserStat {
  username: string;
  nickname: string | null;
  tier: Tier;
  hasAvatar: boolean;
  memberSince: number;
  totalPosts: number;
  totalComments: number;
  totalLikes: number;
  totalTokens: number;
  totalCalls: number;
  totalCost: number;
}

export async function getForumPost(
  postId: number,
): Promise<{
  post: ForumPostDetail;
  comments: ForumComment[];
  aiStats: AIStatsMap;
  userStats: Record<string, UserStat>;
}> {
  const res = await fetch(`/api/forum/${postId}`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<{
    post: ForumPostDetail;
    comments: ForumComment[];
    aiStats: AIStatsMap;
    userStats: Record<string, UserStat>;
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
