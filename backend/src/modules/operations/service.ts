/**
 * Inventory operations: receipts, deliveries, internal transfers, adjustments.
 *
 * Lifecycle
 *   receipt     draft -> ready -> done           ("To Do" then "Validate")
 *   delivery    draft -> waiting | ready -> done  (waiting = not enough free stock yet)
 *   internal    draft -> waiting | ready -> done
 *   adjustment  draft -> done                     (counted quantity replaces system quantity)
 *   any state except done can be canceled.
 *
 * Every function here takes a transaction client. Quants are always locked in
 * product/location order so two validations touching the same stock cannot deadlock.
 */
import type { Client } from '../../db/pool.js';
import { many, one } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

export type OpType = 'receipt' | 'delivery' | 'internal' | 'adjustment';
export type OpStatus = 'draft' | 'waiting' | 'ready' | 'done' | 'canceled';

export const OP_CODES: Record<OpType, string> = { receipt: 'IN', delivery: 'OUT', internal: 'INT', adjustment: 'ADJ' };

interface OpRow {
  id: number;
  reference: string;
  type: OpType;
  status: OpStatus;
  warehouseId: number;
  partnerId: number | null;
  sourceLocationId: number;
  destLocationId: number;
  scheduledDate: string;
}
interface LineRow {
  id: number;
  productId: number;
  quantity: number;
  reserved: number;
}
interface LocationRow {
  id: number;
  type: 'internal' | 'vendor' | 'customer' | 'inventory';
  warehouseId: number | null;
}

export interface LineInput {
  productId: number;
  quantity: number;
}
export interface OperationInput {
  type: OpType;
  partnerId?: number | null;
  sourceLocationId?: number | null;
  destLocationId?: number | null;
  scheduledDate?: string | null;
  responsibleId?: number | null;
  deliveryAddress?: string;
  notes?: string;
  lines: LineInput[];
}
export type OperationPatch = Partial<Omit<OperationInput, 'type' | 'lines'>> & { lines?: LineInput[] };

export interface Shortage {
  productId: number;
  needed: number;
  available: number;
}

// Work in thousandths so 0.1 + 0.2 style float drift never decides stock availability.
const milli = (n: number) => Math.round(n * 1000);

/* ------------------------------------------------------------------ lookups */

const OP_COLS = `id, reference, type, status, warehouse_id AS "warehouseId", partner_id AS "partnerId",
  source_location_id AS "sourceLocationId", dest_location_id AS "destLocationId", scheduled_date AS "scheduledDate"`;

async function lockOperation(c: Client, id: number): Promise<OpRow> {
  const op = await one<OpRow>(c, `SELECT ${OP_COLS} FROM operations WHERE id = $1 FOR UPDATE`, [id]);
  if (!op) throw notFound('Operation');
  return op;
}

async function linesOf(c: Client, operationId: number): Promise<LineRow[]> {
  return many<LineRow>(
    c,
    `SELECT id, product_id AS "productId", quantity, reserved FROM operation_lines
      WHERE operation_id = $1 ORDER BY product_id`,
    [operationId],
  );
}

async function location(c: Client, id: number): Promise<LocationRow> {
  const loc = await one<LocationRow>(c, `SELECT id, type, warehouse_id AS "warehouseId" FROM locations WHERE id = $1`, [id]);
  if (!loc) throw badRequest('Location not found.', { location: 'Pick a valid location' });
  return loc;
}

async function virtualLocation(c: Client, type: 'vendor' | 'customer' | 'inventory'): Promise<number> {
  const row = await one<{ id: number }>(c, 'SELECT id FROM locations WHERE type = $1', [type]);
  if (!row) throw new Error(`Virtual location "${type}" is missing. Run migrations.`);
  return row.id;
}

async function internalLocation(c: Client, id: number | null | undefined, field: string): Promise<LocationRow> {
  if (!id) throw badRequest('Pick a location.', { [field]: 'Pick a location' });
  const loc = await location(c, id);
  if (loc.type !== 'internal') throw badRequest('That is not a warehouse location.', { [field]: 'Pick a warehouse location' });
  return loc;
}

