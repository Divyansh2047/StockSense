/**
 * Demo data: two warehouses, a realistic catalog and three weeks of history built
 * through the same service functions the API uses, so quants, references and the
 * ledger are always consistent.
 *
 * Demo sign-ins (change or delete them before going live):
 *   manager  / Stock@2026!   (inventory manager)
 *   picker01 / Stock@2026!   (warehouse staff)
 */
import bcrypt from 'bcryptjs';
import type pg from 'pg';
import { createOperation, validateOperation, confirmOperation, type OpType } from '../modules/operations/service.js';
import type { Client } from './pool.js';

export const DEMO_PASSWORD = 'Stock@2026!';

type Line = [sku: string, qty: number];

export async function seed(pool: pg.Pool, opts: { force?: boolean } = {}): Promise<string> {
  const existing = await pool.query('SELECT count(*)::int AS n FROM users');
  if (existing.rows[0].n > 0 && !opts.force) return 'Seed skipped: the database already has users.';

  const c = (await pool.connect()) as Client;
  try {
    await c.query('BEGIN');
    const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
    const users = await c.query(
      `INSERT INTO users (login_id, email, name, password_hash, role) VALUES
         ('manager',  'manager@stocksense.local', 'Aarav Mehta', $1, 'manager'),
         ('picker01', 'picker01@stocksense.local', 'Riya Desai', $1, 'staff')
       RETURNING id, login_id`,
      [hash],
    );
    const managerId = users.rows.find((u) => u.login_id === 'manager').id as number;
    const staffId = users.rows.find((u) => u.login_id === 'picker01').id as number;

    const wh = await c.query(
      `INSERT INTO warehouses (name, short_code, address) VALUES
         ('Main Warehouse', 'WH', 'Plot 21, GIDC Phase II, Naroda, Ahmedabad 382330'),
         ('Bengaluru Hub', 'BLR', 'Survey 44, Peenya Industrial Area, Bengaluru 560058')
       RETURNING id, short_code`,
    );
    const whId = (code: string) => wh.rows.find((w) => w.short_code === code).id as number;

    const locs = await c.query(
      `INSERT INTO locations (name, short_code, warehouse_id) VALUES
         ('Main store', 'Stock1', $1), ('Overflow room', 'Stock2', $1),
         ('Production rack', 'Production', $1), ('Dispatch bay', 'Dispatch', $1),
         ('Stock', 'Stock', $2)
       RETURNING id, short_code, warehouse_id`,
      [whId('WH'), whId('BLR')],
    );
    const loc = (wcode: string, code: string) =>
      locs.rows.find((l) => l.short_code === code && l.warehouse_id === whId(wcode)).id as number;

    const cats = await c.query(
      `INSERT INTO categories (name) VALUES ('Furniture'), ('Raw material'), ('Hardware'), ('Consumables'), ('Packaging')
       RETURNING id, name`,
    );
    const cat = (name: string) => cats.rows.find((r) => r.name === name).id as number;

    const catalog: [string, string, string, string, number, number, number][] = [
      ['DESK001', 'Desk', 'Furniture', 'Units', 3000, 10, 60],
      ['TBL001', 'Table', 'Furniture', 'Units', 3000, 10, 60],
      ['CHR004', 'Office chair', 'Furniture', 'Units', 4200, 12, 50],
      ['CAB210', 'Filing cabinet', 'Furniture', 'Units', 5600, 4, 20],
      ['STL010', 'Steel rod 10 mm', 'Raw material', 'kg', 72, 150, 800],
      ['PLY018', 'Plywood sheet 18 mm', 'Raw material', 'Sheets', 1450, 20, 120],
      ['BLT220', 'Hex bolt M8', 'Hardware', 'Units', 4, 500, 3000],
      ['HNG045', 'Cabinet hinge', 'Hardware', 'Units', 38, 200, 1000],
      ['PNT031', 'Primer paint 4 L', 'Consumables', 'Cans', 850, 8, 40],
      ['GLU007', 'Wood glue 1 kg', 'Consumables', 'kg', 320, 10, 40],
      ['BOX060', 'Shipping carton L', 'Packaging', 'Units', 45, 100, 600],
      ['WRP002', 'Stretch wrap roll', 'Packaging', 'Rolls', 260, 6, 30],
    ];
    const productIds = new Map<string, number>();
    for (const [sku, name, category, uom, cost, min, max] of catalog) {
      const r = await c.query(
        `INSERT INTO products (sku, name, category_id, uom, unit_cost, reorder_min, reorder_max)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [sku, name, cat(category), uom, cost, min, max],
      );
      productIds.set(sku, r.rows[0].id);
    }

    const partners = await c.query(
      `INSERT INTO partners (name, kind, email, phone, address) VALUES
         ('Azure Interior', 'customer', 'orders@azureinterior.in', '+91 79 4012 7731', '14 Law Garden Rd, Ahmedabad'),
         ('Deco Addict', 'customer', 'purchase@decoaddict.in', '+91 22 6120 4418', 'Lower Parel, Mumbai'),
         ('Gemini Furniture', 'customer', 'ops@geminifurniture.in', '+91 80 4127 9902', 'Indiranagar, Bengaluru'),
         ('Ready Mat', 'customer', 'hello@readymat.in', '+91 20 6711 3056', 'Hinjawadi, Pune'),
         ('Kalinga Steel Supply', 'vendor', 'sales@kalingasteel.in', '+91 674 255 8120', 'Chandaka Industrial Estate, Bhubaneswar'),
         ('Lumen Office Works', 'vendor', 'dispatch@lumenoffice.in', '+91 265 233 4079', 'Makarpura GIDC, Vadodara'),
         ('Sahyadri Timber Co.', 'vendor', 'accounts@sahyadritimber.in', '+91 231 266 1504', 'Shiroli MIDC, Kolhapur'),
         ('Wood Corner', 'both', 'team@woodcorner.in', '+91 141 402 8876', 'Sitapura, Jaipur')
       RETURNING id, name`,
    );
    const partner = (name: string) => partners.rows.find((p) => p.name === name).id as number;

    const dayOffset = async (days: number) =>
      (await c.query('SELECT (CURRENT_DATE + $1::int)::text AS d', [days])).rows[0].d as string;
    const at = (daysAgo: number, hour: number, minute = 0) => {
      const d = new Date();
      d.setDate(d.getDate() - daysAgo);
      d.setHours(hour, minute, 0, 0);
      return d;
    };

    let count = 0;
    async function doc(spec: {
      type: OpType;
      partner?: string;
      src?: number;
      dst?: number;
      lines: Line[];
      scheduled: number; // days from today, negative = past
      state: 'draft' | 'confirm' | 'done';
      doneAt?: [daysAgo: number, hour: number, minute?: number];
      by?: number;
      address?: string;
      notes?: string;
    }) {
      const id = await createOperation(
        c,
        {
          type: spec.type,
          partnerId: spec.partner ? partner(spec.partner) : null,
          sourceLocationId: spec.src ?? null,
          destLocationId: spec.dst ?? null,
          scheduledDate: await dayOffset(spec.scheduled),
          responsibleId: spec.by ?? managerId,
          deliveryAddress: spec.address ?? '',
          notes: spec.notes ?? '',
          lines: spec.lines.map(([sku, quantity]) => ({ productId: productIds.get(sku)!, quantity })),
        },
        spec.by ?? managerId,
      );
      // backdate creation so the documents read naturally
      await c.query(`UPDATE operations SET created_at = CURRENT_DATE + $2::int - interval '1 day' + interval '9 hours' WHERE id = $1`, [
        id,
        Math.min(spec.scheduled, 0),
      ]);
      if (spec.state === 'confirm') await confirmOperation(c, id);
      if (spec.state === 'done') {
        const [d, hr, mi] = spec.doneAt ?? [Math.max(-spec.scheduled, 0), 11];
        await validateOperation(c, id, spec.by ?? managerId, at(d, hr, mi ?? 0));
      }
      count++;
      return id;
    }

    const S1 = loc('WH', 'Stock1');
    const S2 = loc('WH', 'Stock2');
    const PROD = loc('WH', 'Production');
    const BLR = loc('BLR', 'Stock');

    // ---- three weeks ago: the big opening receipts
    await doc({ type: 'receipt', partner: 'Kalinga Steel Supply', dst: S1, lines: [['STL010', 600]], scheduled: -21, state: 'done', doneAt: [21, 10, 20] });
    await doc({ type: 'receipt', partner: 'Lumen Office Works', dst: S1, lines: [['DESK001', 60], ['TBL001', 50], ['CHR004', 44], ['CAB210', 12]], scheduled: -20, state: 'done', doneAt: [20, 11, 5] });
    await doc({ type: 'receipt', partner: 'Sahyadri Timber Co.', dst: S2, lines: [['PLY018', 80], ['GLU007', 25]], scheduled: -19, state: 'done', doneAt: [19, 9, 40], by: staffId });
    await doc({ type: 'receipt', partner: 'Wood Corner', dst: S2, lines: [['BLT220', 2400], ['HNG045', 800], ['PNT031', 30]], scheduled: -18, state: 'done', doneAt: [18, 15, 10], by: staffId });
    await doc({ type: 'receipt', partner: 'Wood Corner', dst: S1, lines: [['BOX060', 400], ['WRP002', 20]], scheduled: -18, state: 'done', doneAt: [18, 16, 40], by: staffId });
    await doc({ type: 'receipt', partner: 'Lumen Office Works', dst: BLR, lines: [['DESK001', 18], ['CHR004', 20]], scheduled: -17, state: 'done', doneAt: [17, 12, 30] });

    // ---- production pulls raw material
    await doc({ type: 'internal', src: S1, dst: PROD, lines: [['STL010', 200]], scheduled: -16, state: 'done', doneAt: [16, 9, 15], by: staffId });
    await doc({ type: 'internal', src: S2, dst: PROD, lines: [['PLY018', 30], ['GLU007', 8]], scheduled: -14, state: 'done', doneAt: [14, 10, 0], by: staffId });

    // ---- deliveries through the fortnight
    const deliveries: [string, Line[], number, number][] = [
      ['Azure Interior', [['DESK001', 6], ['CHR004', 6]], 15, 14],
      ['Deco Addict', [['TBL001', 4], ['CAB210', 2]], 13, 11],
      ['Gemini Furniture', [['CHR004', 8], ['DESK001', 4]], 11, 16],
      ['Ready Mat', [['TBL001', 6]], 10, 12],
      ['Azure Interior', [['CHR004', 6], ['TBL001', 3]], 8, 15],
      ['Deco Addict', [['DESK001', 8], ['BOX060', 60]], 6, 10],
      ['Gemini Furniture', [['CAB210', 3], ['CHR004', 4]], 4, 13],
      ['Ready Mat', [['DESK001', 5], ['BOX060', 80]], 2, 11],
      ['Azure Interior', [['TBL001', 7]], 1, 16],
    ];
    for (const [who, lines, daysAgo, hour] of deliveries) {
      await doc({ type: 'delivery', partner: who, src: S1, lines, scheduled: -daysAgo, state: 'done', doneAt: [daysAgo, hour, 25], by: staffId });
    }
    await doc({ type: 'delivery', partner: 'Gemini Furniture', src: BLR, lines: [['DESK001', 5], ['CHR004', 8]], scheduled: -5, state: 'done', doneAt: [5, 14, 0] });

    // ---- the example from the brief, in miniature: damaged steel written off
    await doc({ type: 'adjustment', src: PROD, lines: [['STL010', 197]], scheduled: -9, state: 'done', doneAt: [9, 17, 30], notes: '3 kg damaged in handling' });
    await doc({ type: 'adjustment', src: S2, lines: [['BLT220', 2360]], scheduled: -3, state: 'done', doneAt: [3, 18, 10], notes: 'Cycle count, 40 bolts missing', by: staffId });
    await doc({ type: 'internal', src: S2, dst: S1, lines: [['HNG045', 150]], scheduled: -7, state: 'done', doneAt: [7, 12, 0], by: staffId });
    await doc({ type: 'delivery', partner: 'Wood Corner', src: S1, lines: [['WRP002', 18]], scheduled: -6, state: 'done', doneAt: [6, 16, 45] });
    await doc({ type: 'delivery', partner: 'Ready Mat', src: S2, lines: [['PNT031', 30]], scheduled: -3, state: 'done', doneAt: [3, 11, 20], by: staffId });

    // ---- open work, so the dashboard has something to say
    await doc({ type: 'receipt', partner: 'Lumen Office Works', dst: S1, lines: [['CHR004', 30], ['DESK001', 12]], scheduled: 0, state: 'confirm' });
    await doc({ type: 'receipt', partner: 'Kalinga Steel Supply', dst: S1, lines: [['STL010', 400]], scheduled: -2, state: 'confirm' });
    await doc({ type: 'receipt', partner: 'Sahyadri Timber Co.', dst: S2, lines: [['PLY018', 60], ['GLU007', 20]], scheduled: 3, state: 'draft' });
    await doc({ type: 'receipt', partner: 'Wood Corner', dst: S2, lines: [['WRP002', 24], ['BOX060', 300]], scheduled: 5, state: 'confirm' });

    await doc({ type: 'delivery', partner: 'Azure Interior', src: S1, lines: [['DESK001', 5], ['TBL001', 4]], scheduled: 0, state: 'confirm', address: '14 Law Garden Rd, Ahmedabad' });
    await doc({ type: 'delivery', partner: 'Deco Addict', src: S1, lines: [['CHR004', 40]], scheduled: 1, state: 'confirm', address: 'Lower Parel, Mumbai' });
    await doc({ type: 'delivery', partner: 'Ready Mat', src: S1, lines: [['CAB210', 2]], scheduled: -1, state: 'confirm', address: 'Hinjawadi, Pune' });
    await doc({ type: 'delivery', partner: 'Gemini Furniture', src: S1, lines: [['TBL001', 6], ['BOX060', 40]], scheduled: 4, state: 'draft', address: 'Indiranagar, Bengaluru' });

    await doc({ type: 'internal', src: S1, dst: PROD, lines: [['STL010', 120]], scheduled: 1, state: 'confirm', by: staffId });
    await doc({ type: 'delivery', partner: 'Gemini Furniture', src: BLR, lines: [['DESK001', 4]], scheduled: 2, state: 'confirm' });

    await c.query('COMMIT');
    return `Seeded ${catalog.length} products, 2 warehouses and ${count} documents. Sign in as "manager" or "picker01" with password ${DEMO_PASSWORD}`;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}
