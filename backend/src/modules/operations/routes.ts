import { Router } from 'express';
import { z } from 'zod';
import { many, one, pool, tx, type Db } from '../../db/pool.js';
import { currentUser } from '../../lib/auth.js';
import { notFound } from '../../lib/errors.js';
import { broadcast } from '../../lib/events.js';
import { filterId, h, idParam, isoDate, parse, qty, trimmed } from '../../lib/http.js';
import {
  cancelOperation,
  checkAvailability,
  confirmOperation,
  createOperation,
  deleteOperation,
  updateOperation,
  validateOperation,
  type OpType,
} from './service.js';

export const operationsRouter = Router();

const TYPES = ['receipt', 'delivery', 'internal', 'adjustment'] as const;
const STATUSES = ['draft', 'waiting', 'ready', 'done', 'canceled'] as const;

const lineSchema = z.object({ productId: idParam, quantity: qty });
const createSchema = z.object({
  type: z.enum(TYPES),
  partnerId: idParam.nullish(),
  sourceLocationId: idParam.nullish(),
  destLocationId: idParam.nullish(),
  scheduledDate: isoDate.nullish(),
  responsibleId: idParam.nullish(),
  deliveryAddress: trimmed(500).optional(),
  notes: trimmed(2000).optional(),
  lines: z.array(lineSchema).max(200).default([]),
});
const patchSchema = createSchema.omit({ type: true }).partial();

const listSchema = z.object({
  type: z.enum(TYPES).optional(),
  status: z.union([z.enum(STATUSES), z.literal('pending'), z.literal('late'), z.literal('')]).optional(),
  warehouseId: filterId,
  locationId: filterId,
  categoryId: filterId,
  partnerId: filterId,
  productId: filterId,
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/* ------------------------------------------------------------------ read models */

const SUMMARY_SELECT = `
  o.id, o.reference, o.type, o.status, o.scheduled_date AS "scheduledDate",
  o.created_at AS "createdAt", o.validated_at AS "validatedAt",
  o.warehouse_id AS "warehouseId", w.short_code AS "warehouseCode",
  o.partner_id AS "partnerId", p.name AS "partnerName",
  o.source_location_id AS "sourceLocationId", o.dest_location_id AS "destLocationId",
  CASE WHEN sl.type = 'internal' THEN sw.short_code || '/' || sl.short_code ELSE sl.name END AS "sourceName",
  CASE WHEN dl.type = 'internal' THEN dw.short_code || '/' || dl.short_code ELSE dl.name END AS "destName",
  o.responsible_id AS "responsibleId", u.name AS "responsibleName",
  (o.status NOT IN ('done', 'canceled') AND o.scheduled_date < CURRENT_DATE) AS late,
  (SELECT count(*)::int FROM operation_lines l WHERE l.operation_id = o.id) AS "lineCount",
  (SELECT COALESCE(sum(l.quantity), 0) FROM operation_lines l WHERE l.operation_id = o.id) AS "totalQuantity"`;

const SUMMARY_FROM = `
  FROM operations o
  JOIN warehouses w ON w.id = o.warehouse_id
  JOIN locations sl ON sl.id = o.source_location_id
  LEFT JOIN warehouses sw ON sw.id = sl.warehouse_id
  JOIN locations dl ON dl.id = o.dest_location_id
  LEFT JOIN warehouses dw ON dw.id = dl.warehouse_id
  LEFT JOIN partners p ON p.id = o.partner_id
  LEFT JOIN users u ON u.id = o.responsible_id`;

export interface OperationFilters {
  type?: OpType;
  status?: string;
  warehouseId?: number;
  locationId?: number;
  categoryId?: number;
  partnerId?: number;
  productId?: number;
  search?: string;
  limit?: number;
}

export async function listOperations(db: Db, f: OperationFilters) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replaceAll('$?', `$${params.length}`));
  };
  if (f.type) add('o.type = $?', f.type);
  if (f.status === 'pending') where.push(`o.status NOT IN ('done', 'canceled')`);
  else if (f.status === 'late') where.push(`o.status NOT IN ('done', 'canceled') AND o.scheduled_date < CURRENT_DATE`);
  else if (f.status) add('o.status = $?::operation_status', f.status);
  if (f.warehouseId) add('o.warehouse_id = $?', f.warehouseId);
  if (f.locationId) add('(o.source_location_id = $? OR o.dest_location_id = $?)', f.locationId);
  if (f.partnerId) add('o.partner_id = $?', f.partnerId);
  if (f.categoryId) {
    add('EXISTS (SELECT 1 FROM operation_lines l JOIN products pr ON pr.id = l.product_id WHERE l.operation_id = o.id AND pr.category_id = $?)', f.categoryId);
  }
  if (f.productId) add('EXISTS (SELECT 1 FROM operation_lines l WHERE l.operation_id = o.id AND l.product_id = $?)', f.productId);
  if (f.search) {
    add(
      `(o.reference ILIKE $? OR p.name ILIKE $? OR EXISTS (
          SELECT 1 FROM operation_lines l JOIN products pr ON pr.id = l.product_id
           WHERE l.operation_id = o.id AND (pr.name ILIKE $? OR pr.sku ILIKE $?)))`,
      `%${f.search.replace(/[%_\\]/g, '\\$&')}%`,
    );
  }
  params.push(f.limit ?? 200);
  return many(
    db,
    `SELECT ${SUMMARY_SELECT} ${SUMMARY_FROM}
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (o.status IN ('done', 'canceled')), o.scheduled_date DESC, o.id DESC
      LIMIT $${params.length}`,
    params,
  );
}