/** Next reference like WH/IN/0007, unique per warehouse and operation type. */
export async function nextReference(c: Client, warehouseId: number, type: OpType): Promise<string> {
  const code = OP_CODES[type];
  const wh = await one<{ shortCode: string }>(c, 'SELECT upper(short_code) AS "shortCode" FROM warehouses WHERE id = $1', [warehouseId]);
  if (!wh) throw badRequest('Warehouse not found.');
  const row = await one<{ n: number }>(
    c,
    `INSERT INTO sequences (warehouse_id, code, next_value) VALUES ($1, $2, 2)
     ON CONFLICT (warehouse_id, code) DO UPDATE SET next_value = sequences.next_value + 1
     RETURNING next_value - 1 AS n`,
    [warehouseId, code],
  );
  return `${wh.shortCode}/${code}/${String(row!.n).padStart(4, '0')}`;
}

/** Resolve source/destination for a type and check they make sense together. */
async function resolveLocations(
  c: Client,
  type: OpType,
  src: number | null | undefined,
  dst: number | null | undefined,
): Promise<{ source: number; dest: number; warehouseId: number }> {
  switch (type) {
    case 'receipt': {
      const d = await internalLocation(c, dst, 'destLocationId');
      return { source: await virtualLocation(c, 'vendor'), dest: d.id, warehouseId: d.warehouseId! };
    }
    case 'delivery': {
      const s = await internalLocation(c, src, 'sourceLocationId');
      return { source: s.id, dest: await virtualLocation(c, 'customer'), warehouseId: s.warehouseId! };
    }
    case 'internal': {
      const s = await internalLocation(c, src, 'sourceLocationId');
      const d = await internalLocation(c, dst, 'destLocationId');
      if (s.id === d.id) throw badRequest('Source and destination must differ.', { destLocationId: 'Pick a different location' });
      return { source: s.id, dest: d.id, warehouseId: s.warehouseId! };
    }
    case 'adjustment': {
      const s = await internalLocation(c, src, 'sourceLocationId');
      return { source: s.id, dest: await virtualLocation(c, 'inventory'), warehouseId: s.warehouseId! };
    }
  }
}

function normaliseLines(type: OpType, lines: LineInput[]): LineInput[] {
  const merged = new Map<number, number>();
  for (const l of lines) {
    if (type !== 'adjustment' && !(l.quantity > 0)) {
      throw badRequest('Quantities must be greater than zero.', { lines: 'Every product line needs a quantity above zero' });
    }
    // adjustments carry the counted quantity; a repeated product keeps the last count
    merged.set(l.productId, type === 'adjustment' ? l.quantity : (merged.get(l.productId) ?? 0) + l.quantity);
  }
  return [...merged].map(([productId, quantity]) => ({ productId, quantity }));
}

async function writeLines(c: Client, operationId: number, type: OpType, lines: LineInput[]): Promise<void> {
  const clean = normaliseLines(type, lines);
  if (clean.length) {
    const found = await many<{ id: number }>(c, 'SELECT id FROM products WHERE id = ANY($1::bigint[]) AND NOT archived', [
      clean.map((l) => l.productId),
    ]);
    if (found.length !== clean.length) throw badRequest('One of the products no longer exists.', { lines: 'Remove unknown products' });
  }
  await c.query('DELETE FROM operation_lines WHERE operation_id = $1', [operationId]);
  let position = 0;
  for (const l of clean) {
    await c.query('INSERT INTO operation_lines (operation_id, product_id, quantity, position) VALUES ($1, $2, $3, $4)', [
      operationId,
      l.productId,
      l.quantity,
      position++,
    ]);
  }
}

/* ------------------------------------------------------------------ reservations */

