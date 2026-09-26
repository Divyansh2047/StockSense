import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../../config.js';
import { many, one, pool, tx } from '../../db/pool.js';
import {
  USER_COLUMNS,
  clearSessionCookie,
  currentUser,
  loadUser,
  publicUser,
  requireAuth,
  setSessionCookie,
  signSession,
  type SessionUser,
} from '../../lib/auth.js';
import { badRequest, conflict, unauthorized } from '../../lib/errors.js';
import { h, parse } from '../../lib/http.js';
import { sendOtpEmail } from '../../lib/mailer.js';

export const authRouter = Router();

/* ------------------------------------------------------------------ rules from the spec */

// Login ID: unique, 6 to 12 characters.
export const loginIdRule = z
  .string({ required_error: 'Enter a Login ID' })
  .trim()
  .min(6, 'Login ID must be 6 to 12 characters')
  .max(12, 'Login ID must be 6 to 12 characters')
  .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore');

// Password: a lowercase letter, an uppercase letter, a special character, more than 8 characters.
export const passwordRule = z
  .string({ required_error: 'Enter a password' })
  .min(9, 'Password must be more than 8 characters')
  .max(128, 'Password is too long')
  .regex(/[a-z]/, 'Add at least one lowercase letter')
  .regex(/[A-Z]/, 'Add at least one uppercase letter')
  .regex(/[^A-Za-z0-9]/, 'Add at least one special character');

const emailRule = z.string({ required_error: 'Enter an email' }).trim().toLowerCase().email('Enter a valid email address').max(254);

const signupSchema = z
  .object({
    loginId: loginIdRule,
    email: emailRule,
    name: z.string().trim().max(80).optional().default(''),
    password: passwordRule,
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' });

const loginSchema = z.object({
  loginId: z.string().trim().min(1, 'Enter your Login ID').max(64),
  password: z.string().min(1, 'Enter your password').max(128),
});

const BCRYPT_ROUNDS = config.isTest ? 4 : 11;
// Compared against when the login id does not exist so response time does not leak it.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isTest ? 1000 : 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many attempts. Please wait a few minutes and try again.' } },
});
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isTest ? 1000 : 8,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many reset requests. Please wait a few minutes and try again.' } },
});

function startSession(res: Parameters<typeof setSessionCookie>[0], user: SessionUser) {
  setSessionCookie(res, signSession(user));
  return { user: publicUser(user) };
}

/* ------------------------------------------------------------------ sign up / in / out */

authRouter.post(
  '/signup',
  authLimiter,
  h(async (req, res) => {
    const input = parse(signupSchema, req.body);
    const hash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    const user = await tx(async (c) => {
      // serialise signups so "first user becomes manager" cannot race
      await c.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      const clashes = await many<{ login: boolean; mail: boolean }>(
        c,
        `SELECT lower(login_id) = lower($1) AS login, lower(email) = lower($2) AS mail
           FROM users WHERE lower(login_id) = lower($1) OR lower(email) = lower($2)`,
        [input.loginId, input.email],
      );
      const fields: Record<string, string> = {};
      if (clashes.some((r) => r.login)) fields.loginId = 'This Login ID is already taken';
      if (clashes.some((r) => r.mail)) fields.email = 'An account with this email already exists';
      if (Object.keys(fields).length) throw conflict('That account already exists.', fields);

      const count = await one<{ n: number }>(c, 'SELECT count(*)::int AS n FROM users');
      const role = count?.n === 0 ? 'manager' : 'staff';
      return one<SessionUser>(
        c,
        `INSERT INTO users (login_id, email, name, password_hash, role)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${USER_COLUMNS}`,
        [input.loginId, input.email, input.name || input.loginId, hash, role],
      );
    });

    res.status(201).json(startSession(res, user!));
  }),
);

authRouter.post(
  '/login',
  authLimiter,
  h(async (req, res) => {
    const input = parse(loginSchema, req.body);
    const row = await one<SessionUser & { passwordHash: string }>(
      pool,
      `SELECT ${USER_COLUMNS}, password_hash AS "passwordHash" FROM users WHERE lower(login_id) = lower($1)`,
      [input.loginId],
    );
    const ok = await bcrypt.compare(input.password, row?.passwordHash ?? DUMMY_HASH);
    if (!row || !ok) throw unauthorized('Invalid Login Id or Password');
    const { passwordHash: _omit, ...user } = row;
    res.json(startSession(res, user));
  }),
);

authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

/* ------------------------------------------------------------------ profile */

authRouter.get(
  '/me',
  requireAuth,
  h(async (req, res) => {
    res.json({ user: publicUser(currentUser(req)) });
  }),
);

const profileSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(80).optional(),
  email: emailRule.optional(),
});

