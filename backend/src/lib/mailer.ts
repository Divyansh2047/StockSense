import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { logger } from './logger.js';

/**
 * Outgoing email. Every configured provider is tried in this order until one accepts:
 *   RESEND_API_KEY  - Resend over HTTPS
 *   BREVO_API_KEY   - Brevo over HTTPS
 *   SMTP_HOST       - any SMTP server (Hostinger, Gmail app password, ...), either
 *                     directly or, with MAIL_BRIDGE_URL, through deploy/mail-bridge
 *                     (an HTTPS endpoint on web hosting that speaks SMTP for us)
 * HTTPS matters because some hosts (Render's free tier, for one) block SMTP ports.
 * With nothing configured the message is written to the server log instead.
 */
interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

let smtp: Transporter | null = null;
if (config.smtp.host && !config.mail.bridgeUrl) {
  smtp = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    // fail fast where the port is blocked, so the request does not hang
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}
const bridgeReady = () => Boolean(config.mail.bridgeUrl && config.smtp.host && config.smtp.user && config.smtp.pass);

export type MailProvider = 'resend' | 'brevo' | 'bridge' | 'smtp' | 'log';
export const mailProvider = (): MailProvider =>
  config.mail.resendKey ? 'resend' : config.mail.brevoKey ? 'brevo' : bridgeReady() ? 'bridge' : smtp ? 'smtp' : 'log';
export const mailEnabled = () => mailProvider() !== 'log';

/** "StockSense <no-reply@x.y>" -> { name, email } */
function parseFrom(from: string): { name: string; email: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  return m ? { name: m[1]!.trim() || 'StockSense', email: m[2]!.trim() } : { name: 'StockSense', email: from.trim() };
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Email API ${new URL(url).host} answered ${res.status}: ${detail}`);
  }
}

async function deliverVia(provider: Exclude<MailProvider, 'log'>, mail: Mail): Promise<void> {
  const from = parseFrom(config.mail.from);
  switch (provider) {
    case 'resend':
      return postJson(
        'https://api.resend.com/emails',
        { Authorization: `Bearer ${config.mail.resendKey}` },
        { from: `${from.name} <${from.email}>`, to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text },
      );
    case 'brevo':
      return postJson(
        'https://api.brevo.com/v3/smtp/email',
        { 'api-key': config.mail.brevoKey },
        { sender: from, to: [{ email: mail.to }], subject: mail.subject, htmlContent: mail.html, textContent: mail.text },
      );
    case 'bridge':
      return postJson(config.mail.bridgeUrl, {}, {
        host: config.smtp.host,
        user: config.smtp.user,
        pass: config.smtp.pass,
        from: from.email,
        fromName: from.name,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    case 'smtp':
      await smtp!.sendMail({ from: config.mail.from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
      return;
  }
}

// Subjects carry one-time codes; keep them out of the logs.
const logSubject = (subject: string) => subject.replace(/\d{4,}/g, '######');

/** Every configured provider, in order of preference. */
const providers = (): Exclude<MailProvider, 'log'>[] => [
  ...(config.mail.resendKey ? (['resend'] as const) : []),
  ...(config.mail.brevoKey ? (['brevo'] as const) : []),
  ...(bridgeReady() ? (['bridge'] as const) : []),
  ...(smtp ? (['smtp'] as const) : []),
];

/** Try each provider in turn, so one outage (or an unverified domain) falls through to the next. */
async function deliver(mail: Mail): Promise<void> {
  const list = providers();
  if (!list.length) {
    // Local development: keep flows usable without an inbox.
    if (!config.isTest) logger.warn({ to: mail.to, subject: mail.subject }, `Email not sent (no provider configured):\n${mail.text}`);
    return;
  }
  let lastError: unknown;
  for (const provider of list) {
    try {
      await deliverVia(provider, mail);
      logger.info({ provider, subject: logSubject(mail.subject) }, 'email sent');
      return;
    } catch (err) {
      lastError = err;
      logger.warn({ err, provider, subject: logSubject(mail.subject) }, `email provider ${provider} failed, trying the next one`);
    }
  }
  throw lastError;
}

/** Send without letting a provider outage turn into a 500 for the user. */
export async function sendMail(mail: Mail): Promise<boolean> {
  try {
    await deliver(mail);
    return true;
  } catch (err) {
    logger.error({ err, subject: logSubject(mail.subject) }, 'email delivery failed');
    return false;
  }
}

/* ------------------------------------------------------------------ templates */

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

interface Layout {
  preheader: string;
  heading: string;
  intro: string;
  code?: string;
  button?: { label: string; url: string };
  outro: string;
}

function render(l: Layout): string {
  const codeBlock = l.code
    ? `<tr><td style="padding:8px 32px 4px">
         <div style="font:700 34px/1 'SFMono-Regular',Menlo,Consolas,monospace;letter-spacing:10px;color:#101315;background:#fff4dc;border:1px solid #ffd27a;border-radius:10px;padding:18px 0;text-align:center">${esc(l.code)}</div>
       </td></tr>`
    : '';
  const button = l.button
    ? `<tr><td style="padding:20px 32px 4px">
         <a href="${esc(l.button.url)}" style="display:inline-block;background:#ffb224;color:#101315;font:600 15px/1 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;text-decoration:none;padding:14px 22px;border-radius:8px">${esc(l.button.label)}</a>
         <p style="margin:14px 0 0;font:13px/1.5 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#5b6166">Or paste this link into your browser:<br><a href="${esc(l.button.url)}" style="color:#875800;word-break:break-all">${esc(l.button.url)}</a></p>
       </td></tr>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="color-scheme" content="light"><title>${esc(l.heading)}</title></head>
<body style="margin:0;background:#eef0f1;padding:24px 12px">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(l.preheader)}</span>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #dde1e3">
  <tr><td style="background:#101315;padding:18px 32px">
    <span style="display:inline-block;width:10px;height:10px;background:#ffb224;border-radius:2px;margin-right:8px"></span>
    <span style="font:800 15px/1 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;letter-spacing:2px;color:#ffffff">STOCKSENSE</span>
  </td></tr>
  <tr><td style="padding:28px 32px 6px">
    <h1 style="margin:0 0 10px;font:700 22px/1.3 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#101315">${esc(l.heading)}</h1>
    <p style="margin:0;font:15px/1.6 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#30363a">${l.intro}</p>
  </td></tr>
  ${codeBlock}
  ${button}
  <tr><td style="padding:22px 32px 28px">
    <p style="margin:0;font:13px/1.6 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#5b6166">${l.outro}</p>
  </td></tr>
  <tr><td style="border-top:1px solid #eef0f1;padding:14px 32px;font:12px/1.5 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#8a9094">
    StockSense inventory. You get this email because of an action on your account.
  </td></tr>
