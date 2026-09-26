import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** A piece of state mirrored into the URL query so filters survive reloads and can be shared. */
export function useQueryState(key: string, fallback = ''): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(key) ?? fallback;
  const set = (v: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (!v || v === fallback) next.delete(key);
        else next.set(key, v);
        return next;
      },
      { replace: true },
    );
  };
  return [value, set];
}

export function useOnClickOutside(ref: React.RefObject<HTMLElement | null>, handler: () => void, active = true) {
  const saved = useRef(handler);
  saved.current = handler;
  useEffect(() => {
    if (!active) return;
    const on = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) saved.current();
    };
    document.addEventListener('pointerdown', on);
    return () => document.removeEventListener('pointerdown', on);
  }, [ref, active]);
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} | StockSense` : 'StockSense';
  }, [title]);
}
