import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { queryClient } from './queries';

/**
 * Keeps every open tab in sync with the server: the API broadcasts which topics a
 * write touched and we refetch just those queries.
 */
const TOPIC_KEYS: Record<string, string[]> = {
  operations: ['dashboard', 'operations', 'operation', 'moves'],
  stock: ['stock', 'products', 'product', 'dashboard', 'operation'],
  moves: ['moves', 'dashboard'],
  products: ['products', 'product', 'stock', 'categories'],
  warehouses: ['warehouses', 'locations'],
  partners: ['partners'],
  users: ['users', 'me'],
};

export type LiveState = 'connecting' | 'live' | 'offline';
interface LiveCtx {
  state: LiveState;
  lastEventAt: number | null;
  pulse: number;
}
const Ctx = createContext<LiveCtx>({ state: 'connecting', lastEventAt: null, pulse: 0 });

export function LiveProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [state, setState] = useState<LiveState>('connecting');
  const [lastEventAt, setLast] = useState<number | null>(null);
  const [pulse, setPulse] = useState(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let closed = false;
    let retry = 1000;

    const connect = () => {
      es = new EventSource('/api/events', { withCredentials: true });
      es.addEventListener('hello', () => {
        setState('live');
        retry = 1000;
      });
      es.addEventListener('change', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as { topics: string[] };
          const keys = new Set(data.topics.flatMap((t) => TOPIC_KEYS[t] ?? []));
          // coalesce bursts (one validation touches several topics)
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            keys.forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
          }, 120);
          setLast(Date.now());
          setPulse((p) => p + 1);
        } catch {
          /* ignore malformed events */
        }
      });
      es.onerror = () => {
        setState('offline');
        es?.close();
        if (!closed) window.setTimeout(connect, Math.min((retry *= 2), 30_000));
      };
    };
    connect();
    return () => {
      closed = true;
      es?.close();
      window.clearTimeout(timer.current);
    };
  }, [enabled]);

  return <Ctx.Provider value={{ state, lastEventAt, pulse }}>{children}</Ctx.Provider>;
}

export const useLive = () => useContext(Ctx);
