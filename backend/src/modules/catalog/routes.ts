import { Router } from 'express';
import { z } from 'zod';
import { many, one, pool, tx } from '../../db/pool.js';
import { currentUser, requireManager } from '../../lib/auth.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { broadcast } from '../../lib/events.js';
import { filterId, h, idParam, parse, qty, trimmed } from '../../lib/http.js';
import { createOperation, validateOperation } from '../operations/service.js';

export const catalogRouter = Router();

/* ------------------------------------------------------------------ categories */

const categorySchema = z.object({ name: z.string().trim().min(1, 'Enter a name').max(60) });

catalogRouter.get(
  '/categories',
  h(async (_req, res) => {
    const items = await many(
      pool,
      `SELECT c.id, c.name, count(p.id)::int AS "productCount"
         FROM categories c LEFT JOIN products p ON p.category_id = c.id AND NOT p.archived
        GROUP BY c.id ORDER BY lower(c.name)`,
    );
    res.json({ items });
  }),
);

catalogRouter.post(
  '/categories',
  h(async (req, res) => {
    const { name } = parse(categorySchema, req.body);
    const exists = await one(pool, 'SELECT 1 FROM categories WHERE lower(name) = lower($1)', [name]);
    if (exists) throw conflict('That category exists.', { name: 'A category with this name exists' });
    const row = await one(pool, 'INSERT INTO categories (name) VALUES ($1) RETURNING id, name', [name]);
    broadcast(['products']);
    res.status(201).json(row);
  }),
);

catalogRouter.patch(
  '/categories/:id',
  h(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const { name } = parse(categorySchema, req.body);
    const clash = await one(pool, 'SELECT 1 FROM categories WHERE lower(name) = lower($1) AND id <> $2', [name, id]);
    if (clash) throw conflict('That category exists.', { name: 'A category with this name exists' });
    const row = await one(pool, 'UPDATE categories SET name = $2 WHERE id = $1 RETURNING id, name', [id, name]);
    if (!row) throw notFound('Category');
    broadcast(['products']);
    res.json(row);
  }),
);

catalogRouter.delete(
  '/categories/:id',
  requireManager,
  h(async (req, res) => {
    const id = parse(idParam, req.params.id);
    // products keep existing; they just lose the category (ON DELETE SET NULL)
    const row = await one(pool, 'DELETE FROM categories WHERE id = $1 RETURNING id', [id]);
    if (!row) throw notFound('Category');
    broadcast(['products']);
    res.status(204).end();
  }),
);

/* ------------------------------------------------------------------ products */

const productFields = {
  name: z.string().trim().min(1, 'Enter a product name').max(120),
  sku: z
    .string()
    .trim()
    .min(1, 'Enter a SKU / code')
    .max(32, 'Keep the SKU under 32 characters')
    .regex(/^[A-Za-z0-9._-]+$/, 'Letters, numbers, dot, dash or underscore only')
    .transform((s) => s.toUpperCase()),
  categoryId: idParam.nullish(),
  uom: z.string().trim().min(1, 'Enter a unit of measure').max(20).default('Units'),
  unitCost: qty.default(0),
  reorderMin: qty.default(0),
  reorderMax: qty.default(0),
};

const createProductSchema = z
  .object({
    ...productFields,
    initialStock: z.object({ locationId: idParam, quantity: qty }).nullish(),
  })
  .refine((p) => p.reorderMax === 0 || p.reorderMax >= p.reorderMin, {
    path: ['reorderMax'],
    message: 'Max should be at least the min quantity',
  });

const patchProductSchema = z
  .object({ ...productFields, archived: z.boolean() })
  .partial()
  .refine((p) => p.reorderMax === undefined || p.reorderMin === undefined || p.reorderMax === 0 || p.reorderMax >= p.reorderMin, {
    path: ['reorderMax'],
    message: 'Max should be at least the min quantity',
  });

const listSchema = z.object({
  search: z.string().trim().max(100).optional(),
  categoryId: filterId,
  warehouseId: filterId,
  locationId: filterId,
  stock: z.enum(['low', 'out', 'in', '']).optional(),
  archived: z.enum(['true', 'false']).optional(),
});

const esc = (s: string) => `%${s.replace(/[%_\\]/g, '\\$&')}%`;

