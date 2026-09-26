import { Router } from 'express';
import { z } from 'zod';
import { many, one, pool } from '../../db/pool.js';
import { conflict, notFound } from '../../lib/errors.js';
import { broadcast } from '../../lib/events.js';
import { h, idParam, parse } from '../../lib/http.js';

export const partnersRouter = Router();

const partnerSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(120),
  kind: z.enum(['vendor', 'customer', 'both']).default('both'),
  email: z.union([z.literal(''), z.string().trim().toLowerCase().email('Enter a valid email')]).default(''),
  phone: z.string().trim().max(40).default(''),
  address: z.string().trim().max(300).default(''),
});

partnersRouter.get(
  '/',
  h(async (req, res) => {
    const { search, kind } = parse(
      z.object({ search: z.string().trim().max(100).optional(), kind: z.enum(['vendor', 'customer', '']).optional() }),
      req.query,
    );
    const items = await many(
      pool,
      `SELECT pa.id, pa.name, pa.kind, pa.email, pa.phone, pa.address,
              (SELECT count(*)::int FROM operations o WHERE o.partner_id = pa.id) AS "operationCount"
         FROM partners pa
        WHERE ($1::text IS NULL OR pa.name ILIKE '%' || $1 || '%' OR pa.email ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR pa.kind = 'both' OR pa.kind = $2::partner_kind)
        ORDER BY lower(pa.name)`,
      [search ? search.replace(/[%_\\]/g, '\\$&') : null, kind || null],
    );
    res.json({ items });
  }),
);

async function assertNameFree(name: string, exceptId?: number) {
  const clash = await one(pool, 'SELECT 1 FROM partners WHERE lower(name) = lower($1) AND ($2::bigint IS NULL OR id <> $2)', [
    name,
    exceptId ?? null,
  ]);
  if (clash) throw conflict('Contact exists.', { name: 'A contact with this name exists' });
}

partnersRouter.post(
  '/',
  h(async (req, res) => {
    const input = parse(partnerSchema, req.body);
    await assertNameFree(input.name);
    const row = await one(
      pool,
      'INSERT INTO partners (name, kind, email, phone, address) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, kind, email, phone, address',
      [input.name, input.kind, input.email, input.phone, input.address],
    );
    broadcast(['partners']);
    res.status(201).json(row);
  }),
);

partnersRouter.patch(
  '/:id',
  h(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const input = parse(partnerSchema.partial(), req.body);
    if (input.name) await assertNameFree(input.name, id);
    const row = await one(
      pool,
      `UPDATE partners SET name = COALESCE($2, name), kind = COALESCE($3, kind), email = COALESCE($4, email),
              phone = COALESCE($5, phone), address = COALESCE($6, address)
        WHERE id = $1 RETURNING id, name, kind, email, phone, address`,
      [id, input.name ?? null, input.kind ?? null, input.email ?? null, input.phone ?? null, input.address ?? null],
    );
    if (!row) throw notFound('Contact');
    broadcast(['partners']);
    res.json(row);
  }),
);

partnersRouter.delete(
  '/:id',
  h(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const used = await one(pool, 'SELECT 1 FROM operations WHERE partner_id = $1 LIMIT 1', [id]);
    if (used) throw conflict('This contact is on existing documents and cannot be deleted.');
    const row = await one(pool, 'DELETE FROM partners WHERE id = $1 RETURNING id', [id]);
    if (!row) throw notFound('Contact');
    broadcast(['partners']);
    res.status(204).end();
  }),
);
