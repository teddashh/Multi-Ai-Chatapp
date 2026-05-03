import nodemailer, { type Transporter } from 'nodemailer';

let cachedTransport: Transporter | null = null;

function getTransport(): Transporter | null {
  if (cachedTransport) return cachedTransport;
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  if (!host || !user || !pass) return null;
  cachedTransport = nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: (process.env.SMTP_SECURE || 'true').toLowerCase() === 'true',
    auth: {
      user,
      // Gmail app passwords are commonly displayed as 4 groups of 4 chars
      // separated by spaces. Strip whitespace defensively.
      pass: pass.replace(/\s+/g, ''),
    },
  });
  return cachedTransport;
}

// Single source of truth for the From header. nodemailer's address-object
// form handles the RFC2047 encoding for non-ASCII display names.
function fromAddress() {
  return {
    name: process.env.SMTP_FROM_NAME || 'Ted Huang (AI Sister / AI 姐妹)',
    address:
      process.env.SMTP_FROM ||
      process.env.SMTP_USER ||
      'no-reply@example.com',
  };
}

// Optional BCC for signup-related events so the operator gets a
// silent copy of every "new user" email. Configured per-instance via
// ADMIN_NOTIFY_EMAIL — leave unset on dev to avoid mailbox noise.
function adminBcc(): string | undefined {
  const v = process.env.ADMIN_NOTIFY_EMAIL?.trim();
  return v && v.includes('@') ? v : undefined;
}

export interface SelfPurgeNotifyParams {
  username: string;
  email: string | null;
  nickname: string | null;
  tier: string;
  createdAt: number;
  minutesAlive: number;
}

// Operator notification when a user self-purges (DELETE /api/auth/me).
// Useful churn signal — especially right after signup, "tried us out for
// 2 minutes and left" tells you something about onboarding friction.
// No-op when ADMIN_NOTIFY_EMAIL isn't set or SMTP isn't configured.
export async function sendSelfPurgeNotification(
  p: SelfPurgeNotifyParams,
): Promise<void> {
  const to = adminBcc();
  if (!to) return;
  const transport = getTransport();
  if (!transport) return;

  const lifeBlurb =
    p.minutesAlive < 5
      ? '⚠️ 註冊不到 5 分鐘就刪除（可能是 onboarding 有問題）'
      : p.minutesAlive < 60
        ? `${p.minutesAlive} 分鐘後刪除`
        : p.minutesAlive < 60 * 24
          ? `${Math.round(p.minutesAlive / 60)} 小時後刪除`
          : `${Math.round(p.minutesAlive / 60 / 24)} 天後刪除`;

  const created = new Date(p.createdAt * 1000).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
  });

  const text = `${BRAND} — 用戶自刪通知

帳號：${p.username}
暱稱：${p.nickname || '(未設定)'}
Email：${p.email || '(未設定)'}
Tier：${p.tier}
註冊時間：${created} (Asia/Taipei)
存活時間：${lifeBlurb}

— 自動通知，無需回覆`;

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,system-ui,sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#1f2937;">
  <h3 style="margin:0 0 8px 0;">${BRAND} — 用戶自刪通知</h3>
  <table style="width:100%;border-collapse:collapse;font-size:13px;margin:12px 0;">
    <tbody>
      <tr><td style="padding:4px 8px;color:#6b7280;">帳號</td><td style="padding:4px 8px;font-family:ui-monospace,monospace;">${p.username}</td></tr>
      <tr><td style="padding:4px 8px;color:#6b7280;">暱稱</td><td style="padding:4px 8px;">${p.nickname || '(未設定)'}</td></tr>
      <tr><td style="padding:4px 8px;color:#6b7280;">Email</td><td style="padding:4px 8px;">${p.email || '(未設定)'}</td></tr>
      <tr><td style="padding:4px 8px;color:#6b7280;">Tier</td><td style="padding:4px 8px;">${p.tier}</td></tr>
      <tr><td style="padding:4px 8px;color:#6b7280;">註冊時間</td><td style="padding:4px 8px;">${created}</td></tr>
      <tr><td style="padding:4px 8px;color:#6b7280;">存活時間</td><td style="padding:4px 8px;font-weight:500;">${lifeBlurb}</td></tr>
    </tbody>
  </table>
  <p style="font-size:11px;color:#9ca3af;margin-top:18px;">完整 metadata 留在 audit_log action='user_self_purge'。</p>
