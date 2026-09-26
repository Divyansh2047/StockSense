import { randomBytes } from 'node:crypto';
import type pg from 'pg';

/** Fetch a named secret, creating a random one the first time. Safe across instances. */
export async function loadStoredSecret(pool: pg.Pool, name: string): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.secrets', 'on', true)`);
    await client.query('INSERT INTO app_secrets (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [
      name,
      randomBytes(48).toString('base64url'),
    ]);
    const row = await client.query('SELECT value FROM app_secrets WHERE name = $1', [name]);
    await client.query('COMMIT');
    return row.rows[0].value as string;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