export async function getOperation(db: Db, id: number) {
  const op = await one<Record<string, unknown>>(
    db,
    `SELECT ${SUMMARY_SELECT},
            o.delivery_address AS "deliveryAddress", o.notes,
            vb.name AS "validatedByName", cb.name AS "createdByName"
       ${SUMMARY_FROM}
       LEFT JOIN users vb ON vb.id = o.validated_by
       LEFT JOIN users cb ON cb.id = o.created_by
      WHERE o.id = $1`,
    [id],
  );
  if (!op) throw notFound('Operation');
  // Per line: what the source location can still give (free) so the UI can flag
  // short lines in red before anyone tries to validate.
  const lines = await many(
    db,
    `SELECT l.id, l.product_id AS "productId", pr.name AS "productName", pr.sku, pr.uom,
            l.quantity, l.reserved, l.system_quantity AS "systemQuantity",
            COALESCE(q.quantity, 0) AS "onHand",
            COALESCE(q.quantity, 0) - COALESCE(q.reserved, 0) + l.reserved AS "available"
       FROM operation_lines l
       JOIN products pr ON pr.id = l.product_id
       JOIN operations o ON o.id = l.operation_id
       LEFT JOIN stock_quants q ON q.product_id = l.product_id AND q.location_id = o.source_location_id
      WHERE l.operation_id = $1
      ORDER BY l.position, l.id`,
    [id],
  );
  return { ...op, lines };
}

/* ------------------------------------------------------------------ routes */

operationsRouter.get(
  '/',
  h(async (req, res) => {
    const f = parse(listSchema, req.query);
    res.json({ items: await listOperations(pool, { ...f, status: f.status || undefined }) });
  }),
);

operationsRouter.get(
  '/:id',
  h(async (req, res) => {
    res.json(await getOperation(pool, parse(idParam, req.params.id)));
  }),
);

operationsRouter.post(
  '/',
  h(async (req, res) => {
    const me = currentUser(req);
    const input = parse(createSchema, req.body);
    const id = await tx((c) => createOperation(c, input, me.id));
    broadcast(['operations']);
    res.status(201).json(await getOperation(pool, id));
  }),
);

operationsRouter.patch(
  '/:id',
  h(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const input = parse(patchSchema, req.body);
    await tx((c) => updateOperation(c, id, input));
    broadcast(['operations', 'stock']);
    res.json(await getOperation(pool, id));
  }),
);

// "To Do": draft -> ready / waiting
operationsRouter.post(
  '/:id/confirm',
  h(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const result = await tx((c) => confirmOperation(c, id));
    broadcast(['operations', 'stock']);
    res.json({ ...(await getOperation(pool, id)), shortages: result.shortages });
  }),
);

operationsRouter.post(
  '/:id/check-availability',
  h(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const result = await tx((c) => checkAvailability(c, id));
    broadcast(['operations', 'stock']);
    res.json({ ...(await getOperation(pool, id)), shortages: result.shortages });
  }),
);

operationsRouter.post(
  '/:id/validate',
  h(async (req, res) => {
    const me = currentUser(req);
    const id = parse(idParam, req.params.id);
    const { readied } = await tx((c) => validateOperation(c, id, me.id));
    broadcast(['operations', 'stock', 'moves'], { validated: id });
    res.json({ ...(await getOperation(pool, id)), readied });
  }),
);

operationsRouter.post(
  '/:id/cancel',
  h(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const { readied } = await tx((c) => cancelOperation(c, id));
    broadcast(['operations', 'stock']);
    res.json({ ...(await getOperation(pool, id)), readied });
  }),
);

operationsRouter.delete(
  '/:id',
  h(async (req, res) => {
    const id = parse(idParam, req.params.id);
    await tx((c) => deleteOperation(c, id));
    broadcast(['operations']);
    res.status(204).end();
  }),
);