</body></html>`;

  await transport.sendMail({
    from: fromAddress(),
    to,
    subject: `[${BRAND}] 用戶自刪：${p.username}`,
    text,
    html,
  });
}

const BRAND = 'AI Sister / AI 姐妹';
const APP_URL = (process.env.PUBLIC_URL || 'https://chat.ted-h.com').replace(/\/$/, '');

export interface ResetEmailParams {
  to: string;
  nickname: string;
  resetUrl: string;
  reason: 'self_request' | 'auto_lockout';
}

export async function sendResetEmail(p: ResetEmailParams): Promise<void> {
  const transport = getTransport();
  if (!transport) {
    throw new Error('SMTP is not configured (SMTP_HOST/USER/PASSWORD missing)');
  }

  const reasonZh =
    p.reason === 'auto_lockout'
      ? '為了帳號安全，我們在偵測到多次登入失敗後暫時阻擋了登入，請用下方連結重新設定密碼。'
      : '我們收到了你的密碼重設請求。';

  const html = `<!doctype html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; color: #1f2937;">
  <h2 style="color: #111827;">${BRAND} — 密碼重設</h2>
  <p>嗨 ${p.nickname || ''}，</p>
  <p>${reasonZh}</p>
  <p>請點擊下方連結重設你的密碼（1 小時內有效）：</p>
  <p style="margin: 24px 0;">
    <a href="${p.resetUrl}" style="display: inline-block; padding: 10px 16px; background: #2563eb; color: white; text-decoration: none; border-radius: 6px;">重設密碼</a>
  </p>
  <p style="font-size: 12px; color: #6b7280;">如果按鈕沒反應，貼上連結到瀏覽器：<br/><code style="word-break: break-all;">${p.resetUrl}</code></p>
  <p style="font-size: 12px; color: #6b7280;">如果這不是你發起的，忽略此信即可。</p>
</body></html>`;

  const text = `${BRAND} — 密碼重設\n\n嗨 ${p.nickname || ''}，\n\n${reasonZh}\n\n請打開以下連結重設密碼（1 小時內有效）：\n${p.resetUrl}\n\n如果這不是你發起的，忽略此信即可。`;

  await transport.sendMail({
    from: fromAddress(),
    to: p.to,
    subject: `${BRAND} — 密碼重設`,
    text,
    html,
  });
}

export interface VerifyEmailParams {
  to: string;
  nickname: string;
  verifyUrl: string;
}

export async function sendVerifyEmail(p: VerifyEmailParams): Promise<void> {
  const transport = getTransport();
  if (!transport) {
    throw new Error('SMTP is not configured (SMTP_HOST/USER/PASSWORD missing)');
  }

  const html = `<!doctype html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; color: #1f2937;">
  <h2 style="color: #111827;">${BRAND} — 驗證 Email</h2>
  <p>嗨 ${p.nickname || ''}，</p>
  <p>感謝註冊。請點擊下方連結驗證你的 email（24 小時內有效）：</p>
  <p style="margin: 24px 0;">
    <a href="${p.verifyUrl}" style="display: inline-block; padding: 10px 16px; background: #2563eb; color: white; text-decoration: none; border-radius: 6px;">驗證 Email</a>
  </p>
  <p style="font-size: 12px; color: #6b7280;">如果按鈕沒反應，貼上連結到瀏覽器：<br/><code style="word-break: break-all;">${p.verifyUrl}</code></p>
  <p style="font-size: 12px; color: #6b7280;">如果這不是你註冊的，忽略此信即可，帳號 24 小時後會自動失效。</p>
