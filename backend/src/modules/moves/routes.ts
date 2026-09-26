import { Router } from 'express';
import { z } from 'zod';
import { many, one, pool } from '../../db/pool.js';
import { filterId, h, isoDate, parse } from '../../lib/http.js';

export const movesRouter = Router();

const listSchema = z.object({
  search: z.string().trim().max(100).optional(),
  kind: z.enum(['receipt', 'delivery', 'internal', 'adjustment', '']).optional(),
  status: z.enum(['draft', 'waiting', 'ready', 'done', 'canceled', '']).optional(),
  direction: z.enum(['in', 'out', 'internal', '']).optional(),
  productId: filterId,
  locationId: filterId,
  warehouseId: filterId,
  categoryId: filterId,
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

/**
 * Move history = the ledger (done moves) plus the planned lines of documents that
 * are not done yet, each with its status. One row per product, so a reference with
 * several products shows up as several rows, as the brief asks.
 */
const MOVES_CTE = `
  WITH moves AS (
    SELECT 'm' || sm.id AS key, sm.operation_id AS "operationId", sm.reference, sm.kind, 'done'::text AS status,
           sm.done_at AS date, sm.product_id, sm.from_location_id, sm.to_location_id, sm.quantity,
           sm.partner_id, sm.user_id
      FROM stock_moves sm
    UNION ALL
    SELECT 'l' || ol.id, o.id, o.reference, o.type, o.status::text,
           o.scheduled_date::timestamptz, ol.product_id, o.source_location_id, o.dest_location_id, ol.quantity,
           o.partner_id, o.responsible_id
      FROM operation_lines ol JOIN operations o ON o.id = ol.operation_id
     WHERE o.status <> 'done'
  )`;

const ROW_SELECT = `
  m.key, m."operationId", m.reference, m.kind, m.status, m.date, m.quantity,
  pr.id AS "productId", pr.name AS "productName", pr.sku, pr.uom,
  fl.id AS "fromId", fl.type AS "fromType",
  CASE WHEN fl.type = 'internal' THEN fw.short_code || '/' || fl.short_code ELSE fl.name END AS "fromName",
  tl.id AS "toId", tl.type AS "toType",
  CASE WHEN tl.type = 'internal' THEN tw.short_code || '/' || tl.short_code ELSE tl.name END AS "toName",
  pa.name AS "partnerName", u.name AS "userName",
  CASE WHEN fl.type = 'internal' AND tl.type = 'internal' THEN 'internal'
       WHEN tl.type = 'internal' THEN 'in'
       ELSE 'out' END AS direction`;

const ROW_FROM = `
  FROM moves m
  JOIN products pr ON pr.id = m.product_id
  JOIN locations fl ON fl.id = m.from_location_id LEFT JOIN warehouses fw ON fw.id = fl.warehouse_id
  JOIN locations tl ON tl.id = m.to_location_id LEFT JOIN warehouses tw ON tw.id = tl.warehouse_id
  LEFT JOIN partners pa ON pa.id = m.partner_id
  LEFT JOIN users u ON u.id = m.user_id`;

movesRouter.get(
  '/',
  h(async (req, res) => {
    const f = parse(listSchema, req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replaceAll('$?', `$${params.length}`));
    };
    if (f.search) {
      add('(m.reference ILIKE $? OR pa.name ILIKE $? OR pr.name ILIKE $? OR pr.sku ILIKE $?)', `%${f.search.replace(/[%_\\]/g, '\\$&')}%`);
    }
    if (f.kind) add('m.kind = $?::operation_type', f.kind);
    if (f.status) add('m.status = $?', f.status);
    if (f.productId) add('m.product_id = $?', f.productId);
    if (f.categoryId) add('pr.category_id = $?', f.categoryId);
    if (f.locationId) add('(m.from_location_id = $? OR m.to_location_id = $?)', f.locationId);
    if (f.warehouseId) add('(fl.warehouse_id = $? OR tl.warehouse_id = $?)', f.warehouseId);
    if (f.from) add('m.date >= $?::date', f.from);
    if (f.to) add(`m.date < ($?::date + interval '1 day')`, f.to);
    if (f.direction === 'in') where.push(`tl.type = 'internal' AND fl.type <> 'internal'`);
    if (f.direction === 'out') where.push(`fl.type = 'internal' AND tl.type <> 'internal'`);
    if (f.direction === 'internal') where.push(`fl.type = 'internal' AND tl.type = 'internal'`);
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const total = await one<{ n: number }>(pool, `${MOVES_CTE} SELECT count(*)::int AS n ${ROW_FROM} ${whereSql}`, params);
    params.push(f.limit, f.offset);
    const items = await many(
      pool,
      `${MOVES_CTE} SELECT ${ROW_SELECT} ${ROW_FROM} ${whereSql}
        ORDER BY m.date DESC, m.reference DESC, pr.name
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ items, total: total?.n ?? 0 });
  }),
);
