import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { logger } from './lib/logger.js';

async function main() {
  // Schema changes are forward-only SQL files; applying them at boot keeps deploys one step.
  const applied = await migrate(pool, (m) => logger.info(m));
  if (applied.length) logger.info({ applied }, 'database migrated');

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