async function lockQuant(c: Client, productId: number, locationId: number): Promise<{ quantity: number; reserved: number }> {
  await c.query(
    `INSERT INTO stock_quants (product_id, location_id) VALUES ($1, $2) ON CONFLICT (product_id, location_id) DO NOTHING`,
    [productId, locationId],
  );
  const q = await one<{ quantity: number; reserved: number }>(
    c,
    'SELECT quantity, reserved FROM stock_quants WHERE product_id = $1 AND location_id = $2 FOR UPDATE',
    [productId, locationId],
  );
  return q!;
}

/** Release whatever an operation holds. */
async function unreserve(c: Client, op: OpRow): Promise<void> {
  for (const line of await linesOf(c, op.id)) {
    if (line.reserved > 0) {
      await c.query(
        'UPDATE stock_quants SET reserved = GREATEST(reserved - $3, 0) WHERE product_id = $1 AND location_id = $2',
        [line.productId, op.sourceLocationId, line.reserved],
      );
    }
  }
  await c.query('UPDATE operation_lines SET reserved = 0 WHERE operation_id = $1', [op.id]);
}

/**
 * Try to reserve every line of an outgoing operation at its source location.
 * All or nothing: if any product is short the operation waits and holds nothing,
 * so a half-reserved order never blocks stock another order could ship.
 */
async function reserve(c: Client, op: OpRow): Promise<{ status: OpStatus; shortages: Shortage[] }> {
  await unreserve(c, op);
  const lines = await linesOf(c, op.id);
  const shortages: Shortage[] = [];
  const quants = new Map<number, { quantity: number; reserved: number }>();
  for (const line of lines) {
    const q = await lockQuant(c, line.productId, op.sourceLocationId);
    quants.set(line.productId, q);
    const free = milli(q.quantity) - milli(q.reserved);
    if (free < milli(line.quantity)) shortages.push({ productId: line.productId, needed: line.quantity, available: Math.max(free, 0) / 1000 });
  }
  const status: OpStatus = shortages.length ? 'waiting' : 'ready';
  if (!shortages.length) {
    for (const line of lines) {
      await c.query('UPDATE stock_quants SET reserved = reserved + $3 WHERE product_id = $1 AND location_id = $2', [
        line.productId,
        op.sourceLocationId,
        line.quantity,
      ]);
      await c.query('UPDATE operation_lines SET reserved = quantity WHERE id = $1', [line.id]);
    }
  }
  await c.query('UPDATE operations SET status = $2 WHERE id = $1', [op.id, status]);
  return { status, shortages };
}

const needsReservation = (type: OpType) => type === 'delivery' || type === 'internal';

/**
 * After stock arrives somewhere, give waiting operations that ship from there a
 * chance to become ready, oldest scheduled first.
 */
export async function recheckWaiting(c: Client, touched: { productId: number; locationId: number }[]): Promise<number[]> {
  if (!touched.length) return [];
  const products = [...new Set(touched.map((t) => t.productId))];
  const locations = [...new Set(touched.map((t) => t.locationId))];
  const waiting = await many<{ id: number }>(
    c,
    `SELECT DISTINCT o.id, o.scheduled_date, o.created_at FROM operations o
       JOIN operation_lines l ON l.operation_id = o.id
      WHERE o.status = 'waiting' AND o.type IN ('delivery', 'internal')
        AND o.source_location_id = ANY($2::bigint[]) AND l.product_id = ANY($1::bigint[])
      ORDER BY o.scheduled_date, o.created_at, o.id`,
    [products, locations],
  );
  const readied: number[] = [];
  for (const w of waiting) {
    const op = await lockOperation(c, w.id);
    if (op.status !== 'waiting') continue;
    const { status } = await reserve(c, op);
    if (status === 'ready') readied.push(op.id);
  }
  return readied;
}

/* ------------------------------------------------------------------ commands */