export const PRODUCT_SELECT = `
  p.id, p.name, p.sku, p.uom, p.unit_cost AS "unitCost",
  p.reorder_min AS "reorderMin", p.reorder_max AS "reorderMax", p.archived,
  p.category_id AS "categoryId", c.name AS "categoryName",
  COALESCE(s.on_hand, 0) AS "onHand", COALESCE(s.reserved, 0) AS reserved,
  COALESCE(s.on_hand, 0) - COALESCE(s.reserved, 0) AS free,
  CASE WHEN COALESCE(s.on_hand, 0) <= 0 THEN 'out'
       WHEN COALESCE(s.on_hand, 0) <= p.reorder_min THEN 'low'
       ELSE 'ok' END AS "stockStatus"`;

/** Lateral stock totals, optionally scoped to one warehouse or one location. */
export const stockLateral = (whParam: string, locParam: string) => `
  LEFT JOIN LATERAL (
    SELECT sum(q.quantity) AS on_hand, sum(q.reserved) AS reserved
      FROM stock_quants q JOIN locations l ON l.id = q.location_id
     WHERE q.product_id = p.id AND l.type = 'internal'
       AND (${whParam}::bigint IS NULL OR l.warehouse_id = ${whParam}::bigint)
       AND (${locParam}::bigint IS NULL OR l.id = ${locParam}::bigint)
  ) s ON true`;

catalogRouter.get(
  '/products',
  h(async (req, res) => {
    const f = parse(listSchema, req.query);
    const params: unknown[] = [f.warehouseId ?? null, f.locationId ?? null];
    const where = [f.archived === 'true' ? 'p.archived' : 'NOT p.archived'];
    if (f.search) {
      params.push(esc(f.search));
      where.push(`(p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`);
    }
    if (f.categoryId) {
      params.push(f.categoryId);
      where.push(`p.category_id = $${params.length}`);
    }
    let stockFilter = '';
    if (f.stock === 'out') stockFilter = `WHERE "stockStatus" = 'out'`;
    if (f.stock === 'low') stockFilter = `WHERE "stockStatus" IN ('low', 'out')`;
    if (f.stock === 'in') stockFilter = `WHERE "onHand" > 0`;
    const items = await many(
      pool,
      `SELECT * FROM (
         SELECT ${PRODUCT_SELECT}
           FROM products p LEFT JOIN categories c ON c.id = p.category_id
           ${stockLateral('$1', '$2')}
          WHERE ${where.join(' AND ')}
       ) x ${stockFilter}
       ORDER BY lower(name)`,
      params,
    );
    res.json({ items });
  }),
);

catalogRouter.get(
  '/products/:id',
  h(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const product = await one(
      pool,
      `SELECT ${PRODUCT_SELECT}, p.created_at AS "createdAt"
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
         ${stockLateral('NULL', 'NULL')}
        WHERE p.id = $1`,
      [id],
    );
    if (!product) throw notFound('Product');
    const locations = await many(
      pool,
      `SELECT l.id AS "locationId", w.short_code || '/' || l.short_code AS "fullName", l.name,
              w.id AS "warehouseId", w.name AS "warehouseName", q.quantity, q.reserved,
              q.quantity - q.reserved AS free
         FROM stock_quants q JOIN locations l ON l.id = q.location_id JOIN warehouses w ON w.id = l.warehouse_id
        WHERE q.product_id = $1 AND (q.quantity > 0 OR q.reserved > 0)
        ORDER BY w.short_code, l.short_code`,
      [id],
    );
    res.json({ ...product, locations });
  }),
);

async function assertSkuFree(sku: string, exceptId?: number) {
  const clash = await one(pool, 'SELECT 1 FROM products WHERE upper(sku) = upper($1) AND ($2::bigint IS NULL OR id <> $2)', [
    sku,
    exceptId ?? null,
  ]);
  if (clash) throw conflict('SKU already used.', { sku: 'Another product already uses this SKU' });
}

