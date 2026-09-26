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
  SMTP_FROM: z.string().default('StockSense <no-reply@stocksense.local>'),
  OTP_DEV_ECHO: bool,
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
const env = parsed.data;
const isProd = env.NODE_ENV === 'production';

let jwtSecret = env.JWT_SECRET ?? '';
if (jwtSecret.length < 32) {
  if (isProd) {
    console.error('JWT_SECRET must be set to at least 32 characters in production.');
    process.exit(1);
  }
  // Development convenience: an ephemeral secret. Sessions reset when the server restarts.
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
  corsOrigins: env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  trustProxy: env.TRUST_PROXY,
  logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : isProd ? 'info' : 'debug'),
  smtp: {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.SMTP_FROM,
  },
  // Never echo OTPs in production, whatever the flag says.
  otpDevEcho: env.OTP_DEV_ECHO && !isProd,
} as const;
