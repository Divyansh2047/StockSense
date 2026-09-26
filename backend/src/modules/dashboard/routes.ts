import { Router } from 'express';
import { z } from 'zod';
import { many, one, pool } from '../../db/pool.js';
import { filterId, h, parse } from '../../lib/http.js';
import { listOperations } from '../operations/routes.js';

export const dashboardRouter = Router();

const filtersSchema = z.object({
  warehouseId: filterId,
  locationId: filterId,
  categoryId: filterId,
  type: z.enum(['receipt', 'delivery', 'internal', 'adjustment', '']).optional(),
  status: z.enum(['draft', 'waiting', 'ready', 'done', 'canceled', 'pending', 'late', '']).optional(),
  days: z.coerce.number().int().min(7).max(90).default(14),
});

interface CardRow {
  type: string;
  pending: number;
  ready: number;
  waiting: number;
  late: number;
  upcoming: number;
  today: number;
}

dashboardRouter.get(
  '/',
  h(async (req, res) => {
    const f = parse(filtersSchema, req.query);
    const wh = f.warehouseId ?? null;
    const loc = f.locationId ?? null;
    const cat = f.categoryId ?? null;

    // Stock KPIs, scoped to warehouse / location / category when filtered.
    const kpi = await one<Record<string, number>>(
      pool,
      `WITH stock AS (
         SELECT p.id, p.reorder_min, p.unit_cost, COALESCE(sum(q.quantity), 0) AS on_hand, COALESCE(sum(q.reserved), 0) AS reserved
           FROM products p
           LEFT JOIN stock_quants q ON q.product_id = p.id
            AND q.location_id IN (SELECT l.id FROM locations l
                                   WHERE l.type = 'internal'
                                     AND ($1::bigint IS NULL OR l.warehouse_id = $1)
                                     AND ($2::bigint IS NULL OR l.id = $2))
          WHERE NOT p.archived AND ($3::bigint IS NULL OR p.category_id = $3)
          GROUP BY p.id
       )
       SELECT count(*) FILTER (WHERE on_hand > 0)::int AS "productsInStock",
              count(*)::int AS "productCount",
              COALESCE(sum(on_hand), 0) AS "unitsOnHand",
              COALESCE(sum(reserved), 0) AS "unitsReserved",
              COALESCE(sum(on_hand * unit_cost), 0) AS "stockValue",
              count(*) FILTER (WHERE on_hand > 0 AND on_hand <= reorder_min)::int AS "lowStock",
              count(*) FILTER (WHERE on_hand <= 0)::int AS "outOfStock"
         FROM stock`,
      [wh, loc, cat],
    );

    // Document cards. Late: scheduled before today. Upcoming: scheduled after today.
    const opScope = `
      o.status NOT IN ('done', 'canceled')
      AND ($1::bigint IS NULL OR o.warehouse_id = $1)
      AND ($2::bigint IS NULL OR o.source_location_id = $2 OR o.dest_location_id = $2)
      AND ($3::bigint IS NULL OR EXISTS (SELECT 1 FROM operation_lines l JOIN products p ON p.id = l.product_id
                                          WHERE l.operation_id = o.id AND p.category_id = $3))`;
    const cards = await many<CardRow>(
      pool,
      `SELECT o.type,
              count(*)::int AS pending,
              count(*) FILTER (WHERE o.status = 'ready')::int AS ready,
              count(*) FILTER (WHERE o.status = 'waiting')::int AS waiting,
              count(*) FILTER (WHERE o.scheduled_date < CURRENT_DATE)::int AS late,
              count(*) FILTER (WHERE o.scheduled_date > CURRENT_DATE)::int AS upcoming,
              count(*) FILTER (WHERE o.scheduled_date = CURRENT_DATE)::int AS today
         FROM operations o WHERE ${opScope}
        GROUP BY o.type`,
      [wh, loc, cat],
    );
    const card = (type: string) => {
      const r = cards.find((c) => c.type === type);
      return {
        pending: r?.pending ?? 0,
        ready: r?.ready ?? 0,
        waiting: r?.waiting ?? 0,
        late: r?.late ?? 0,
        upcoming: r?.upcoming ?? 0,
        today: r?.today ?? 0,
      };
    };

    // Value moved in and out per day (quantity x unit cost, so kg and units add up).
    const movement = await many(
      pool,
      `WITH days AS (
         SELECT generate_series(CURRENT_DATE - ($4::int - 1), CURRENT_DATE, interval '1 day')::date AS day
       ), m AS (
         SELECT sm.done_at::date AS day,
                CASE WHEN tl.type = 'internal' AND fl.type <> 'internal' THEN sm.quantity * sm.unit_cost ELSE 0 END AS inbound,
                CASE WHEN fl.type = 'internal' AND tl.type <> 'internal' THEN sm.quantity * sm.unit_cost ELSE 0 END AS outbound,
                CASE WHEN tl.type = 'internal' AND fl.type <> 'internal' THEN 1 ELSE 0 END AS in_count,
                CASE WHEN fl.type = 'internal' AND tl.type <> 'internal' THEN 1 ELSE 0 END AS out_count
           FROM stock_moves sm
           JOIN locations fl ON fl.id = sm.from_location_id
           JOIN locations tl ON tl.id = sm.to_location_id
           JOIN products p ON p.id = sm.product_id
          WHERE sm.done_at >= CURRENT_DATE - ($4::int - 1)
            AND ($1::bigint IS NULL OR fl.warehouse_id = $1 OR tl.warehouse_id = $1)
            AND ($2::bigint IS NULL OR fl.id = $2 OR tl.id = $2)
            AND ($3::bigint IS NULL OR p.category_id = $3)
       )
       SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
              COALESCE(sum(m.inbound), 0) AS "inValue", COALESCE(sum(m.outbound), 0) AS "outValue",
              COALESCE(sum(m.in_count), 0)::int AS "inMoves", COALESCE(sum(m.out_count), 0)::int AS "outMoves"
         FROM days d LEFT JOIN m ON m.day = d.day
        GROUP BY d.day ORDER BY d.day`,
      [wh, loc, cat, f.days],
    );

    const lowStock = await many(
      pool,
      `SELECT * FROM (
         SELECT p.id, p.name, p.sku, p.uom, p.reorder_min AS "reorderMin", p.reorder_max AS "reorderMax",
                COALESCE((SELECT sum(q.quantity) FROM stock_quants q JOIN locations l ON l.id = q.location_id
                           WHERE q.product_id = p.id AND l.type = 'internal'
                             AND ($1::bigint IS NULL OR l.warehouse_id = $1) AND ($2::bigint IS NULL OR l.id = $2)), 0) AS "onHand",
                (SELECT COALESCE(sum(ol.quantity), 0) FROM operation_lines ol JOIN operations o ON o.id = ol.operation_id
                  WHERE ol.product_id = p.id AND o.type = 'receipt' AND o.status NOT IN ('done', 'canceled')) AS incoming
           FROM products p
          WHERE NOT p.archived AND ($3::bigint IS NULL OR p.category_id = $3)
       ) x
       WHERE "onHand" <= "reorderMin"
       ORDER BY ("onHand" <= 0) DESC, ("onHand" / NULLIF("reorderMin", 0)) NULLS FIRST, name
       LIMIT 8`,
      [wh, loc, cat],
    );

    const operations = await listOperations(pool, {
      type: f.type || undefined,
      status: f.status || 'pending',
      warehouseId: f.warehouseId,
      locationId: f.locationId,
      categoryId: f.categoryId,
      limit: 12,
    });

    const recentMoves = await many(
      pool,
      `SELECT sm.id, sm.reference, sm.kind, sm.quantity, sm.done_at AS date, p.name AS "productName", p.uom,
              CASE WHEN tl.type = 'internal' AND fl.type = 'internal' THEN 'internal'
                   WHEN tl.type = 'internal' THEN 'in' ELSE 'out' END AS direction,
              CASE WHEN fl.type = 'internal' THEN fw.short_code || '/' || fl.short_code ELSE fl.name END AS "fromName",
              CASE WHEN tl.type = 'internal' THEN tw.short_code || '/' || tl.short_code ELSE tl.name END AS "toName"
         FROM stock_moves sm
         JOIN products p ON p.id = sm.product_id
         JOIN locations fl ON fl.id = sm.from_location_id LEFT JOIN warehouses fw ON fw.id = fl.warehouse_id
         JOIN locations tl ON tl.id = sm.to_location_id LEFT JOIN warehouses tw ON tw.id = tl.warehouse_id
        WHERE ($1::bigint IS NULL OR fl.warehouse_id = $1 OR tl.warehouse_id = $1)
          AND ($2::bigint IS NULL OR fl.id = $2 OR tl.id = $2)
          AND ($3::bigint IS NULL OR p.category_id = $3)
        ORDER BY sm.done_at DESC, sm.id DESC LIMIT 8`,
      [wh, loc, cat],
    );

    const receipt = card('receipt');
    const delivery = card('delivery');
    const internal = card('internal');
    res.json({
      kpis: {
        ...kpi,
        pendingReceipts: receipt.pending,
        pendingDeliveries: delivery.pending,
        internalScheduled: internal.pending,
        waitingDeliveries: delivery.waiting,
      },
      cards: { receipt, delivery, internal, adjustment: card('adjustment') },
      movement,
      lowStock,
      operations,
      recentMoves,
    });
  }),
);
