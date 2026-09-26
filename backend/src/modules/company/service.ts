import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { asSystem, one, setScope, tx, type Client } from '../../db/pool.js';
import { seedCompanyData } from '../../db/seed.js';

/**
 * A company is one isolated workspace. Creating it also creates the three virtual
 * locations every stock move needs, then leaves the client scoped to the new company
 * so the caller can keep inserting its rows.
 */
export async function createCompany(c: Client, name: string, opts: { sandbox?: boolean } = {}): Promise<number> {
  await setScope(c, { system: true });
  const row = await one<{ id: number }>(c, 'INSERT INTO companies (name, is_sandbox) VALUES ($1, $2) RETURNING id', [
    name.trim().slice(0, 80) || 'My company',
    opts.sandbox ?? false,
  ]);
  const companyId = row!.id;
  await setScope(c, { companyId });
  await c.query(
    `INSERT INTO locations (name, short_code, type) VALUES
       ('Vendors', 'Vendors', 'vendor'), ('Customers', 'Customers', 'customer'), ('Inventory adjustment', 'Adjustment', 'inventory')`,
  );
  return companyId;
}

export const SANDBOX_TTL_HOURS = 24;

/**
 * One-click demo: a private copy of the sample company with its own manager, so every
 * visitor can receive, ship and adjust stock without stepping on anyone else.
 */
export async function createSandbox(): Promise<{ userId: number; companyId: number }> {
  await purgeExpiredSandboxes();
  const tag = randomBytes(3).toString('hex');
  // Nobody signs in to these with a password; the session is issued directly.
  const hash = await bcrypt.hash(randomBytes(24).toString('base64url'), 4);
  return asSystem(() =>
    tx(async (c) => {
      const companyId = await createCompany(c, 'Sample Furniture Co.', { sandbox: true });
      const users = await c.query(
        `INSERT INTO users (login_id, email, name, password_hash, role, email_verified_at) VALUES
           ($1, $2, 'Aarav Mehta', $5, 'manager', now()),
           ($3, $4, 'Riya Desai', $5, 'staff', now())
         RETURNING id`,
        [`demo-${tag}`, `demo-${tag}@sandbox.invalid`, `pick-${tag}`, `pick-${tag}@sandbox.invalid`, hash],
      );
      const [managerId, staffId] = users.rows.map((r) => r.id as number);
      await seedCompanyData(c, managerId!, staffId!);
      return { userId: managerId!, companyId };
    }),
  );
}

export async function purgeExpiredSandboxes(): Promise<number> {
  const res = await asSystem(() =>
    tx((c) => c.query(`DELETE FROM companies WHERE is_sandbox AND created_at < now() - make_interval(hours => $1)`, [SANDBOX_TTL_HOURS])),
  );
  return res.rowCount ?? 0;
}
