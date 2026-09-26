import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config, setJwtSecret } from './config.js';
import { loadStoredSecret } from './db/secrets.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { adminPool, assertTenantIsolation, pool } from './db/pool.js';
import { purgeExpiredSandboxes } from './modules/company/service.js';
import { logger } from './lib/logger.js';

async function main() {
  // Schema changes are forward-only SQL files; applying them at boot keeps deploys one step.
  const applied = await migrate(adminPool, (m) => logger.info(m));
  if (applied.length) logger.info({ applied }, 'database migrated');
  if (config.jwtSecretFromDb) {
    setJwtSecret(await loadStoredSecret(adminPool, 'session-signing-key'));
    logger.info('using the session signing key stored in the database');
  }
  // Demo data for a first run (skipped automatically once any user exists).
  if (config.seedDemo) logger.info(await seed());
  await assertTenantIsolation();
  // demo sandboxes live for a day
  setInterval(() => {
    purgeExpiredSandboxes()
      .then((n) => n && logger.info(`removed ${n} expired demo sandbox(es)`))
      .catch((err) => logger.error({ err }, 'sandbox cleanup failed'));
  }, 60 * 60 * 1000).unref();

  const server = createServer(createApp());
  // SSE connections are long-lived; keep Node's timeouts from cutting them.
  server.requestTimeout = 0;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 61_000;

  server.listen(config.port, () => {
    logger.info(`StockSense API listening on http://localhost:${config.port} (${config.env})`);
  });

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    // SSE clients keep sockets open, so do not wait forever
    setTimeout(() => process.exit(0), 5000).unref();
    server.closeAllConnections?.();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
