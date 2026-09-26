import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { onHand, resetDb, signup, world, type Agent } from './helpers.js';

beforeEach(resetDb);
afterAll(() => pool.end());

async function op(agent: Agent, payload: Record<string, unknown>) {
  const res = await agent.post('/api/operations').send(payload);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: number; reference: string; status: string };
}
async function act(agent: Agent, id: number, action: 'confirm' | 'validate' | 'cancel' | 'check-availability') {
  return agent.post(`/api/operations/${id}/${action}`).send();
}

describe('the inventory flow from the problem statement', () => {
  it('receive 100 kg, move it, deliver 20, write off 3, all in the ledger', async () => {
    const w = await world();
    const { agent } = w;

    // Step 1: receive 100 kg of steel from the vendor
    const receipt = await op(agent, {
      type: 'receipt',
      partnerId: w.vendorId,
      destLocationId: w.stockId,
      lines: [{ productId: w.steelId, quantity: 100 }],
    });
    expect(receipt.reference).toBe('WH/IN/0001');
    expect(receipt.status).toBe('draft');
    expect((await act(agent, receipt.id, 'confirm')).body.status).toBe('ready');
    expect((await act(agent, receipt.id, 'validate')).body.status).toBe('done');
    expect((await onHand(agent, w.steelId)).onHand).toBe(100);

    // Step 2: internal transfer to the production rack. Total unchanged, location updated.
    const move = await op(agent, {
      type: 'internal',
      sourceLocationId: w.stockId,
      destLocationId: w.productionId,
      lines: [{ productId: w.steelId, quantity: 40 }],
    });
    expect(move.reference).toBe('WH/INT/0001');
    expect((await act(agent, move.id, 'validate')).body.status).toBe('done');
    expect((await onHand(agent, w.steelId)).onHand).toBe(100);
    expect((await onHand(agent, w.steelId, w.stockId)).onHand).toBe(60);
    expect((await onHand(agent, w.steelId, w.productionId)).onHand).toBe(40);

    // Step 3: deliver 20 kg
    const delivery = await op(agent, {
      type: 'delivery',
      partnerId: w.customerId,
      sourceLocationId: w.productionId,
      lines: [{ productId: w.steelId, quantity: 20 }],
    });
    expect(delivery.reference).toBe('WH/OUT/0001');
    const confirmed = await act(agent, delivery.id, 'confirm');
    expect(confirmed.body.status).toBe('ready');
    expect((await onHand(agent, w.steelId, w.productionId)).free).toBe(20);
    expect((await act(agent, delivery.id, 'validate')).body.status).toBe('done');
    expect((await onHand(agent, w.steelId)).onHand).toBe(80);

    // Step 4: 3 kg damaged, counted at the production rack
    const count = await op(agent, {
      type: 'adjustment',
      sourceLocationId: w.productionId,
      notes: 'Damaged in handling',
      lines: [{ productId: w.steelId, quantity: 17 }],
    });
    expect(count.reference).toBe('WH/ADJ/0001');
    const adjusted = await act(agent, count.id, 'validate');
    expect(adjusted.body.lines[0].systemQuantity).toBe(20);
    expect((await onHand(agent, w.steelId)).onHand).toBe(77);

    // Everything logged
    const ledger = await agent.get('/api/moves').query({ status: 'done' });
    const rows = ledger.body.items.map((m: Record<string, unknown>) => [m.reference, m.direction, m.quantity, m.fromName, m.toName]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ['WH/IN/0001', 'in', 100, 'Vendors', 'WH/Stock'],
        ['WH/INT/0001', 'internal', 40, 'WH/Stock', 'WH/Production'],
        ['WH/OUT/0001', 'out', 20, 'WH/Production', 'Customers'],
        ['WH/ADJ/0001', 'out', 3, 'WH/Production', 'Inventory adjustment'],
      ]),
    );
    expect(ledger.body.total).toBe(4);
  });
});