</body></html>`;

  const text = `${BRAND} — 驗證 Email\n\n嗨 ${p.nickname || ''}，\n\n感謝註冊。請打開以下連結驗證你的 email（24 小時內有效）：\n${p.verifyUrl}\n\n如果這不是你註冊的，忽略此信即可。`;

  await transport.sendMail({
    from: fromAddress(),
    to: p.to,
    bcc: adminBcc(),
    subject: `${BRAND} — 請驗證 Email`,
    text,
    html,
  });
}

export interface InviteEmailParams {
  to: string;
  // Display-friendly name to greet the recipient with — typically their
  // real_name or nickname as set by the admin.
  greetingName: string;
  // Optional inviter display name — admin's nickname/real_name. If null we
  // fall back to "管理員".
  inviterName: string | null;
  // The set-your-password link the admin sees + we email.
  setupUrl: string;
}

export async function sendInviteEmail(p: InviteEmailParams): Promise<void> {
  const transport = getTransport();
  if (!transport) {
    throw new Error('SMTP is not configured (SMTP_HOST/USER/PASSWORD missing)');
  }

  const inviter = p.inviterName || '管理員';

  // The text/html bodies are deliberately a *welcome* invitation — not a
  // password-reset clone — so recipients don't think their account was
  // compromised. We do still need them to set a password via the link, but
  // that's framed as "set up your account" not "your password got reset".
  const html = `<!doctype html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; color: #1f2937;">
  <h2 style="color: #111827;">歡迎加入 ${BRAND}</h2>
  <p>嗨 ${p.greetingName || ''}，</p>
  <p><b>${inviter}</b> 邀請你使用 ${BRAND} — 一個能同時跟 Claude / Gemini / Grok / ChatGPT 四家 AI 對話、辯論、做決策的平台。</p>
  <p>點下方按鈕設定你的密碼，完成後就能登入開始使用（連結 7 天內有效）：</p>
  <p style="margin: 24px 0;">
    <a href="${p.setupUrl}" style="display: inline-block; padding: 10px 16px; background: #2563eb; color: white; text-decoration: none; border-radius: 6px;">建立帳號 · Set Password</a>
  </p>
  <p style="font-size: 13px; color: #4b5563;">登入後你可以：</p>
  <ul style="font-size: 13px; color: #4b5563; line-height: 1.6;">
    <li>同時看四家 AI 對同一個問題的回答</li>
    <li>讓它們互相辯論、審查、收斂出比較完整的答案</li>
    <li>上傳圖片、PDF、文字檔給它們一起看</li>
  </ul>
  <p style="font-size: 12px; color: #6b7280;">如果按鈕沒反應，貼上連結到瀏覽器：<br/><code style="word-break: break-all;">${p.setupUrl}</code></p>
  <p style="font-size: 12px; color: #6b7280;">如果你不認識邀請人，忽略此信即可，帳號不會啟用。</p>
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
  <p style="font-size: 11px; color: #9ca3af;">— ${BRAND} (${APP_URL})</p>
</body></html>`;

  const text = `歡迎加入 ${BRAND}

嗨 ${p.greetingName || ''}，

${inviter} 邀請你使用 ${BRAND} — 一個能同時跟 Claude / Gemini / Grok / ChatGPT 對話的 AI 平台。

請點以下連結設定你的密碼，完成後就能登入（連結 7 天內有效）：
${p.setupUrl}

如果你不認識邀請人，忽略此信即可，帳號不會啟用。