export async function createOperation(c: Client, input: OperationInput, userId: number | null): Promise<number> {
  const locs = await resolveLocations(c, input.type, input.sourceLocationId, input.destLocationId);
  if (input.partnerId) {
    const p = await one(c, 'SELECT 1 FROM partners WHERE id = $1', [input.partnerId]);
    if (!p) throw badRequest('Contact not found.', { partnerId: 'Pick a valid contact' });
  }
  const reference = await nextReference(c, locs.warehouseId, input.type);
  const row = await one<{ id: number }>(
    c,
    `INSERT INTO operations (reference, type, warehouse_id, partner_id, source_location_id, dest_location_id,
                             scheduled_date, responsible_id, delivery_address, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::date, CURRENT_DATE), $8, $9, $10, $11) RETURNING id`,
    [
      reference,
      input.type,
      locs.warehouseId,
      input.partnerId ?? null,
      locs.source,
      locs.dest,
      input.scheduledDate ?? null,
      input.responsibleId ?? userId,
      input.deliveryAddress ?? '',
      input.notes ?? '',
      userId,
    ],
  );
  await writeLines(c, row!.id, input.type, input.lines);
  return row!.id;
}

export async function updateOperation(c: Client, id: number, patch: OperationPatch): Promise<void> {
  const op = await lockOperation(c, id);
  if (op.status === 'done' || op.status === 'canceled') throw conflict(`${op.reference} is ${op.status} and can no longer be edited.`);

  const touchesStock = patch.lines !== undefined || patch.sourceLocationId !== undefined || patch.destLocationId !== undefined;
  const holding = needsReservation(op.type) && (op.status === 'ready' || op.status === 'waiting');
  if (touchesStock && holding) await unreserve(c, op);

  if (patch.sourceLocationId !== undefined || patch.destLocationId !== undefined) {
    const locs = await resolveLocations(
      c,
      op.type,
      patch.sourceLocationId ?? op.sourceLocationId,
      patch.destLocationId ?? op.destLocationId,
    );
    // the reference already encodes the warehouse, so it cannot move to another one
    if (locs.warehouseId !== op.warehouseId) {
      throw badRequest('Pick a location in the same warehouse as this document.', { location: 'Different warehouse' });
    }
    await c.query('UPDATE operations SET source_location_id = $2, dest_location_id = $3 WHERE id = $1', [id, locs.source, locs.dest]);
    op.sourceLocationId = locs.source;
    op.destLocationId = locs.dest;
  }
  if (patch.partnerId) {
    const p = await one(c, 'SELECT 1 FROM partners WHERE id = $1', [patch.partnerId]);
    if (!p) throw badRequest('Contact not found.', { partnerId: 'Pick a valid contact' });
  }

  await c.query(
    `UPDATE operations SET
       partner_id       = CASE WHEN $2 THEN $3::bigint ELSE partner_id END,
       scheduled_date   = COALESCE($4::date, scheduled_date),
       responsible_id   = CASE WHEN $5 THEN $6::bigint ELSE responsible_id END,
       delivery_address = COALESCE($7, delivery_address),
       notes            = COALESCE($8, notes)
     WHERE id = $1`,
    [
      id,
      patch.partnerId !== undefined,
      patch.partnerId ?? null,
      patch.scheduledDate ?? null,
      patch.responsibleId !== undefined,
      patch.responsibleId ?? null,
      patch.deliveryAddress ?? null,
      patch.notes ?? null,
    ],
  );

  if (patch.lines !== undefined) await writeLines(c, id, op.type, patch.lines);
  if (touchesStock && holding) await reserve(c, op);
}

/** "To Do": draft becomes ready (or waiting when stock is short). */
export async function confirmOperation(c: Client, id: number): Promise<{ status: OpStatus; shortages: Shortage[] }> {
  const op = await lockOperation(c, id);
  if (op.status !== 'draft') throw conflict(`${op.reference} is already ${op.status}.`);
  const lines = await linesOf(c, id);
  if (!lines.length) throw badRequest('Add at least one product first.', { lines: 'Add at least one product' });
  if (needsReservation(op.type)) return reserve(c, op);
  await c.query(`UPDATE operations SET status = 'ready' WHERE id = $1`, [id]);
  return { status: 'ready', shortages: [] };
}

