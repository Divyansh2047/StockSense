import pg from 'pg';
import { migrate, wipe } from '../src/db/migrate.js';

/** Fresh schema once per test run. Individual files truncate data between tests. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://stocksense:stocksense@127.0.0.1:5432/stocksense_test';
  if (!/test/i.test(url)) throw new Error(`Refusing to wipe a database whose name does not mention "test": ${url}`);
  const pool = new pg.Pool({ connectionString: url });
  await wipe(pool);
  await migrate(pool);
  await pool.end();
}