authRouter.patch(
  '/me',
  requireAuth,
  h(async (req, res) => {
    const me = currentUser(req);
    const input = parse(profileSchema, req.body);
    if (input.email) {
      const taken = await one(pool, 'SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2', [input.email, me.id]);
      if (taken) throw conflict('That email is in use.', { email: 'An account with this email already exists' });
    }
    await pool.query('UPDATE users SET name = COALESCE($1, name), email = COALESCE($2, email) WHERE id = $3', [
      input.name ?? null,
      input.email ?? null,
      me.id,
    ]);
    res.json({ user: publicUser((await loadUser(me.id))!) });
  }),
);

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    password: passwordRule,
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' });

authRouter.post(
  '/change-password',
  requireAuth,
  authLimiter,
  h(async (req, res) => {
    const me = currentUser(req);
    const input = parse(changePasswordSchema, req.body);
    const row = await one<{ hash: string }>(pool, 'SELECT password_hash AS hash FROM users WHERE id = $1', [me.id]);
    if (!row || !(await bcrypt.compare(input.currentPassword, row.hash))) {
      throw badRequest('Current password is wrong.', { currentPassword: 'That is not your current password' });
    }
    const hash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    await pool.query('UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2', [hash, me.id]);
    res.json(startSession(res, (await loadUser(me.id))!));
  }),
);

/* ------------------------------------------------------------------ OTP password reset */

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const RESET_TOKEN_TTL = 15 * 60;

const hashOtp = (resetUserId: number, otp: string) =>
  createHmac('sha256', config.jwtSecret).update(`${resetUserId}:${otp}`).digest('hex');

const genericSent = 'If an account exists for that email, a 6-digit code is on its way. It expires in 10 minutes.';

authRouter.post(
  '/forgot-password',
  otpLimiter,
  h(async (req, res) => {
    const { email } = parse(z.object({ email: emailRule }), req.body);
    const user = await one<{ id: number; name: string; email: string }>(
      pool,
      'SELECT id, name, email FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    let devOtp: string | undefined;
    if (user) {
      const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await tx(async (c) => {
        await c.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
        await c.query(
          `INSERT INTO password_resets (user_id, otp_hash, expires_at)
           VALUES ($1, $2, now() + make_interval(mins => $3))`,
          [user.id, hashOtp(user.id, otp), OTP_TTL_MINUTES],
        );
      });
      await sendOtpEmail(user.email, user.name, otp);
      if (config.otpDevEcho) devOtp = otp;
    }
    // Same answer whether or not the account exists.
    res.json({ ok: true, message: genericSent, ...(devOtp ? { devOtp } : {}) });
  }),
);

const verifySchema = z.object({
  email: emailRule,
  otp: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

authRouter.post(
  '/verify-otp',
  otpLimiter,
  h(async (req, res) => {
    const { email, otp } = parse(verifySchema, req.body);
    const invalid = () => badRequest('That code is not valid or has expired.', { otp: 'That code is not valid or has expired' });

    const reset = await one<{ id: number; userId: number; otpHash: string; attempts: number }>(
      pool,
      `SELECT r.id, r.user_id AS "userId", r.otp_hash AS "otpHash", r.attempts
         FROM password_resets r JOIN users u ON u.id = r.user_id
        WHERE lower(u.email) = lower($1) AND r.used_at IS NULL AND r.expires_at > now()
        ORDER BY r.created_at DESC LIMIT 1`,
      [email],
    );
    if (!reset || reset.attempts >= OTP_MAX_ATTEMPTS) throw invalid();

    const expected = Buffer.from(reset.otpHash, 'hex');
    const actual = Buffer.from(hashOtp(reset.userId, otp), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      await pool.query('UPDATE password_resets SET attempts = attempts + 1 WHERE id = $1', [reset.id]);
      throw invalid();
    }
    const resetToken = jwt.sign({ sub: String(reset.userId), rid: reset.id, typ: 'reset' }, config.jwtSecret, {
      expiresIn: RESET_TOKEN_TTL,
      algorithm: 'HS256',
    });
    res.json({ resetToken });
  }),
);

const resetSchema = z
  .object({
    resetToken: z.string().min(10),
    password: passwordRule,
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' });

authRouter.post(
  '/reset-password',
  otpLimiter,
  h(async (req, res) => {
    const input = parse(resetSchema, req.body);
    let claims: { sub: string; rid: number; typ: string };
    try {
      claims = jwt.verify(input.resetToken, config.jwtSecret, { algorithms: ['HS256'] }) as typeof claims;
    } catch {
      throw badRequest('This reset link has expired. Request a new code.');
    }
    if (claims.typ !== 'reset') throw badRequest('Invalid reset token.');
    const hash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const userId = Number(claims.sub);

    await tx(async (c) => {
      const used = await one(
        c,
        `UPDATE password_resets SET used_at = now()
          WHERE id = $1 AND user_id = $2 AND used_at IS NULL RETURNING id`,
        [claims.rid, userId],
      );
      if (!used) throw badRequest('This reset code was already used. Request a new one.');
      await c.query('UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2', [hash, userId]);
    });

    const user = await loadUser(userId);
    if (!user) throw badRequest('Account not found.');
    res.json(startSession(res, user));
  }),
);
