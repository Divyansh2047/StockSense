export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields: Record<string, string> = {},
    /** the full error object, for errors that carry extra data */
    public readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; query?: Query; signal?: AbortSignal } = {},
): Promise<T> {
  const url = new URL(`/api${path}`, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; fields?: Record<string, string> } }).error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? `Request failed (${res.status})`, e.fields ?? {}, e as Record<string, unknown>);
  }
  return data as T;
}

export const get = <T>(path: string, query?: Query, signal?: AbortSignal) => api<T>(path, { query, signal });
export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });
export const del = <T = void>(path: string) => api<T>(path, { method: 'DELETE' });

export const errorMessage = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : 'Something went wrong.');
export const fieldErrors = (err: unknown): Record<string, string> => (err instanceof ApiError ? err.fields : {});