/** Re-run availability for a waiting (or ready) delivery or transfer. */
export async function checkAvailability(c: Client, id: number): Promise<{ status: OpStatus; shortages: Shortage[] }> {
  const op = await lockOperation(c, id);
  if (!needsReservation(op.type)) throw badRequest('Only deliveries and transfers reserve stock.');
  if (op.status !== 'waiting' && op.status !== 'ready') throw conflict(`${op.reference} is ${op.status}.`);
  return reserve(c, op);
}

async function insertMove(
  c: Client,
  op: OpRow,
  productId: number,
  from: number,
  to: number,
  quantity: number,
  userId: number | null,
  at: Date | null,
) {
  await c.query(
    `INSERT INTO stock_moves (operation_id, reference, kind, product_id, from_location_id, to_location_id,
                              quantity, unit_cost, partner_id, user_id, done_at)
     SELECT $1, $2, $3, $4, $5, $6, $7, p.unit_cost, $8, $9, COALESCE($10::timestamptz, now())
       FROM products p WHERE p.id = $4`,
    [op.id, op.reference, op.type, productId, from, to, quantity, op.partnerId, userId, at],
  );
}

/**
 * Validate: apply the operation to stock and write the ledger.
 * `at` lets the seed script backdate history; the API always uses now().
 */
export async function validateOperation(
  c: Client,
  id: number,
  userId: number | null,
  at: Date | null = null,
): Promise<{ readied: number[] }> {
  let op = await lockOperation(c, id);
  if (op.status === 'done') throw conflict(`${op.reference} is already done.`);
  if (op.status === 'canceled') throw conflict(`${op.reference} was canceled.`);

  if (op.status === 'draft' && op.type !== 'adjustment') {
    const confirmed = await confirmOperation(c, id);
    op = { ...op, status: confirmed.status };
  }
  if (op.status === 'waiting') {
    // stock may have arrived since the last check
    const retry = await reserve(c, op);
    if (retry.status !== 'ready') {
      const names = await many<{ name: string }>(c, 'SELECT name FROM products WHERE id = ANY($1::bigint[]) ORDER BY name', [
        retry.shortages.map((s) => s.productId),
      ]);
      throw conflict(`Not enough stock to validate ${op.reference}: ${names.map((n) => n.name).join(', ')}.`);
    }
  }

  const lines = await linesOf(c, id);
  if (!lines.length) throw badRequest('Add at least one product first.', { lines: 'Add at least one product' });
  const arrived: { productId: number; locationId: number }[] = [];

  for (const line of lines) {
    switch (op.type) {
      case 'receipt': {
        await lockQuant(c, line.productId, op.destLocationId);
        await c.query('UPDATE stock_quants SET quantity = quantity + $3 WHERE product_id = $1 AND location_id = $2', [
          line.productId,
          op.destLocationId,
          line.quantity,
        ]);
        await insertMove(c, op, line.productId, op.sourceLocationId, op.destLocationId, line.quantity, userId, at);
        arrived.push({ productId: line.productId, locationId: op.destLocationId });
        break;
      }
      case 'delivery':
      case 'internal': {
        const q = await lockQuant(c, line.productId, op.sourceLocationId);
        if (milli(q.quantity) < milli(line.quantity)) throw conflict(`Not enough stock to validate ${op.reference}.`);
        await c.query(
          `UPDATE stock_quants SET quantity = quantity - $3, reserved = GREATEST(reserved - $4, 0)
            WHERE product_id = $1 AND location_id = $2`,
          [line.productId, op.sourceLocationId, line.quantity, line.reserved],
        );
        if (op.type === 'internal') {
          await lockQuant(c, line.productId, op.destLocationId);
          await c.query('UPDATE stock_quants SET quantity = quantity + $3 WHERE product_id = $1 AND location_id = $2', [
            line.productId,
            op.destLocationId,
            line.quantity,
          ]);
          arrived.push({ productId: line.productId, locationId: op.destLocationId });
        }
        await c.query('UPDATE operation_lines SET reserved = 0 WHERE id = $1', [line.id]);
        await insertMove(c, op, line.productId, op.sourceLocationId, op.destLocationId, line.quantity, userId, at);
        break;
      }
      case 'adjustment': {
        const q = await lockQuant(c, line.productId, op.sourceLocationId);
        const diff = (milli(line.quantity) - milli(q.quantity)) / 1000;
        await c.query('UPDATE operation_lines SET system_quantity = $2 WHERE id = $1', [line.id, q.quantity]);
        if (diff === 0) break;
        if (diff < 0 && milli(line.quantity) < milli(q.reserved)) {
          // release reservations first so the quant constraint (reserved <= quantity) holds
          await releaseOverReservedBeforeCount(c, line.productId, op.sourceLocationId, line.quantity);
        }
        await c.query('UPDATE stock_quants SET quantity = $3 WHERE product_id = $1 AND location_id = $2', [
          line.productId,
          op.sourceLocationId,
          line.quantity,
        ]);
        if (diff > 0) {
          await insertMove(c, op, line.productId, op.destLocationId, op.sourceLocationId, diff, userId, at);
          arrived.push({ productId: line.productId, locationId: op.sourceLocationId });
        } else {
          await insertMove(c, op, line.productId, op.sourceLocationId, op.destLocationId, -diff, userId, at);
        }
        break;
      }
    }
  }

  await c.query(
    `UPDATE operations SET status = 'done', validated_at = COALESCE($3::timestamptz, now()), validated_by = $2 WHERE id = $1`,
    [id, userId, at],
  );
  const readied = await recheckWaiting(c, arrived);
  return { readied };
}

