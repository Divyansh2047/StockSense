import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// NUMERIC and BIGINT arrive as strings by default. Quantities use NUMERIC(14,3) and
// ids stay far below 2^53, so plain JS numbers are safe and much nicer to work with.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number.parseFloat(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));
// Keep DATE as 'YYYY-MM-DD' so a server timezone can never shift it by a day.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

const poolOptions = (): pg.PoolConfig => ({
  connectionString: config.databaseUrl,
  idleTimeoutMillis: 30_000,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
});

/**
 * Owner connection for migrations and health checks only. It never touches
 * company data; everything else goes through `pool` below.
 */
export const adminPool = new pg.Pool({ ...poolOptions(), max: 2 });
adminPool.on('error', (err) => logger.error({ err }, 'Unexpected PostgreSQL client error'));

const rawPool = new pg.Pool({ ...poolOptions(), max: config.isTest ? 4 : 12 });
rawPool.on('error', (err) => logger.error({ err }, 'Unexpected PostgreSQL client error'));

/* ------------------------------------------------------------------ tenant scope */

/**
 * Which company's rows a piece of work may see. Requests get the signed-in user's
 * company; sign-up, sign-in and other account flows that must look across companies
 * run as `system`. With no scope at all the database shows nothing (fail closed).
 */
export type Scope = { companyId: number; system?: false } | { system: true; companyId?: number | null };

const scopeStore = new AsyncLocalStorage<Scope>();

export const currentScope = (): Scope | undefined => scopeStore.getStore();
export const currentCompanyId = (): number | null => scopeStore.getStore()?.companyId ?? null;

export function withScope<T>(scope: Scope, fn: () => T): T {
  return scopeStore.run(scope, fn);
}
export const asSystem = <T>(fn: () => T): T => withScope({ system: true }, fn);
export const asCompany = <T>(companyId: number, fn: () => T): T => withScope({ companyId }, fn);

const SET_SCOPE = `SELECT set_config('app.company_id', $1, false), set_config('app.bypass', $2, false)`;
const scopeParams = (s: Scope | undefined) => [s?.companyId ? String(s.companyId) : '', s?.system ? 'on' : 'off'];

/** Re-point an open client (for example inside a sign-up transaction) at another scope. */
export async function setScope(client: pg.PoolClient, scope: Scope): Promise<void> {
  await client.query(SET_SCOPE, scopeParams(scope));
}

// Superusers skip row-level security, so when the database user is one we drop to a
// plain role (created by the first migration) on every connection.
let dropToRole: Promise<boolean> | null = null;
const prepared = new WeakSet<pg.PoolClient>();

async function checkout(): Promise<pg.PoolClient> {
  const client = await rawPool.connect();
  try {
    if (!prepared.has(client)) {
      dropToRole ??= client
        .query(`SELECT rolsuper OR rolbypassrls AS privileged FROM pg_roles WHERE rolname = current_user`)
        .then((r) => Boolean(r.rows[0]?.privileged));
      if (await dropToRole) await client.query('SET ROLE stocksense_tenant');
      prepared.add(client);
    }
    await client.query(SET_SCOPE, scopeParams(scopeStore.getStore()));
    return client;
  } catch (err) {
    client.release(err as Error);
    throw err;
  }
}

/**
 * Drop-in for pg.Pool: every query runs on a connection whose app.company_id matches
 * the current scope, so row-level security does the tenant filtering.
 */
export const pool = {
  async query(text: string, params?: unknown[]): Promise<pg.QueryResult> {
    const client = await checkout();
    try {
      return await client.query(text, params);
    } finally {
      client.release();
    }
  },
  connect: checkout,
  end: async () => {
    await Promise.all([rawPool.end(), adminPool.end()]);
  },
};

export type Db = typeof pool | pg.PoolClient;
export type Client = pg.PoolClient;

export async function many<T = Record<string, unknown>>(db: Db, text: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query(text, params);
  return res.rows as T[];
}

export async function one<T = Record<string, unknown>>(db: Db, text: string, params: unknown[] = []): Promise<T | undefined> {
  const res = await db.query(text, params);
  return res.rows[0] as T | undefined;
}

/** Run fn inside a transaction on a dedicated client. Rolls back on any throw. */
export async function tx<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await checkout();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Startup self-test: with no company in scope the app must see no rows at all. If it
 * can (for example the database user bypasses row-level security) refuse to run.
 */
export async function assertTenantIsolation(): Promise<void> {
  const r = await withScope({ companyId: -1 }, () => pool.query('SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM companies) AS n'));
  const visible = Number(r.rows[0].n);
  const total = await asSystem(() => pool.query('SELECT count(*) AS n FROM companies'));
  if (visible > 0 && Number(total.rows[0].n) > 0) {
    throw new Error('Row-level security is not in effect for the database user; refusing to serve tenant data.');
  }
}
