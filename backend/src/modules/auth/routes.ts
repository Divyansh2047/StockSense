import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../../config.js';
import { asCompany, asSystem, many, one, pool, tx, type Client } from '../../db/pool.js';
import {
  USER_COLUMNS,
  USER_FROM,
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
import { logger } from '../../lib/logger.js';
import { passwordChangedEmail, resetEmail, sendMail, verificationEmail } from '../../lib/mailer.js';
import { createCompany, createSandbox } from '../company/service.js';

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

export const emailRule = z.string({ required_error: 'Enter an email' }).trim().toLowerCase().email('Enter a valid email address').max(254);

const signupSchema = z
  .object({
    companyName: z.string().trim().min(2, 'Enter your company name').max(80),
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

export const BCRYPT_ROUNDS = config.isTest ? 4 : 11;
// Compared against when the login id does not exist so response time does not leak it.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

const limiter = (limit: number, message: string, windowMinutes = 15) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit: config.isTest ? 10_000 : limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'rate_limited', message } },
  });
const authLimiter = limiter(30, 'Too many attempts. Please wait a few minutes and try again.');
const codeLimiter = limiter(12, 'Too many code requests. Please wait a few minutes and try again.');
const demoLimiter = limiter(12, 'Too many demo workspaces from this network. Try again in an hour.', 60);

function startSession(res: Response, user: SessionUser) {
  setSessionCookie(res, signSession(user));
  return { user: publicUser(user) };
}

/* ------------------------------------------------------------------ one-time secrets */

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const VERIFY_LINK_HOURS = 24;
const RESEND_COOLDOWN_SECONDS = 60;
export const INVITE_LINK_HOURS = 72;
const RESET_TOKEN_TTL = 15 * 60;

const hmac = (purpose: string, value: string) => createHmac('sha256', config.jwtSecret).update(`${purpose}:${value}`).digest('hex');
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
const newToken = () => randomBytes(32).toString('base64url');

