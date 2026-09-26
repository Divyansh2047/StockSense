import { Router } from 'express';
import { z } from 'zod';
import { many, one, pool, tx } from '../../db/pool.js';
import { requireManager } from '../../lib/auth.js';
import { conflict, notFound } from '../../lib/errors.js';
import { broadcast } from '../../lib/events.js';
import { filterId, h, idParam, parse } from '../../lib/http.js';

export const warehousesRouter = Router();

const warehouseSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(80),
  shortCode: z
    .string()
    .trim()
    .min(1, 'Enter a short code')
    .max(8, 'Up to 8 characters')
    .regex(/^[A-Za-z0-9]+$/, 'Letters and numbers only')
    .transform((s) => s.toUpperCase()),
  address: z.string().trim().max(300).default(''),
});

const locationSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(80),
  shortCode: z
    .string()
    .trim()
    .min(1, 'Enter a short code')
    .max(16, 'Up to 16 characters')
    .regex(/^[A-Za-z0-9_-]+$/, 'Letters, numbers, dash or underscore'),
  warehouseId: idParam,
});

/* ------------------------------------------------------------------ warehouses */

warehousesRouter.get(
  '/warehouses',
  h(async (_req, res) => {
    const items = await many(
      pool,
      `SELECT w.id, w.name, w.short_code AS "shortCode", w.address, w.created_at AS "createdAt",
              (SELECT count(*)::int FROM locations l WHERE l.warehouse_id = w.id) AS "locationCount",
              (SELECT COALESCE(sum(q.quantity), 0) FROM stock_quants q JOIN locations l ON l.id = q.location_id
                WHERE l.warehouse_id = w.id) AS "unitsOnHand",
              (SELECT count(*)::int FROM operations o WHERE o.warehouse_id = w.id AND o.status NOT IN ('done', 'canceled')) AS "openOperations"
         FROM warehouses w ORDER BY w.short_code`,
    );
    res.json({ items });
  }),
);

async function assertCodeFree(code: string, exceptId?: number) {
  const clash = await one(pool, 'SELECT 1 FROM warehouses WHERE upper(short_code) = upper($1) AND ($2::bigint IS NULL OR id <> $2)', [
    code,
    exceptId ?? null,
  ]);
  if (clash) throw conflict('Short code in use.', { shortCode: 'Another warehouse uses this short code' });
}

warehousesRouter.post(
  '/warehouses',
  requireManager,
  h(async (req, res) => {
    const input = parse(warehouseSchema, req.body);
    await assertCodeFree(input.shortCode);
    const row = await tx(async (c) => {
      const wh = await one<{ id: number }>(
        c,
        'INSERT INTO warehouses (name, short_code, address) VALUES ($1, $2, $3) RETURNING id',
        [input.name, input.shortCode, input.address],
      );
      // every warehouse starts with one stock location so it is usable right away
      await c.query(`INSERT INTO locations (name, short_code, warehouse_id) VALUES ('Stock', 'Stock', $1)`, [wh!.id]);
      return wh!;
    });
    broadcast(['warehouses']);
    res.status(201).json(row);
  }),
);

warehousesRouter.patch(
  '/warehouses/:id',
  requireManager,
  h(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const input = parse(warehouseSchema.partial(), req.body);
    if (input.shortCode) {
      await assertCodeFree(input.shortCode, id);
      const used = await one(pool, 'SELECT 1 FROM operations WHERE warehouse_id = $1 LIMIT 1', [id]);
      const current = await one<{ code: string }>(pool, 'SELECT short_code AS code FROM warehouses WHERE id = $1', [id]);
      if (used && current && current.code.toUpperCase() !== input.shortCode) {
        throw conflict('This warehouse already has documents.', {
          shortCode: 'The short code is part of existing references and cannot change',
        });
      }
    }
    const row = await one(
      pool,
      `UPDATE warehouses SET name = COALESCE($2, name), short_code = COALESCE($3, short_code), address = COALESCE($4, address)
        WHERE id = $1 RETURNING id`,
      [id, input.name ?? null, input.shortCode ?? null, input.address ?? null],
    );
    if (!row) throw notFound('Warehouse');
    broadcast(['warehouses']);
    res.json(row);
  }),
);

warehousesRouter.delete(
  '/warehouses/:id',
  requireManager,
  h(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const used = await one<{ ops: boolean; stock: boolean }>(
      pool,
      `SELECT EXISTS (SELECT 1 FROM operations WHERE warehouse_id = $1) AS ops,
              EXISTS (SELECT 1 FROM stock_quants q JOIN locations l ON l.id = q.location_id
                       WHERE l.warehouse_id = $1 AND q.quantity > 0) AS stock`,
      [id],
    );
    if (used?.ops || used?.stock) throw conflict('This warehouse has stock or documents, so it cannot be deleted.');
    await tx(async (c) => {
      await c.query('DELETE FROM stock_quants q USING locations l WHERE l.id = q.location_id AND l.warehouse_id = $1', [id]);
      await c.query('DELETE FROM locations WHERE warehouse_id = $1', [id]);
      const row = await one(c, 'DELETE FROM warehouses WHERE id = $1 RETURNING id', [id]);
      if (!row) throw notFound('Warehouse');
    });
    broadcast(['warehouses']);
    res.status(204).end();
  }),
);

