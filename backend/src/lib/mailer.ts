import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { logger } from './logger.js';

let transport: Transporter | null = null;
if (config.smtp.host) {
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

export const mailEnabled = () => transport !== null;

export async function sendOtpEmail(to: string, name: string, otp: string): Promise<void> {
  const subject = `${otp} is your StockSense reset code`;
  const text = [
    `Hi ${name || 'there'},`,
    '',
    `Use this code to reset your StockSense password: ${otp}`,
    '',
    'It expires in 10 minutes. If you did not ask for a reset you can ignore this email.',
  ].join('\n');

  if (!transport) {
    // No SMTP configured: keep local development unblocked.
    if (!config.isTest) logger.warn({ to }, `SMTP not configured. Password reset code for ${to}: ${otp}`);
    return;
  }
  await transport.sendMail({ from: config.smtp.from, to, subject, text });
}
