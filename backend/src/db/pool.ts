import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// NUMERIC and BIGINT arrive as strings by default. Quantities use NUMERIC(14,3) and
// ids stay far below 2^53, so plain JS numbers are safe and much nicer to work with.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number.parseFloat(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));
// Keep DATE as 'YYYY-MM-DD' so a server timezone can never shift it by a day.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.isTest ? 4 : 12,
  idleTimeoutMillis: 30_000,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => logger.error({ err }, 'Unexpected PostgreSQL client error'));

export type Db = pg.Pool | pg.PoolClient;
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
  const client = await pool.connect();
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
