import { QueryCache, QueryClient, useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { ApiError, del, get, patch, post, put } from './api';
import type {
  Category,
  Dashboard,
  Location,
  Move,
  Operation,
  OperationSummary,
  OpType,
  Partner,
  Product,
  ProductDetail,
  StockRow,
  TeamMember,
  User,
  Warehouse,
} from './types';

export const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (err) => {
      // Session ended somewhere (logout in another tab, password reset): drop to sign-in.
      if (err instanceof ApiError && err.status === 401) queryClient.setQueryData(['me'], null);
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false },
  },
});

export type Filters = Record<string, string | number | undefined>;

/* ------------------------------------------------------------------ auth */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => (await get<{ user: User | null }>('/auth/session')).user,
    staleTime: 60_000,
  });
}

/* ------------------------------------------------------------------ reads */
export const useDashboard = (f: Filters = {}) =>
  useQuery({ queryKey: ['dashboard', f], queryFn: () => get<Dashboard>('/dashboard', f), placeholderData: keepPreviousData });

export const useOperations = (f: Filters) =>
  useQuery({
    queryKey: ['operations', f],
    queryFn: () => get<{ items: OperationSummary[] }>('/operations', f).then((r) => r.items),
    placeholderData: keepPreviousData,
  });

export const useOperation = (id: number | undefined) =>
  useQuery({ queryKey: ['operation', id], queryFn: () => get<Operation>(`/operations/${id}`), enabled: !!id });

export const useStock = (f: Filters, enabled = true) =>
  useQuery({
    queryKey: ['stock', f],
    enabled,
    queryFn: () => get<{ items: StockRow[]; totals: { value: number; onHand: number; free: number } }>('/stock', f),
    placeholderData: keepPreviousData,
  });

export const useProducts = (f: Filters = {}) =>
  useQuery({
    queryKey: ['products', f],
    queryFn: () => get<{ items: Product[] }>('/products', f).then((r) => r.items),
    placeholderData: keepPreviousData,
  });

export const useProduct = (id: number | undefined) =>
  useQuery({ queryKey: ['product', id], queryFn: () => get<ProductDetail>(`/products/${id}`), enabled: !!id });

export const useCategories = () =>
  useQuery({ queryKey: ['categories'], queryFn: () => get<{ items: Category[] }>('/categories').then((r) => r.items) });

export const useWarehouses = () =>
  useQuery({ queryKey: ['warehouses'], queryFn: () => get<{ items: Warehouse[] }>('/warehouses').then((r) => r.items) });

export const useLocations = (f: Filters = {}) =>
  useQuery({ queryKey: ['locations', f], queryFn: () => get<{ items: Location[] }>('/locations', f).then((r) => r.items) });

export const usePartners = (f: Filters = {}) =>
  useQuery({ queryKey: ['partners', f], queryFn: () => get<{ items: Partner[] }>('/partners', f).then((r) => r.items) });

export const useTeam = () => useQuery({ queryKey: ['users'], queryFn: () => get<{ items: TeamMember[] }>('/users').then((r) => r.items) });

export const useMoves = (f: Filters, enabled = true) =>
  useQuery({
    queryKey: ['moves', f],
    enabled,
    queryFn: () => get<{ items: Move[]; total: number }>('/moves', f),
    placeholderData: keepPreviousData,
  });

/* ------------------------------------------------------------------ writes */
const invalidate = (...keys: string[]) => Promise.all(keys.map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
export const invalidateInventory = () => invalidate('dashboard', 'operations', 'operation', 'stock', 'products', 'product', 'moves');

export interface OperationPayload {
  type?: OpType;
  partnerId?: number | null;
  sourceLocationId?: number | null;
  destLocationId?: number | null;
  scheduledDate?: string | null;
  responsibleId?: number | null;
  deliveryAddress?: string;
  notes?: string;
  lines?: { productId: number; quantity: number }[];
}

export function useOperationMutations() {
  const qc = useQueryClient();
  const settle = (op?: Operation) => {
    if (op) qc.setQueryData(['operation', op.id], op);
    return invalidateInventory();
  };
  return {
    create: useMutation({ mutationFn: (body: OperationPayload) => post<Operation>('/operations', body), onSuccess: settle }),
    update: useMutation({
      mutationFn: ({ id, body }: { id: number; body: OperationPayload }) => patch<Operation>(`/operations/${id}`, body),
      onSuccess: settle,
    }),
    action: useMutation({
      mutationFn: ({ id, action }: { id: number; action: 'confirm' | 'validate' | 'cancel' | 'check-availability' }) =>
        post<Operation>(`/operations/${id}/${action}`),
      onSuccess: settle,
    }),
    remove: useMutation({ mutationFn: (id: number) => del(`/operations/${id}`), onSuccess: () => settle() }),
  };
}

export const setStock = (body: { productId: number; locationId: number; quantity: number; note?: string }) =>
  put<{ reference: string; previous: number; quantity: number }>('/stock', body);

export { del, get, patch, post, put };