function sameHash(expectedHex: string, actualHex: string): boolean {
  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(actualHex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** j***n@example.com - enough to recognise, not enough to harvest. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const shown = local.length <= 2 ? local[0] ?? '' : `${local[0]}${'*'.repeat(Math.min(local.length - 2, 6))}${local.at(-1)}`;
  return `${shown}@${domain}`;
}

interface Account {
  id: number;
  companyId: number;
  name: string;
  email: string;
  verified: boolean;
}
const ACCOUNT_COLUMNS = `id, company_id AS "companyId", name, email, (email_verified_at IS NOT NULL) AS verified`;

/**
 * Issue a verification email unless one went out in the last minute. Returns how long
 * until another may be sent, plus the code itself when OTP_DEV_ECHO is on.
 */
async function issueVerification(account: Account): Promise<{ resendIn: number; devCode?: string; devLink?: string; sent: boolean }> {
  return asCompany(account.companyId, async () => {
    const last = await one<{ age: number }>(
      pool,
      `SELECT extract(epoch FROM now() - created_at)::int AS age FROM email_verifications
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [account.id],
    );
    if (last && last.age < RESEND_COOLDOWN_SECONDS) return { resendIn: RESEND_COOLDOWN_SECONDS - last.age, sent: false };

    const code = newCode();
    const token = newToken();
    await tx(async (c) => {
      await c.query('UPDATE email_verifications SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [account.id]);
      await c.query(
        `INSERT INTO email_verifications (user_id, email, code_hash, token_hash, code_expires_at, link_expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5), now() + make_interval(hours => $6))`,
        [account.id, account.email, hmac(`verify:${account.id}`, code), hmac('verify-link', token), OTP_TTL_MINUTES, VERIFY_LINK_HOURS],
      );
    });
    const link = `${config.appUrl}/app/verify?token=${token}`;
    const sent = await sendMail(verificationEmail(account.email, account.name, code, link, OTP_TTL_MINUTES, VERIFY_LINK_HOURS));
    return { resendIn: RESEND_COOLDOWN_SECONDS, sent, ...(config.otpDevEcho ? { devCode: code, devLink: link } : {}) };
  });
}

/** Mark the address confirmed and hand back a signed-in session. */
async function completeVerification(c: Client, verificationId: number, userId: number, email: string): Promise<boolean> {
  const used = await one(c, 'UPDATE email_verifications SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id', [verificationId]);
  if (!used) return false;
  // only confirm the address the email was actually sent to
  const updated = await one(
    c,
    'UPDATE users SET email_verified_at = now() WHERE id = $1 AND lower(email) = lower($2) RETURNING id',
    [userId, email],
  );
  return Boolean(updated);
}

/* ------------------------------------------------------------------ sign up */

// Every sign-up creates a new company (workspace) with the new user as its manager.
// Teammates join through invitations from the Team page instead.
authRouter.post(
  '/signup',
  authLimiter,
  h(async (req, res) => {
    const input = parse(signupSchema, req.body);
    const hash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    const account = await asSystem(() =>
      tx(async (c) => {
        const clashes = await many<{ login: boolean; mail: boolean }>(
          c,
          `SELECT lower(login_id) = lower($1) AS login, lower(email) = lower($2) AS mail
             FROM users WHERE lower(login_id) = lower($1) OR lower(email) = lower($2)`,
          [input.loginId, input.email],
        );
        const fields: Record<string, string> = {};
        if (clashes.some((r) => r.login)) fields.loginId = 'This Login ID is already taken';
        if (clashes.some((r) => r.mail)) fields.email = 'An account with this email already exists. Sign in instead.';
        if (Object.keys(fields).length) throw conflict('That account already exists.', fields);

        await createCompany(c, input.companyName);
        return one<Account>(
          c,
          `INSERT INTO users (login_id, email, name, password_hash, role)
           VALUES ($1, $2, $3, $4, 'manager') RETURNING ${ACCOUNT_COLUMNS}`,
          [input.loginId, input.email, input.name || input.loginId, hash],
        );
      }),
    );

    const issued = await issueVerification(account!);
    res.status(201).json({
      verification: { email: account!.email, masked: maskEmail(account!.email), resendIn: issued.resendIn, sent: issued.sent },
      ...(issued.devCode ? { devCode: issued.devCode, devLink: issued.devLink } : {}),
    });
  }),
);

/* ------------------------------------------------------------------ email verification */

const verifyCodeSchema = z.object({
  email: emailRule,
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

authRouter.post(
  '/verify-email',
  codeLimiter,
  h(async (req, res) => {
    const { email, code } = parse(verifyCodeSchema, req.body);
    const invalid = () => badRequest('That code is not valid or has expired.', { code: 'That code is not valid or has expired' });

    const user = await asSystem(async () => {
      const row = await one<{ id: number; userId: number; codeHash: string; attempts: number; email: string }>(
        pool,
        `SELECT v.id, v.user_id AS "userId", v.code_hash AS "codeHash", v.attempts, v.email
           FROM email_verifications v JOIN users u ON u.id = v.user_id
          WHERE lower(u.email) = lower($1) AND lower(v.email) = lower($1)
            AND v.used_at IS NULL AND v.code_expires_at > now()
          ORDER BY v.created_at DESC LIMIT 1`,
        [email],
      );
      if (!row || row.attempts >= OTP_MAX_ATTEMPTS) throw invalid();
      if (!sameHash(row.codeHash, hmac(`verify:${row.userId}`, code))) {
        await pool.query('UPDATE email_verifications SET attempts = attempts + 1 WHERE id = $1', [row.id]);
        throw invalid();
      }
      const ok = await tx((c) => completeVerification(c, row.id, row.userId, row.email));
      if (!ok) throw invalid();
      return loadUser(row.userId);
    });
    if (!user) throw invalid();
    res.json(startSession(res, user));
  }),
);

// The emailed link opens the app, which posts the token here. A POST (not a GET on the
// link itself) keeps mail scanners that prefetch links from using it up.
authRouter.post(
  '/verify-email/link',
  codeLimiter,
  h(async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(20).max(200) }), req.body);
    const user = await asSystem(async () => {
      const row = await one<{ id: number; userId: number; email: string }>(
        pool,
        `SELECT id, user_id AS "userId", email FROM email_verifications
          WHERE token_hash = $1 AND used_at IS NULL AND link_expires_at > now()`,
        [hmac('verify-link', token)],
      );
      if (!row) return undefined;
      const ok = await tx((c) => completeVerification(c, row.id, row.userId, row.email));
      return ok ? loadUser(row.userId) : undefined;
    });
    if (!user) throw badRequest('This link has expired or was already used. Sign in to get a new code.');
    res.json(startSession(res, user));
  }),
);

authRouter.post(
  '/resend-verification',
  codeLimiter,
  h(async (req, res) => {
    const { email } = parse(z.object({ email: emailRule }), req.body);
    const account = await asSystem(() =>
      one<Account>(pool, `SELECT ${ACCOUNT_COLUMNS} FROM users WHERE lower(email) = lower($1)`, [email]),
    );
    // Same answer whether or not the account exists (or is already verified).
    let resendIn = RESEND_COOLDOWN_SECONDS;
    let devCode: string | undefined;
    if (account && !account.verified) {
      const issued = await issueVerification(account);
      resendIn = issued.resendIn;
      devCode = issued.devCode;
    }
    res.json({ ok: true, resendIn, ...(devCode ? { devCode } : {}) });
  }),
);

/* ------------------------------------------------------------------ sign in / out */

authRouter.post(
  '/login',
  authLimiter,
  h(async (req, res) => {
    const input = parse(loginSchema, req.body);
    const row = await asSystem(() =>
      one<SessionUser & { passwordHash: string; verifiedAt: string | null }>(
        pool,
        `SELECT ${USER_COLUMNS}, u.password_hash AS "passwordHash" FROM ${USER_FROM} WHERE lower(u.login_id) = lower($1)`,
        [input.loginId],
      ),
    );
    const ok = await bcrypt.compare(input.password, row?.passwordHash ?? DUMMY_HASH);
    if (!row || !ok) throw unauthorized('Invalid Login Id or Password');
    const { passwordHash: _omit, ...user } = row;

    if (!user.emailVerified) {
      // Right password, unconfirmed email: send a fresh code and send them to verify.
      const issued = await issueVerification({ id: user.id, companyId: user.companyId, name: user.name, email: user.email, verified: false });
      return void res.status(403).json({
        error: {
          code: 'email_unverified',
          message: 'Confirm your email to sign in. We sent a new code.',
          verification: { email: user.email, masked: maskEmail(user.email), resendIn: issued.resendIn, sent: issued.sent },
          ...(issued.devCode ? { devCode: issued.devCode } : {}),
        },
      });
    }
    res.json(startSession(res, user));
  }),
);

authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

/* ------------------------------------------------------------------ demo */

// One click, one private sample company. Sandboxes are deleted after a day.
authRouter.post(
  '/demo',
  demoLimiter,
  h(async (_req, res) => {
    const started = Date.now();
    const { userId } = await createSandbox();
    const user = await loadUser(userId);
    logger.info({ ms: Date.now() - started }, 'demo sandbox created');
    res.status(201).json(startSession(res, user!));
  }),
);

/* ------------------------------------------------------------------ profile */

// Lets the app ask "am I signed in?" without logging a 401 on every cold start.
authRouter.get(
  '/session',
  h(async (req, res) => {
    const token = req.cookies?.ss_session as string | undefined;
    if (!token) return void res.json({ user: null });
    try {
      const claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as { sub: string; v: number; typ: string };
      const user = claims.typ === 'session' ? await loadUser(Number(claims.sub)) : undefined;
      if (!user || user.tokenVersion !== claims.v) {
        clearSessionCookie(res);
        return void res.json({ user: null });
      }
      res.json({ user: publicUser(user) });
    } catch {
      clearSessionCookie(res);
      res.json({ user: null });
    }
  }),
);

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
  companyName: z.string().trim().min(2, 'Enter your company name').max(80).optional(),
});

authRouter.patch(
  '/me',
  requireAuth,
  h(async (req, res) => {
    const me = currentUser(req);
    const input = parse(profileSchema, req.body);
    const emailChanged = input.email !== undefined && input.email.toLowerCase() !== me.email.toLowerCase();
    if (emailChanged) {
      const taken = await asSystem(() => one(pool, 'SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2', [input.email, me.id]));
      if (taken) throw conflict('That email is in use.', { email: 'An account with this email already exists' });
    }
    if (input.companyName && me.role !== 'manager') throw badRequest('Only managers can rename the company.');
    await tx(async (c) => {
      await c.query(
        `UPDATE users SET name = COALESCE($1, name), email = COALESCE($2, email),
                email_verified_at = CASE WHEN $3 THEN NULL ELSE email_verified_at END
          WHERE id = $4`,
        [input.name ?? null, emailChanged ? input.email : null, emailChanged, me.id],
      );
      if (input.companyName) await c.query('UPDATE companies SET name = $1 WHERE id = $2', [input.companyName, me.companyId]);
    });
    const user = (await loadUser(me.id))!;
    let devCode: string | undefined;
    if (emailChanged) {
      // the session stays; the new address still has to be confirmed before the next sign-in
      const issued = await issueVerification({ id: user.id, companyId: user.companyId, name: user.name, email: user.email, verified: false });
      devCode = issued.devCode;
    }
    res.json({ user: publicUser(user), ...(devCode ? { devCode } : {}) });
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
    if (!me.sandbox) void sendMail(passwordChangedEmail(me.email, me.name));
    res.json(startSession(res, (await loadUser(me.id))!));
  }),
);

/* ------------------------------------------------------------------ password reset (code or link) */

const genericSent = 'If an account exists for that email, a 6-digit code and a reset link are on the way. They expire in 10 minutes.';

/** Creates a reset (or invite) that works by code and by link. Used by invites too. */
export async function issuePasswordReset(
  c: Client,
  userId: number,
  opts: { minutes: number },
): Promise<{ code: string; token: string; link: string }> {
  const code = newCode();
  const token = newToken();
  await c.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
  await c.query(
    `INSERT INTO password_resets (user_id, otp_hash, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [userId, hmac(`reset:${userId}`, code), hmac('reset-link', token), opts.minutes],
  );
  return { code, token, link: `${config.appUrl}/app/reset?token=${token}` };
}

authRouter.post(
  '/forgot-password',
  codeLimiter,
  h(async (req, res) => {
    const { email } = parse(z.object({ email: emailRule }), req.body);
    const devCode = await asSystem(async () => {
      const user = await one<{ id: number; companyId: number; name: string; email: string; sandbox: boolean }>(
        pool,
        `SELECT u.id, u.company_id AS "companyId", u.name, u.email, co.is_sandbox AS sandbox
           FROM ${USER_FROM} WHERE lower(u.email) = lower($1)`,
        [email],
      );
      if (!user || user.sandbox) return undefined;
      const issued = await asCompany(user.companyId, () => tx((c) => issuePasswordReset(c, user.id, { minutes: OTP_TTL_MINUTES })));
      await sendMail(resetEmail(user.email, user.name, issued.code, issued.link, OTP_TTL_MINUTES));
      return config.otpDevEcho ? issued.code : undefined;
    });
    // Same answer whether or not the account exists.
    res.json({ ok: true, message: genericSent, ...(devCode ? { devOtp: devCode } : {}) });
  }),
);

const verifyOtpSchema = z.object({
  email: emailRule,
  otp: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

authRouter.post(
  '/verify-otp',
  codeLimiter,
  h(async (req, res) => {
    const { email, otp } = parse(verifyOtpSchema, req.body);
    const invalid = () => badRequest('That code is not valid or has expired.', { otp: 'That code is not valid or has expired' });

    const reset = await asSystem(() =>
      one<{ id: number; userId: number; otpHash: string; attempts: number }>(
        pool,
        `SELECT r.id, r.user_id AS "userId", r.otp_hash AS "otpHash", r.attempts
           FROM password_resets r JOIN users u ON u.id = r.user_id
          WHERE lower(u.email) = lower($1) AND r.used_at IS NULL AND r.expires_at > now()
          ORDER BY r.created_at DESC LIMIT 1`,
        [email],
      ),
    );
    if (!reset || reset.attempts >= OTP_MAX_ATTEMPTS) throw invalid();
    if (!sameHash(reset.otpHash, hmac(`reset:${reset.userId}`, otp))) {
      await asSystem(() => pool.query('UPDATE password_resets SET attempts = attempts + 1 WHERE id = $1', [reset.id]));
      throw invalid();
    }
    const resetToken = jwt.sign({ sub: String(reset.userId), rid: reset.id, typ: 'reset' }, config.jwtSecret, {
      expiresIn: RESET_TOKEN_TTL,
      algorithm: 'HS256',
    });
    res.json({ resetToken });
  }),
);

// Tells the reset page who the link is for (and whether it is still good) before
// asking for a new password.
authRouter.post(
  '/reset-link',
  codeLimiter,
  h(async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(20).max(200) }), req.body);
    const row = await asSystem(() =>
      one<{ loginId: string; name: string; masked: string; companyName: string; invited: boolean }>(
        pool,
        `SELECT u.login_id AS "loginId", u.name, u.email AS masked, co.name AS "companyName",
                (u.email_verified_at IS NULL) AS invited
           FROM password_resets r JOIN ${USER_FROM} ON u.id = r.user_id
          WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now()`,
        [hmac('reset-link', token)],
      ),
    );
    if (!row) throw badRequest('This link has expired or was already used. Request a new one.');
    res.json({ ...row, masked: maskEmail(row.masked) });
  }),
);

const resetSchema = z
  .object({
    resetToken: z.string().min(10).optional(),
    token: z.string().min(20).max(200).optional(),
    password: passwordRule,
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' })
  .refine((d) => d.resetToken || d.token, { path: ['token'], message: 'Missing reset token' });

authRouter.post(
  '/reset-password',
  codeLimiter,
  h(async (req, res) => {
    const input = parse(resetSchema, req.body);
    const hash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    const userId = await asSystem(() =>
      tx(async (c) => {
        let used: { userId: number } | undefined;
        if (input.token) {
          // emailed link (password reset or team invitation)
          used = await one<{ userId: number }>(
            c,
            `UPDATE password_resets SET used_at = now()
              WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id AS "userId"`,
            [hmac('reset-link', input.token)],
          );
          if (!used) throw badRequest('This link has expired or was already used. Request a new one.');
        } else {
          let claims: { sub: string; rid: number; typ: string };
          try {
            claims = jwt.verify(input.resetToken!, config.jwtSecret, { algorithms: ['HS256'] }) as typeof claims;
          } catch {
            throw badRequest('This reset session has expired. Request a new code.');
          }
          if (claims.typ !== 'reset') throw badRequest('Invalid reset token.');
          used = await one<{ userId: number }>(
            c,
            `UPDATE password_resets SET used_at = now()
              WHERE id = $1 AND user_id = $2 AND used_at IS NULL RETURNING user_id AS "userId"`,
            [claims.rid, Number(claims.sub)],
          );
          if (!used) throw badRequest('This reset code was already used. Request a new one.');
        }
        // Reaching this point proves control of the inbox, so it also confirms the email.
        await c.query(
          `UPDATE users SET password_hash = $1, token_version = token_version + 1,
                  email_verified_at = COALESCE(email_verified_at, now())
            WHERE id = $2`,
          [hash, used.userId],
        );
        return used.userId;
      }),
    );

    const user = await loadUser(userId);
    if (!user) throw badRequest('Account not found.');
    void sendMail(passwordChangedEmail(user.email, user.name));
    res.json(startSession(res, user));
  }),
);
