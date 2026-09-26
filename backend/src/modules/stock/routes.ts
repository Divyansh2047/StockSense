import { Router } from 'express';
import { z } from 'zod';
import { many, one, pool, tx } from '../../db/pool.js';
import { currentUser } from '../../lib/auth.js';
import { badRequest } from '../../lib/errors.js';
import { broadcast } from '../../lib/events.js';
import { filterId, h, idParam, parse, qty } from '../../lib/http.js';
import { PRODUCT_SELECT, stockLateral } from '../catalog/routes.js';
import { createOperation, validateOperation } from '../operations/service.js';

export const stockRouter = Router();

const listSchema = z.object({
  search: z.string().trim().max(100).optional(),
  warehouseId: filterId,
  locationId: filterId,
  categoryId: filterId,
  stock: z.enum(['low', 'out', 'in', '']).optional(),
});

/** The Stock page: every product with cost, on hand and free to use, plus where it sits. */
stockRouter.get(
  '/',
  h(async (req, res) => {
    const f = parse(listSchema, req.query);
    const params: unknown[] = [f.warehouseId ?? null, f.locationId ?? null];
    const where = ['NOT p.archived'];
    if (f.search) {
      params.push(`%${f.search.replace(/[%_\\]/g, '\\$&')}%`);
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
         SELECT ${PRODUCT_SELECT},
                COALESCE(s.on_hand, 0) * p.unit_cost AS value,
                COALESCE((
                  SELECT json_agg(json_build_object(
                           'locationId', l.id, 'fullName', w.short_code || '/' || l.short_code,
                           'quantity', q.quantity, 'reserved', q.reserved) ORDER BY w.short_code, l.short_code)
                    FROM stock_quants q JOIN locations l ON l.id = q.location_id JOIN warehouses w ON w.id = l.warehouse_id
                   WHERE q.product_id = p.id AND (q.quantity > 0 OR q.reserved > 0)
                     AND ($1::bigint IS NULL OR l.warehouse_id = $1::bigint)
                     AND ($2::bigint IS NULL OR l.id = $2::bigint)
                ), '[]'::json) AS locations
           FROM products p LEFT JOIN categories c ON c.id = p.category_id
           ${stockLateral('$1', '$2')}
          WHERE ${where.join(' AND ')}
       ) x ${stockFilter}
       ORDER BY lower(name)`,
      params,
    );
    const totals = items.reduce<{ value: number; onHand: number; free: number }>(
      (acc, r) => ({
        value: acc.value + Number(r.value),
        onHand: acc.onHand + Number(r.onHand),
        free: acc.free + Number(r.free),
      }),
      { value: 0, onHand: 0, free: 0 },
    );
    res.json({ items, totals });
  }),
);

/**
 * "User must be able to update the stock from here": set the counted quantity of a
 * product at a location. Posted as an inventory adjustment so the ledger explains it.
 */
stockRouter.put(
  '/',
  h(async (req, res) => {
    const me = currentUser(req);
    const input = parse(
      z.object({ productId: idParam, locationId: idParam, quantity: qty, note: z.string().trim().max(200).optional() }),
      req.body,
    );
    const loc = await one<{ type: string }>(pool, 'SELECT type FROM locations WHERE id = $1', [input.locationId]);
    if (!loc || loc.type !== 'internal') throw badRequest('Pick a warehouse location.', { locationId: 'Pick a warehouse location' });

    const result = await tx(async (c) => {
      const opId = await createOperation(
        c,
        {
          type: 'adjustment',
          sourceLocationId: input.locationId,
          notes: input.note || 'Updated from the stock page',
          lines: [{ productId: input.productId, quantity: input.quantity }],
        },
        me.id,
      );
      await validateOperation(c, opId, me.id);
      return one<{ reference: string; systemQuantity: number }>(
        c,
        `SELECT o.reference, l.system_quantity AS "systemQuantity"
           FROM operations o JOIN operation_lines l ON l.operation_id = o.id WHERE o.id = $1`,
        [opId],
      );
    });
    broadcast(['stock', 'moves', 'operations', 'products']);
    res.json({ reference: result?.reference, previous: result?.systemQuantity, quantity: input.quantity });
  }),
);
