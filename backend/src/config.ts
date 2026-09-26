import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env from backend/ first, then the repo root, without overriding real env vars.
for (const rel of ['../.env', '../../.env']) {
  const file = fileURLToPath(new URL(rel, import.meta.url));
  if (existsSync(file)) dotenv.config({ path: file, override: false });
}

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1).default('postgres://stocksense:stocksense@127.0.0.1:5432/stocksense'),
  DATABASE_SSL: bool,
  JWT_SECRET: z.string().optional(),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.string().default('loopback'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_FROM: z.string().default(''),
  // HTTPS email APIs (work on hosts that block SMTP ports). The first one set wins.
  RESEND_API_KEY: z.string().default(''),
  BREVO_API_KEY: z.string().default(''),
  MAIL_FROM: z.string().default(''),
  // HTTPS endpoint that relays SMTP (deploy/mail-bridge), for hosts that block SMTP ports.
  MAIL_BRIDGE_URL: z.string().url().or(z.literal('')).default(''),
  // Public address of the app, used for links in emails.
  APP_URL: z.string().default(''),
  OTP_DEV_ECHO: bool,
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  SEED_DEMO: bool,
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
const env = parsed.data;
const isProd = env.NODE_ENV === 'production';

let jwtSecret = env.JWT_SECRET ?? '';
if (jwtSecret && jwtSecret.length < 32) {
  console.error('JWT_SECRET must be at least 32 characters.');
  process.exit(1);
}
// Without JWT_SECRET, production generates one on first boot and keeps it in the
// database (see loadStoredSecret in src/db/secrets.ts), so nobody has to handle it.
const jwtSecretFromDb = !jwtSecret && isProd;
if (!jwtSecret) {
  // Placeholder until the stored secret loads; development keeps this ephemeral one.
  jwtSecret = randomBytes(48).toString('base64url');
  if (env.NODE_ENV === 'development') {
    console.warn('JWT_SECRET is not set; using a temporary secret for this process.');
  }
}

export const config = {
  env: env.NODE_ENV,
  isProd,
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  databaseSsl: env.DATABASE_SSL,
  jwtSecret,
  jwtSecretFromDb,
  corsOrigins: env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  // "true", a hop count like "1", or a list of addresses/subnets ("loopback, 10.0.0.0/8")
  trustProxy: env.TRUST_PROXY === 'true' ? true : /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY,
  logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : isProd ? 'info' : 'debug'),
  smtp: {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
  },
  mail: {
    resendKey: env.RESEND_API_KEY,
    brevoKey: env.BREVO_API_KEY,
    bridgeUrl: env.MAIL_BRIDGE_URL,
    from: env.MAIL_FROM || env.SMTP_FROM || 'StockSense <no-reply@stocksense.local>',
  },
  appUrl: (env.APP_URL || `http://localhost:${env.NODE_ENV === 'production' ? env.PORT : 5173}`).replace(/\/+$/, ''),
  // Secure cookies, HSTS and https upgrades. On by default in production; set
  // COOKIE_SECURE=false only when serving plain http (a local docker demo).
  secureTransport: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd,
  seedDemo: env.SEED_DEMO,
  // Never echo OTPs in production, whatever the flag says.
  otpDevEcho: env.OTP_DEV_ECHO && !isProd,
};

/** Called once at boot when the secret comes from the database. */
export function setJwtSecret(secret: string): void {
  config.jwtSecret = secret;
}