/**
 * A count is about to drop quantity below the reserved amount. Release ready
 * operations (newest first) until the reservation fits under the counted quantity.
 */
async function releaseOverReservedBeforeCount(c: Client, productId: number, locationId: number, counted: number): Promise<void> {
  const ready = await many<{ id: number }>(
    c,
    `SELECT o.id FROM operations o JOIN operation_lines l ON l.operation_id = o.id
      WHERE o.status = 'ready' AND o.source_location_id = $2 AND l.product_id = $1 AND l.reserved > 0
      ORDER BY o.scheduled_date DESC, o.created_at DESC, o.id DESC`,
    [productId, locationId],
  );
  for (const r of ready) {
    const q = await lockQuant(c, productId, locationId);
    if (milli(q.reserved) <= milli(counted)) return;
    const op = await lockOperation(c, r.id);
    await unreserve(c, op);
    await c.query(`UPDATE operations SET status = 'waiting' WHERE id = $1`, [op.id]);
  }
}

export async function cancelOperation(c: Client, id: number): Promise<{ readied: number[] }> {
  const op = await lockOperation(c, id);
  if (op.status === 'done') throw conflict(`${op.reference} is done and cannot be canceled.`);
  if (op.status === 'canceled') return { readied: [] };
  const lines = await linesOf(c, id);
  const held = lines.filter((l) => l.reserved > 0).map((l) => ({ productId: l.productId, locationId: op.sourceLocationId }));
  await unreserve(c, op);
  await c.query(`UPDATE operations SET status = 'canceled' WHERE id = $1`, [id]);
  // freed stock can unblock someone else
  return { readied: await recheckWaiting(c, held) };
}

export async function deleteOperation(c: Client, id: number): Promise<void> {
  const op = await lockOperation(c, id);
  if (op.status !== 'draft' && op.status !== 'canceled') {
    throw conflict('Only draft or canceled documents can be deleted. Cancel it first.');
  }
  await c.query('DELETE FROM operations WHERE id = $1', [id]);
}
