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
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@example.com';

  const reasonZh =
    p.reason === 'auto_lockout'
      ? '由於連續 3 次密碼錯誤，帳號已暫時鎖定。'
      : '你（或某人冒用你的身份）發起了密碼重設請求。';

  const html = `<!doctype html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; color: #1f2937;">
  <h2 style="color: #111827;">Multi-AI Chat 密碼重設</h2>
  <p>嗨 ${p.nickname || ''}，</p>
  <p>${reasonZh}</p>
  <p>請點擊下方連結重設你的密碼（1 小時內有效）：</p>
  <p style="margin: 24px 0;">
    <a href="${p.resetUrl}" style="display: inline-block; padding: 10px 16px; background: #2563eb; color: white; text-decoration: none; border-radius: 6px;">重設密碼</a>
  </p>
  <p style="font-size: 12px; color: #6b7280;">如果按鈕沒反應，貼上連結到瀏覽器：<br/><code style="word-break: break-all;">${p.resetUrl}</code></p>
  <p style="font-size: 12px; color: #6b7280;">如果這不是你發起的，忽略此信即可。</p>
</body></html>`;

  const text = `Multi-AI Chat 密碼重設\n\n嗨 ${p.nickname || ''}，\n\n${reasonZh}\n\n請打開以下連結重設密碼（1 小時內有效）：\n${p.resetUrl}\n\n如果這不是你發起的，忽略此信即可。`;

  await transport.sendMail({
    from,
    to: p.to,
    subject: 'Multi-AI Chat — 密碼重設',
    text,
    html,
  });
}