</table></td></tr></table></body></html>`;
}

const hello = (name: string) => `Hi ${esc(name || 'there')},`;

export function verificationEmail(to: string, name: string, code: string, link: string, minutes: number, hours: number): Mail {
  return {
    to,
    subject: `${code} is your StockSense verification code`,
    text: [
      `Hi ${name || 'there'},`,
      '',
      `Your StockSense verification code is ${code}. It expires in ${minutes} minutes.`,
      '',
      `Or confirm with this link (valid for ${hours} hours): ${link}`,
      '',
      'If you did not create a StockSense account you can ignore this email.',
    ].join('\n'),
    html: render({
      preheader: `Your code is ${code}`,
      heading: 'Confirm your email',
      intro: `${hello(name)} enter this code on the verification screen. It expires in ${minutes} minutes.`,
      code,
      button: { label: 'Confirm my email', url: link },
      outro: `The button works for ${hours} hours and only once. If you did not create a StockSense account, ignore this email and nothing happens.`,
    }),
  };
}

export function resetEmail(to: string, name: string, code: string, link: string, minutes: number): Mail {
  return {
    to,
    subject: `${code} is your StockSense reset code`,
    text: [
      `Hi ${name || 'there'},`,
      '',
      `Use this code to reset your StockSense password: ${code}`,
      `Or open this link: ${link}`,
      '',
      `Both expire in ${minutes} minutes. If you did not ask for a reset you can ignore this email.`,
    ].join('\n'),
    html: render({
      preheader: `Your reset code is ${code}`,
      heading: 'Reset your password',
      intro: `${hello(name)} someone (hopefully you) asked to reset the password on your StockSense account.`,
      code,
      button: { label: 'Choose a new password', url: link },
      outro: `The code and the link expire in ${minutes} minutes and work once. If this was not you, ignore this email; your password stays the same.`,
    }),
  };
}

export function inviteEmail(to: string, name: string, inviter: string, company: string, loginId: string, link: string, hours: number): Mail {
  return {
    to,
    subject: `${inviter} invited you to ${company} on StockSense`,
    text: [
      `Hi ${name || 'there'},`,
      '',
      `${inviter} added you to ${company} on StockSense. Your Login ID is ${loginId}.`,
      `Set your password here (valid for ${hours} hours): ${link}`,
    ].join('\n'),
    html: render({
      preheader: `Join ${company} on StockSense`,
      heading: `You're invited to ${company}`,
      intro: `${hello(name)} ${esc(inviter)} added you to <b>${esc(company)}</b>. Your Login ID is <b>${esc(loginId)}</b>. Choose a password to get started.`,
      button: { label: 'Set my password', url: link },
      outro: `This link works once and expires in ${hours} hours. Setting a password also confirms this email address.`,
    }),
  };
}

export function passwordChangedEmail(to: string, name: string): Mail {
  const when = new Date().toUTCString();
  return {
    to,
    subject: 'Your StockSense password was changed',
    text: `Hi ${name || 'there'},\n\nThe password on your StockSense account was changed on ${when}. Every other session was signed out.\n\nIf this was not you, reset your password right away from the sign-in page.`,
    html: render({
      preheader: 'Your password was changed',
      heading: 'Password changed',
      intro: `${hello(name)} the password on your StockSense account was changed on ${esc(when)}. Every other session was signed out.`,
      button: { label: 'Open StockSense', url: `${config.appUrl}/app/login` },
      outro: 'If this was not you, use "Forgot password" on the sign-in page right away.',
    }),
  };
}