— ${BRAND}
${APP_URL}`;

  await transport.sendMail({
    from: fromAddress(),
    to: p.to,
    subject: `${inviter} 邀請你加入 ${BRAND}`,
    text,
    html,
  });
}

export interface FallbackDigestRow {
  timestamp: number;
  user: string;
  sessionId: string | null;
  provider: string;
  primaryModel: string | null;
  journey: Array<{ stage: string; outcome: string; model?: string; error?: string }>;
}

export interface FallbackDigestParams {
  to: string[];
  instance: 'prod' | 'dev';
  windowMinutes: number;
  rows: FallbackDigestRow[];
}

// Hourly summary of model fallback events for admins. Subject line is
// instance-tagged ([prod] / [dev]) so the two flows don't blend in the
// inbox. Skipped silently when there are no events — the scheduler is the
// gate, not this function. We mark text/html as best-effort: if SMTP isn't
// configured we just log and move on (a fallback flood + broken SMTP
// shouldn't tank the server boot).
export async function sendFallbackDigest(p: FallbackDigestParams): Promise<void> {
  const transport = getTransport();
  if (!transport) {
    console.warn('[digest] SMTP not configured; skipping send');
    return;
  }
  if (p.rows.length === 0 || p.to.length === 0) return;

  const tag = p.instance === 'prod' ? 'prod' : 'dev';
  const subject = `[${tag}] AI Sister fallback digest — ${p.rows.length} event${p.rows.length === 1 ? '' : 's'} in last ${p.windowMinutes}m`;

  const fmtTime = (ts: number) =>
    new Date(ts * 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

  const journeyLine = (j: FallbackDigestRow['journey']) =>
    j.map((s) => `${s.stage}=${s.outcome}${s.error ? `(${s.error})` : ''}`).join(' → ');

  const auditUrl = `${APP_URL}/admin`;

  const textLines: string[] = [
    `${p.rows.length} model_fallback event(s) in the last ${p.windowMinutes} minutes on ${tag}.`,
    '',
  ];
  for (const r of p.rows) {
    textLines.push(`[${fmtTime(r.timestamp)}] ${r.user} · ${r.provider}`);
    textLines.push(`  primary: ${r.primaryModel ?? '-'}`);
    textLines.push(`  journey: ${journeyLine(r.journey)}`);
    if (r.sessionId) textLines.push(`  session: ${r.sessionId}`);
    textLines.push('');
  }
  textLines.push(`Full audit log: ${auditUrl}`);

  const rowsHtml = p.rows
    .map(
      (r) => `<tr>
  <td style="padding:6px 10px; border-bottom:1px solid #eee; white-space:nowrap; font-family:ui-monospace,monospace; font-size:12px;">${fmtTime(r.timestamp)}</td>
  <td style="padding:6px 10px; border-bottom:1px solid #eee; font-size:12px;">${r.user}</td>
  <td style="padding:6px 10px; border-bottom:1px solid #eee; font-size:12px;">${r.provider}</td>
  <td style="padding:6px 10px; border-bottom:1px solid #eee; font-family:ui-monospace,monospace; font-size:11px;">${r.primaryModel ?? '-'}</td>
  <td style="padding:6px 10px; border-bottom:1px solid #eee; font-family:ui-monospace,monospace; font-size:11px;">${journeyLine(r.journey)}</td>
</tr>`,
    )
    .join('\n');

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,system-ui,sans-serif; max-width:780px; margin:0 auto; padding:20px; color:#1f2937;">
  <h3 style="margin:0 0 8px 0;">[${tag}] Fallback digest — ${p.rows.length} event${p.rows.length === 1 ? '' : 's'} in last ${p.windowMinutes}m</h3>
  <p style="font-size:12px; color:#6b7280; margin:0 0 16px 0;">${BRAND}</p>
  <p style="margin:0 0 16px 0;">
    <a href="${auditUrl}" style="display:inline-block; padding:8px 14px; background:#2563eb; color:#fff; text-decoration:none; border-radius:6px; font-size:13px; font-weight:500;">開啟稽核紀錄</a>
  </p>
  <table style="width:100%; border-collapse:collapse; font-size:12px;">
    <thead><tr style="background:#f3f4f6;">
      <th style="padding:8px 10px; text-align:left;">Time</th>
      <th style="padding:8px 10px; text-align:left;">User</th>
      <th style="padding:8px 10px; text-align:left;">Provider</th>
      <th style="padding:8px 10px; text-align:left;">Primary</th>
      <th style="padding:8px 10px; text-align:left;">Journey</th>
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <p style="font-size:11px; color:#9ca3af; margin-top:18px;">
    Sent from <a href="${APP_URL}" style="color:#9ca3af;">${APP_URL}</a> · <a href="${auditUrl}" style="color:#2563eb;">/admin → 稽核紀錄</a>
  </p>
</body></html>`;

  await transport.sendMail({
    from: fromAddress(),
    to: p.to.join(', '),
    subject,
    text: textLines.join('\n'),
    html,
  });
}
