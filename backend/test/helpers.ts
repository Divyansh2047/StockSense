import request from 'supertest';
import { expect } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

export const app = createApp();
export const PASSWORD = 'Str0ng!pass';

export async function resetDb() {
  await pool.query(`TRUNCATE users, password_resets, warehouses, locations, categories, products, partners,
                    stock_quants, operations, operation_lines, sequences, stock_moves RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO locations (name, short_code, type) VALUES
    ('Vendors', 'Vendors', 'vendor'), ('Customers', 'Customers', 'customer'), ('Inventory adjustment', 'Adjustment', 'inventory')`);
}

export type Agent = ReturnType<typeof request.agent>;

export async function signup(loginId = 'manager1', email = `${loginId}@example.com`): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/signup').send({ loginId, email, password: PASSWORD, confirmPassword: PASSWORD });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return agent;
}

/** A manager with warehouse WH (locations Stock + Production) and a couple of products. */
export async function world() {
  const agent = await signup('manager1');
  const wh = await agent.post('/api/warehouses').send({ name: 'Main Warehouse', shortCode: 'WH', address: 'Ahmedabad' });
  expect(wh.status).toBe(201);
  const prod = await agent.post('/api/locations').send({ name: 'Production rack', shortCode: 'Production', warehouseId: wh.body.id });
  expect(prod.status).toBe(201);
  const locs = await agent.get('/api/locations');
  const stock = locs.body.items.find((l: { shortCode: string }) => l.shortCode === 'Stock');
  const steel = await agent.post('/api/products').send({ name: 'Steel rod', sku: 'stl010', uom: 'kg', unitCost: 72, reorderMin: 50, reorderMax: 400 });
  const chair = await agent.post('/api/products').send({ name: 'Office chair', sku: 'CHR004', unitCost: 4200, reorderMin: 5 });
  expect(steel.status).toBe(201);
  expect(chair.status).toBe(201);
  const vendor = await agent.post('/api/partners').send({ name: 'Kalinga Steel Supply', kind: 'vendor' });
  const customer = await agent.post('/api/partners').send({ name: 'Azure Interior', kind: 'customer' });
  return {
    agent,
    warehouseId: wh.body.id as number,
    stockId: stock.id as number,
    productionId: prod.body.id as number,
    steelId: steel.body.id as number,
    chairId: chair.body.id as number,
    vendorId: vendor.body.id as number,
    customerId: customer.body.id as number,
  };
}

export async function onHand(agent: Agent, productId: number, locationId?: number): Promise<{ onHand: number; free: number; reserved: number }> {
  const res = await agent.get('/api/stock').query(locationId ? { locationId } : {});
  const row = res.body.items.find((r: { id: number }) => r.id === productId);
  return { onHand: row.onHand, free: row.free, reserved: row.reserved };
}
