import { Router } from 'express';
import { z } from 'zod';
import { many, one, pool, tx } from '../../db/pool.js';
import { currentUser, requireManager } from '../../lib/auth.js';
import { conflict, notFound } from '../../lib/errors.js';
import { broadcast } from '../../lib/events.js';
import { h, idParam, parse } from '../../lib/http.js';

export const usersRouter = Router();

// Everyone can list the team (the "Responsible" picker needs it).
usersRouter.get(
  '/',
  h(async (_req, res) => {
    const items = await many(
      pool,
      `SELECT id, login_id AS "loginId", name, email, role, created_at AS "createdAt"
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
