import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express, { Router, type RequestHandler } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { requireAuth } from './lib/auth.js';
import { errorHandler, forbidden, notFoundHandler } from './lib/errors.js';
import { connectedClients, subscribe } from './lib/events.js';
import { logger } from './lib/logger.js';
import { authRouter } from './modules/auth/routes.js';
import { catalogRouter } from './modules/catalog/routes.js';
import { dashboardRouter } from './modules/dashboard/routes.js';
import { movesRouter } from './modules/moves/routes.js';
import { operationsRouter } from './modules/operations/routes.js';
import { partnersRouter } from './modules/partners/routes.js';
import { stockRouter } from './modules/stock/routes.js';
import { usersRouter } from './modules/users/routes.js';
import { warehousesRouter } from './modules/warehouses/routes.js';

// Works from src/ (tsx) and dist/ (compiled) because both sit one level under backend/.
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LANDING_FILE = path.join(REPO_ROOT, 'index.html');
const SPA_DIR = path.join(REPO_ROOT, 'frontend', 'dist');

/**
 * Cross-site request forgery guard. The session cookie is SameSite=Lax already; on
 * top of that, state-changing requests must be JSON and, when the browser sends an
 * Origin header, it has to be this site or an explicitly allowed origin.
 */
const originGuard: RequestHandler = (req, _res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.get('origin');
  if (origin) {
    const host = req.get('host');
    let ok = config.corsOrigins.includes(origin);
    try {
      ok ||= new URL(origin).host === host;
    } catch {
      ok = false;
    }
    if (!ok) return next(forbidden('Cross-site request blocked.'));
  }
  const hasBody = Number(req.get('content-length') ?? 0) > 0 || req.get('transfer-encoding');
  if (hasBody && !req.is('application/json')) return next(forbidden('Requests must be sent as JSON.'));
  next();
};

/** Minimal CORS for explicitly listed origins only (not needed when the SPA is same-origin). */
const cors: RequestHandler = (req, res, next) => {
  const origin = req.get('origin');
  if (origin && config.corsOrigins.includes(origin)) {
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    });
    if (req.method === 'OPTIONS') return void res.status(204).end();
  }
  next();
};

function apiRouter(): Router {
  const api = Router();
  api.use(express.json({ limit: '256kb' }));
  api.use(originGuard);

  api.get('/health', async (_req, res) => {
    const started = Date.now();
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'up', dbLatencyMs: Date.now() - started, liveClients: connectedClients() });
  });

  api.use('/auth', authRouter);

  // everything below needs a signed-in user
  api.use(requireAuth);
  api.get('/events', subscribe);
  api.use('/dashboard', dashboardRouter);
  api.use('/operations', operationsRouter);
  api.use('/stock', stockRouter);
  api.use('/moves', movesRouter);
  api.use('/partners', partnersRouter);
  api.use('/users', usersRouter);
  api.use('/', catalogRouter);
  api.use('/', warehousesRouter);

  api.use(notFoundHandler);
  return api;
}

/** Hash every inline <script> in the landing page so CSP can allow exactly those. */
function landingScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    hashes.push(`'sha256-${createHash('sha256').update(m[1] ?? '', 'utf8').digest('base64')}'`);
  }
  return hashes;
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(
    pinoHttp({
      logger,
      // log API traffic only; static assets would drown everything else
      autoLogging: { ignore: (req) => !req.url?.startsWith('/api/') || req.url === '/api/health' || req.url === '/api/events' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );

  // Default CSP for the SPA and API: nothing inline, everything self-hosted.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: config.secureTransport ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: config.secureTransport ? { maxAge: 31536000, includeSubDomains: true } : false,
    }),
  );
  app.use(cookieParser());
  app.use('/api', cors, apiRouter());

  // Landing page at "/" with a CSP that allows its CDN assets and its own inline scripts.
  if (existsSync(LANDING_FILE)) {
    const html = readFileSync(LANDING_FILE, 'utf8');
    const landingCsp = [
      "default-src 'self'",
      `script-src 'self' https://cdn.jsdelivr.net ${landingScriptHashes(html).join(' ')}`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
      "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net",
      "img-src 'self' data: blob:",
      "connect-src 'self' https://cdn.jsdelivr.net",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ].join('; ');
    app.get(['/', '/index.html'], (_req, res) => {
      res.set('Content-Security-Policy', landingCsp).type('html').send(html);
    });
  }

  // The React app lives under /app with client-side routing.
  if (existsSync(SPA_DIR)) {
    app.use('/app', express.static(SPA_DIR, { index: false, maxAge: config.isProd ? '1y' : 0, immutable: config.isProd }));
    app.get(/^\/app(\/.*)?$/, (_req, res) => {
      res.set('Cache-Control', 'no-cache').sendFile(path.join(SPA_DIR, 'index.html'));
    });
  } else if (!config.isTest) {
    logger.info('frontend/dist not found; run the Vite dev server (npm run dev) or build the frontend.');
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