catalogRouter.post(
  '/products',
  h(async (req, res) => {
    const me = currentUser(req);
    const input = parse(createProductSchema, req.body);
    await assertSkuFree(input.sku);
    const id = await tx(async (c) => {
      const row = await one<{ id: number }>(
        c,
        `INSERT INTO products (name, sku, category_id, uom, unit_cost, reorder_min, reorder_max)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [input.name, input.sku, input.categoryId ?? null, input.uom, input.unitCost, input.reorderMin, input.reorderMax],
      );
      // Optional initial stock is booked as an adjustment so it shows up in the ledger.
      if (input.initialStock && input.initialStock.quantity > 0) {
        const opId = await createOperation(
          c,
          {
            type: 'adjustment',
            sourceLocationId: input.initialStock.locationId,
            notes: 'Initial stock',
            lines: [{ productId: row!.id, quantity: input.initialStock.quantity }],
          },
          me.id,
        );
        await validateOperation(c, opId, me.id);
      }
      return row!.id;
    });
    broadcast(['products', 'stock', 'moves', 'operations']);
    res.status(201).json({ id });
  }),
);

catalogRouter.patch(
  '/products/:id',
  h(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const input = parse(patchProductSchema, req.body);
    if (input.sku) await assertSkuFree(input.sku, id);
    const current = await one<{ reorderMin: number; reorderMax: number }>(
      pool,
      'SELECT reorder_min AS "reorderMin", reorder_max AS "reorderMax" FROM products WHERE id = $1',
      [id],
    );
    if (!current) throw notFound('Product');
    const min = input.reorderMin ?? current.reorderMin;
    const max = input.reorderMax ?? current.reorderMax;
    if (max !== 0 && max < min) throw badRequest('Check the reorder rule.', { reorderMax: 'Max should be at least the min quantity' });
    await pool.query(
      `UPDATE products SET
         name = COALESCE($2, name), sku = COALESCE($3, sku),
         category_id = CASE WHEN $4 THEN $5::bigint ELSE category_id END,
         uom = COALESCE($6, uom), unit_cost = COALESCE($7, unit_cost),
         reorder_min = $8, reorder_max = $9, archived = COALESCE($10, archived)
       WHERE id = $1`,
      [
        id,
        input.name ?? null,
        input.sku ?? null,
        input.categoryId !== undefined,
        input.categoryId ?? null,
        input.uom ?? null,
        input.unitCost ?? null,
        min,
        max,
        input.archived ?? null,
      ],
    );
    broadcast(['products', 'stock']);
    res.json({ id });
  }),
);

catalogRouter.delete(
  '/products/:id',
  requireManager,
  h(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const used = await one<{ moves: boolean; lines: boolean; stock: boolean }>(
      pool,
      `SELECT EXISTS (SELECT 1 FROM stock_moves WHERE product_id = $1) AS moves,
              EXISTS (SELECT 1 FROM operation_lines WHERE product_id = $1) AS lines,
              EXISTS (SELECT 1 FROM stock_quants WHERE product_id = $1 AND quantity > 0) AS stock`,
      [id],
    );
    if (used?.stock) throw conflict('This product still has stock. Count it to zero before removing it.');
    if (used?.moves || used?.lines) {
      // history must stay intact, so archive instead of deleting
      await pool.query('UPDATE products SET archived = true WHERE id = $1', [id]);
      broadcast(['products']);
      return res.json({ archived: true });
    }
    await tx(async (c) => {
      await c.query('DELETE FROM stock_quants WHERE product_id = $1', [id]);
      const row = await one(c, 'DELETE FROM products WHERE id = $1 RETURNING id', [id]);
      if (!row) throw notFound('Product');
    });
    broadcast(['products']);
    res.status(204).end();
  }),
);

/* ------------------------------------------------------------------ reorder: draft a receipt */

catalogRouter.post(
  '/products/:id/replenish',
  h(async (req, res) => {
    const me = currentUser(req);
    const id = parse(idParam, req.params.id);
    const { locationId, partnerId, quantity } = parse(
      z.object({ locationId: idParam, partnerId: idParam.nullish(), quantity: qty.optional() }),
      req.body,
    );
    const p = await one<{ onHand: number; reorderMax: number; reorderMin: number }>(
      pool,
      `SELECT COALESCE(s.on_hand, 0) AS "onHand", p.reorder_max AS "reorderMax", p.reorder_min AS "reorderMin"
         FROM products p ${stockLateral('NULL', 'NULL')} WHERE p.id = $1`,
      [id],
    );
    if (!p) throw notFound('Product');
    const target = p.reorderMax > 0 ? p.reorderMax : p.reorderMin * 2;
    const want = quantity && quantity > 0 ? quantity : Math.max(target - p.onHand, 1);
    const opId = await tx((c) =>
      createOperation(
        c,
        { type: 'receipt', destLocationId: locationId, partnerId, notes: 'Replenishment from reorder rule', lines: [{ productId: id, quantity: want }] },
        me.id,
      ),
    );
    broadcast(['operations']);
    res.status(201).json({ id: opId });
  }),
);
