import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../../config.js';
import { asSystem, many, one, pool, tx } from '../../db/pool.js';
import { currentUser, requireManager } from '../../lib/auth.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { broadcast } from '../../lib/events.js';
import { h, idParam, parse } from '../../lib/http.js';
import { inviteEmail, sendMail } from '../../lib/mailer.js';
import { BCRYPT_ROUNDS, INVITE_LINK_HOURS, emailRule, issuePasswordReset, loginIdRule } from '../auth/routes.js';

export const usersRouter = Router();

// Everyone can list the team (the "Responsible" picker needs it).
usersRouter.get(
  '/',
  h(async (_req, res) => {
    const items = await many(
      pool,
      `SELECT id, login_id AS "loginId", name, email, role, created_at AS "createdAt",
              (email_verified_at IS NOT NULL) AS "emailVerified"
         FROM users ORDER BY role, lower(name)`,
    );
    res.json({ items });
  }),
);

usersRouter.patch(
  '/:id/role',
  requireManager,
  h(async (req, res) => {
    const me = currentUser(req);
    const id = parse(idParam, req.params.id);
    const { role } = parse(z.object({ role: z.enum(['manager', 'staff']) }), req.body);
    await tx(async (c) => {
      await c.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      const target = await one<{ role: string }>(c, 'SELECT role FROM users WHERE id = $1', [id]);
      if (!target) throw notFound('User');
      if (target.role === 'manager' && role === 'staff') {
        const managers = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM users WHERE role = 'manager'`);
        if ((managers?.n ?? 0) <= 1) throw conflict('There must always be at least one manager.');
      }
      // role changes sign the user out everywhere so the new permissions apply immediately
      await c.query('UPDATE users SET role = $2, token_version = token_version + CASE WHEN id = $3 THEN 0 ELSE 1 END WHERE id = $1', [
        id,
        role,
        me.id,
      ]);
    });
    broadcast(['users']);
    res.json({ id, role });
  }),
);

const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: config.isTest ? 10_000 : 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many invitations in an hour. Try again later.' } },
});

const inviteSchema = z.object({
  loginId: loginIdRule,
  name: z.string().trim().min(1, 'Enter a name').max(80),
  email: emailRule,
  role: z.enum(['manager', 'staff']).default('staff'),
});

// Managers add teammates; the teammate sets a password from the emailed link, which
// also confirms their address.
usersRouter.post(
  '/',
  requireManager,
  inviteLimiter,
  h(async (req, res) => {
    const me = currentUser(req);
    if (me.sandbox) throw badRequest('Invitations are switched off in demo workspaces, so nobody gets emailed by accident.');
    const input = parse(inviteSchema, req.body);
    const clashes = await asSystem(() =>
      many<{ login: boolean; mail: boolean }>(
        pool,
        `SELECT lower(login_id) = lower($1) AS login, lower(email) = lower($2) AS mail
           FROM users WHERE lower(login_id) = lower($1) OR lower(email) = lower($2)`,
        [input.loginId, input.email],
      ),
    );
    const fields: Record<string, string> = {};
    if (clashes.some((r) => r.login)) fields.loginId = 'This Login ID is already taken';
    if (clashes.some((r) => r.mail)) fields.email = 'Someone already uses this email';
    if (Object.keys(fields).length) throw conflict('That person already has an account.', fields);

    // unusable until they choose their own from the invitation
    const placeholder = await bcrypt.hash(randomBytes(24).toString('base64url'), BCRYPT_ROUNDS);
    const { id, link } = await tx(async (c) => {
      const row = await one<{ id: number }>(
        c,
        `INSERT INTO users (login_id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [input.loginId, input.email, input.name, placeholder, input.role],
      );
      const issued = await issuePasswordReset(c, row!.id, { minutes: INVITE_LINK_HOURS * 60 });
      return { id: row!.id, link: issued.link };
    });
    const sent = await sendMail(inviteEmail(input.email, input.name, me.name, me.companyName, input.loginId, link, INVITE_LINK_HOURS));
    broadcast(['users']);
    res.status(201).json({ id, sent, ...(config.otpDevEcho ? { devLink: link } : {}) });
  }),
);

usersRouter.post(
  '/:id/invite',
  requireManager,
  inviteLimiter,
  h(async (req, res) => {
    const me = currentUser(req);
    const id = parse(idParam, req.params.id);
    const user = await one<{ loginId: string; name: string; email: string; verified: boolean }>(
      pool,
      `SELECT login_id AS "loginId", name, email, (email_verified_at IS NOT NULL) AS verified FROM users WHERE id = $1`,
      [id],
    );
    if (!user) throw notFound('User');
    if (user.verified) throw conflict('This person has already joined.');
    const { link } = await tx((c) => issuePasswordReset(c, id, { minutes: INVITE_LINK_HOURS * 60 }));
    const sent = await sendMail(inviteEmail(user.email, user.name, me.name, me.companyName, user.loginId, link, INVITE_LINK_HOURS));
    res.json({ ok: true, sent, ...(config.otpDevEcho ? { devLink: link } : {}) });
  }),
);