describe('reservations and the waiting state', () => {
  it('waits for stock, then becomes ready when a receipt lands', async () => {
    const w = await world();
    const { agent } = w;
    const delivery = await op(agent, {
      type: 'delivery',
      partnerId: w.customerId,
      sourceLocationId: w.stockId,
      lines: [{ productId: w.chairId, quantity: 10 }],
    });
    const confirmed = await act(agent, delivery.id, 'confirm');
    expect(confirmed.body.status).toBe('waiting');
    expect(confirmed.body.shortages[0]).toMatchObject({ productId: w.chairId, needed: 10, available: 0 });
    // the line reports how much the source can give, so the UI can mark it red
    expect(confirmed.body.lines[0].available).toBe(0);

    const blocked = await act(agent, delivery.id, 'validate');
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/Not enough stock/);

    const receipt = await op(agent, { type: 'receipt', destLocationId: w.stockId, lines: [{ productId: w.chairId, quantity: 12 }] });
    const landed = await act(agent, receipt.id, 'validate');
    expect(landed.body.readied).toContain(delivery.id);

    const after = await agent.get(`/api/operations/${delivery.id}`);
    expect(after.body.status).toBe('ready');
    expect(await onHand(agent, w.chairId)).toMatchObject({ onHand: 12, reserved: 10, free: 2 });
  });

  it('gives stock to the first order and hands it over when that order is canceled', async () => {
    const w = await world();
    const { agent } = w;
    const r = await op(agent, { type: 'receipt', destLocationId: w.stockId, lines: [{ productId: w.chairId, quantity: 8 }] });
    await act(agent, r.id, 'validate');

    const first = await op(agent, { type: 'delivery', sourceLocationId: w.stockId, lines: [{ productId: w.chairId, quantity: 6 }] });
    const second = await op(agent, { type: 'delivery', sourceLocationId: w.stockId, lines: [{ productId: w.chairId, quantity: 5 }] });
    expect((await act(agent, first.id, 'confirm')).body.status).toBe('ready');
    expect((await act(agent, second.id, 'confirm')).body.status).toBe('waiting');

    const canceled = await act(agent, first.id, 'cancel');
    expect(canceled.body.status).toBe('canceled');
    expect(canceled.body.readied).toContain(second.id);
    expect(await onHand(agent, w.chairId)).toMatchObject({ onHand: 8, reserved: 5 });
  });

  it('pulls a reservation back when a count finds less stock', async () => {
    const w = await world();
    const { agent } = w;
    const r = await op(agent, { type: 'receipt', destLocationId: w.stockId, lines: [{ productId: w.chairId, quantity: 10 }] });
    await act(agent, r.id, 'validate');
    const d = await op(agent, { type: 'delivery', sourceLocationId: w.stockId, lines: [{ productId: w.chairId, quantity: 8 }] });
    expect((await act(agent, d.id, 'confirm')).body.status).toBe('ready');

    const count = await agent.put('/api/stock').send({ productId: w.chairId, locationId: w.stockId, quantity: 5 });
    expect(count.status).toBe(200);
    expect(count.body).toMatchObject({ reference: 'WH/ADJ/0001', previous: 10, quantity: 5 });
    expect((await agent.get(`/api/operations/${d.id}`)).body.status).toBe('waiting');
    expect(await onHand(agent, w.chairId)).toMatchObject({ onHand: 5, reserved: 0 });
  });

  it('re-reserves when the lines of a ready delivery change', async () => {
    const w = await world();
    const { agent } = w;
    const r = await op(agent, { type: 'receipt', destLocationId: w.stockId, lines: [{ productId: w.steelId, quantity: 50 }] });
    await act(agent, r.id, 'validate');
    const d = await op(agent, { type: 'delivery', sourceLocationId: w.stockId, lines: [{ productId: w.steelId, quantity: 10 }] });
    await act(agent, d.id, 'confirm');
    expect((await onHand(agent, w.steelId)).reserved).toBe(10);

    const bigger = await agent.patch(`/api/operations/${d.id}`).send({ lines: [{ productId: w.steelId, quantity: 70 }] });
    expect(bigger.body.status).toBe('waiting');
    expect((await onHand(agent, w.steelId)).reserved).toBe(0);

    const smaller = await agent.patch(`/api/operations/${d.id}`).send({ lines: [{ productId: w.steelId, quantity: 30.5 }] });
    expect(smaller.body.status).toBe('ready');
    expect((await onHand(agent, w.steelId)).reserved).toBe(30.5);
  });

  it('protects finished documents', async () => {
    const w = await world();
    const { agent } = w;
    const r = await op(agent, { type: 'receipt', destLocationId: w.stockId, lines: [{ productId: w.steelId, quantity: 5 }] });
    await act(agent, r.id, 'validate');
    expect((await agent.patch(`/api/operations/${r.id}`).send({ notes: 'late edit' })).status).toBe(409);
    expect((await act(agent, r.id, 'cancel')).status).toBe(409);
    expect((await agent.delete(`/api/operations/${r.id}`)).status).toBe(409);
    expect((await act(agent, r.id, 'validate')).status).toBe(409);
  });

  it('refuses zero or negative quantities on moves', async () => {
    const w = await world();
    const res = await w.agent.post('/api/operations').send({
      type: 'receipt',
      destLocationId: w.stockId,
      lines: [{ productId: w.steelId, quantity: 0 }],
    });
    expect(res.status).toBe(400);
    const neg = await w.agent.post('/api/operations').send({
      type: 'receipt',
      destLocationId: w.stockId,
      lines: [{ productId: w.steelId, quantity: -4 }],
    });
    expect(neg.status).toBe(400);
  });
});

