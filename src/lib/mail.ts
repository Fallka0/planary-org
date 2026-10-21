// E-mail through Resend. Without RESEND_API_KEY every mail is skipped and logged.

import type { Env } from '../env';

export interface Mail {
  to: string | string[];
  subject: string;
  text: string;
  replyTo?: string;
}

export const mailConfigured = (env: Env) => Boolean(env.RESEND_API_KEY);

/** Sends one mail. Returns true when Resend accepted it; never throws. */
export async function sendMail(env: Env, mail: Mail): Promise<boolean> {
  const to = (Array.isArray(mail.to) ? mail.to : [mail.to]).filter(Boolean);
  if (to.length === 0) return false;
  if (!env.RESEND_API_KEY) {
    console.log(`mail skipped (RESEND_API_KEY not set): "${mail.subject}" to ${to.length} recipient(s)`);
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM || 'Planary <info@planary.ch>',
        to,
        subject: mail.subject,
        text: mail.text,
        ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
      }),
    });
    if (!res.ok) {
      console.log(`mail failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (error) {
    console.log(`mail failed: ${error}`);
    return false;
  }
}