/* ------------------------------------------------------------------ locations */

warehousesRouter.get(
  '/locations',
  h(async (req, res) => {
    const f = parse(z.object({ warehouseId: filterId, includeVirtual: z.enum(['true', 'false']).optional() }), req.query);
    const items = await many(
      pool,
      `SELECT l.id, l.name, l.short_code AS "shortCode", l.type, l.warehouse_id AS "warehouseId",
              w.name AS "warehouseName", w.short_code AS "warehouseCode",
              CASE WHEN l.type = 'internal' THEN w.short_code || '/' || l.short_code ELSE l.name END AS "fullName",
              (SELECT COALESCE(sum(q.quantity), 0) FROM stock_quants q WHERE q.location_id = l.id) AS "unitsOnHand",
              (SELECT count(DISTINCT q.product_id)::int FROM stock_quants q WHERE q.location_id = l.id AND q.quantity > 0) AS "productCount"
         FROM locations l LEFT JOIN warehouses w ON w.id = l.warehouse_id
        WHERE ($1::bigint IS NULL OR l.warehouse_id = $1) AND ($2 OR l.type = 'internal')
        ORDER BY l.type <> 'internal', w.short_code, l.short_code`,
      [f.warehouseId ?? null, f.includeVirtual === 'true'],
    );
    res.json({ items });
  }),
);

async function assertLocationCodeFree(warehouseId: number, code: string, exceptId?: number) {
  const clash = await one(
    pool,
    'SELECT 1 FROM locations WHERE warehouse_id = $1 AND upper(short_code) = upper($2) AND ($3::bigint IS NULL OR id <> $3)',
    [warehouseId, code, exceptId ?? null],
  );
  if (clash) throw conflict('Short code in use.', { shortCode: 'This warehouse already has a location with that code' });
}

warehousesRouter.post(
  '/locations',
  requireManager,
  h(async (req, res) => {
    const input = parse(locationSchema, req.body);
    const wh = await one(pool, 'SELECT 1 FROM warehouses WHERE id = $1', [input.warehouseId]);
    if (!wh) throw notFound('Warehouse');
    await assertLocationCodeFree(input.warehouseId, input.shortCode);
    const row = await one(
      pool,
      'INSERT INTO locations (name, short_code, warehouse_id) VALUES ($1, $2, $3) RETURNING id',
      [input.name, input.shortCode, input.warehouseId],
    );
    broadcast(['warehouses']);
    res.status(201).json(row);
  }),
);

warehousesRouter.patch(
  '/locations/:id',
  requireManager,
  h(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const input = parse(locationSchema.partial(), req.body);
    const loc = await one<{ warehouseId: number | null; type: string }>(
      pool,
      'SELECT warehouse_id AS "warehouseId", type FROM locations WHERE id = $1',
      [id],
    );
    if (!loc) throw notFound('Location');
    if (loc.type !== 'internal') throw conflict('Built-in virtual locations cannot be edited.');
    if (input.warehouseId && input.warehouseId !== loc.warehouseId) {
      const busy = await one(
        pool,
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM stock_quants WHERE location_id = $1 AND quantity > 0)
            OR EXISTS (SELECT 1 FROM operations WHERE source_location_id = $1 OR dest_location_id = $1)`,
        [id],
      );
      if (busy) throw conflict('This location has stock or documents and cannot move to another warehouse.', { warehouseId: 'In use' });
    }
    const warehouseId = input.warehouseId ?? loc.warehouseId!;
    if (input.shortCode) await assertLocationCodeFree(warehouseId, input.shortCode, id);
    await pool.query(
      'UPDATE locations SET name = COALESCE($2, name), short_code = COALESCE($3, short_code), warehouse_id = $4 WHERE id = $1',
      [id, input.name ?? null, input.shortCode ?? null, warehouseId],
    );
    broadcast(['warehouses']);
    res.json({ id });
  }),
);

warehousesRouter.delete(
  '/locations/:id',
  requireManager,
  h(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const used = await one<{ used: boolean; type: string }>(
      pool,
      `SELECT type, EXISTS (SELECT 1 FROM stock_quants WHERE location_id = $1 AND quantity > 0)
               OR EXISTS (SELECT 1 FROM operations WHERE source_location_id = $1 OR dest_location_id = $1)
               OR EXISTS (SELECT 1 FROM stock_moves WHERE from_location_id = $1 OR to_location_id = $1) AS used
         FROM locations WHERE id = $1`,
      [id],
    );
    if (!used) throw notFound('Location');
    if (used.type !== 'internal') throw conflict('Built-in virtual locations cannot be deleted.');
    if (used.used) throw conflict('This location has stock or history, so it cannot be deleted.');
    await tx(async (c) => {
      await c.query('DELETE FROM stock_quants WHERE location_id = $1', [id]);
      await c.query('DELETE FROM locations WHERE id = $1', [id]);
    });
    broadcast(['warehouses']);
    res.status(204).end();
  }),
);
