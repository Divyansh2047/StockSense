import type { Request, Response } from 'express';

/**
 * Server-sent events hub. Every mutation broadcasts the topics it touched and each
 * open browser tab refetches what it is showing, so the dashboard stays live
 * without polling.
 */
export type Topic = 'operations' | 'stock' | 'moves' | 'products' | 'warehouses' | 'partners' | 'users';

const clients = new Set<Response>();

export function subscribe(req: Request, res: Response): void {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 4000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
  clients.add(res);
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

export function broadcast(topics: Topic[], detail: Record<string, unknown> = {}): void {
  if (!clients.size) return;
  const payload = `event: change\ndata: ${JSON.stringify({ topics, ...detail, at: Date.now() })}\n\n`;
  for (const res of clients) res.write(payload);
}

export const connectedClients = () => clients.size;