describe('references, warehouses and the dashboard', () => {
  it('numbers references per warehouse and per type', async () => {
    const w = await world();
    const { agent } = w;
    const blr = await agent.post('/api/warehouses').send({ name: 'Bengaluru Hub', shortCode: 'blr' });
    const blrStock = (await agent.get('/api/locations').query({ warehouseId: blr.body.id })).body.items[0];
    expect(blrStock.fullName).toBe('BLR/Stock');

    const a = await op(agent, { type: 'receipt', destLocationId: w.stockId, lines: [{ productId: w.steelId, quantity: 1 }] });
    const b = await op(agent, { type: 'receipt', destLocationId: w.stockId, lines: [{ productId: w.steelId, quantity: 1 }] });
    const c = await op(agent, { type: 'receipt', destLocationId: blrStock.id, lines: [{ productId: w.steelId, quantity: 1 }] });
    const d = await op(agent, { type: 'delivery', sourceLocationId: blrStock.id, lines: [{ productId: w.steelId, quantity: 1 }] });
    expect([a.reference, b.reference, c.reference, d.reference]).toEqual(['WH/IN/0001', 'WH/IN/0002', 'BLR/IN/0001', 'BLR/OUT/0001']);
  });

  it('reports KPIs, late documents and low stock', async () => {
    const w = await world();
    const { agent } = w;
    const r = await op(agent, { type: 'receipt', destLocationId: w.stockId, lines: [{ productId: w.steelId, quantity: 30 }] });
    await act(agent, r.id, 'validate');
    await op(agent, {
      type: 'receipt',
      destLocationId: w.stockId,
      scheduledDate: '2020-01-01',
      lines: [{ productId: w.chairId, quantity: 3 }],
    });
    const d = await op(agent, { type: 'delivery', sourceLocationId: w.stockId, lines: [{ productId: w.chairId, quantity: 2 }] });
    await act(agent, d.id, 'confirm');

    const dash = await agent.get('/api/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.body.kpis).toMatchObject({
      productsInStock: 1,
      lowStock: 1, // steel: 30 on hand, min 50
      outOfStock: 1, // chair
      pendingReceipts: 1,
      pendingDeliveries: 1,
      waitingDeliveries: 1,
    });
    expect(dash.body.cards.receipt.late).toBe(1);
    expect(dash.body.lowStock.map((p: { sku: string }) => p.sku)).toEqual(['CHR004', 'STL010']);
    expect(dash.body.movement).toHaveLength(14);
    expect(dash.body.movement.at(-1).inValue).toBe(30 * 72);
  });

  it('books initial stock on product creation as an adjustment', async () => {
    const w = await world();
    const res = await w.agent
      .post('/api/products')
      .send({ name: 'Desk', sku: 'DESK001', unitCost: 3000, initialStock: { locationId: w.stockId, quantity: 25 } });
    expect(res.status).toBe(201);
    expect((await onHand(w.agent, res.body.id)).onHand).toBe(25);
    const moves = await w.agent.get('/api/moves').query({ productId: res.body.id });
    expect(moves.body.items[0]).toMatchObject({ kind: 'adjustment', direction: 'in', quantity: 25 });
  });

  it('archives products with history instead of deleting them', async () => {
    const w = await world();
    const r = await op(w.agent, { type: 'receipt', destLocationId: w.stockId, lines: [{ productId: w.steelId, quantity: 1 }] });
    await act(w.agent, r.id, 'cancel');
    const del = await w.agent.delete(`/api/products/${w.steelId}`);
    expect(del.body).toEqual({ archived: true });
    const fresh = await w.agent.delete(`/api/products/${w.chairId}`);
    expect(fresh.status).toBe(204);
  });

  it('lets staff run operations but not settings', async () => {
    const w = await world();
    const staff = await signup('picker01');
    const r = await op(staff, { type: 'receipt', destLocationId: w.stockId, lines: [{ productId: w.steelId, quantity: 4 }] });
    expect((await act(staff, r.id, 'validate')).body.status).toBe('done');
    expect((await staff.delete(`/api/locations/${w.productionId}`)).status).toBe(403);
  });
});
