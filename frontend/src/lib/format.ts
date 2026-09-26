import type { OpStatus, OpType } from './types';

const qtyFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });
const moneyFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const intFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export const qty = (n: number | null | undefined) => qtyFmt.format(Number(n ?? 0));
export const money = (n: number | null | undefined) => moneyFmt.format(Number(n ?? 0));
/** Indian short form: 950, 12K, 1.2L (lakh), 3.4Cr (crore). */
export function moneyShort(n: number | null | undefined): string {
  const v = Math.abs(Number(n ?? 0));
  const trim = (x: number) => (Math.round(x * 10) / 10).toString();
  const s = v >= 1e7 ? `${trim(v / 1e7)}Cr` : v >= 1e5 ? `${trim(v / 1e5)}L` : v >= 1e3 ? `${trim(v / 1e3)}K` : trim(v);
  return `${Number(n) < 0 ? '−' : ''}₹${s}`;
}
export const int = (n: number | null | undefined) => intFmt.format(Number(n ?? 0));

const uomShort: Record<string, string> = { Units: 'u', units: 'u', Unit: 'u' };
export const uom = (u: string) => uomShort[u] ?? u;
export const qtyUom = (n: number, u: string) => `${qty(n)} ${uom(u)}`;

/** 'YYYY-MM-DD' -> '26 Sep 2026' without timezone drift */
export function day(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
export function dayShort(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
export function relative(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  const days = Math.round(diff / 86400);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
export function todayIso(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const TYPE_LABEL: Record<OpType, string> = {
  receipt: 'Receipt',
  delivery: 'Delivery',
  internal: 'Transfer',
  adjustment: 'Adjustment',
};
export const TYPE_PLURAL: Record<OpType, string> = {
  receipt: 'Receipts',
  delivery: 'Deliveries',
  internal: 'Transfers',
  adjustment: 'Adjustments',
};
export const TYPE_PATH: Record<OpType, string> = {
  receipt: '/receipts',
  delivery: '/deliveries',
  internal: '/transfers',
  adjustment: '/adjustments',
};
export const STATUS_LABEL: Record<OpStatus, string> = {
  draft: 'Draft',
  waiting: 'Waiting',
  ready: 'Ready',
  done: 'Done',
  canceled: 'Canceled',
};
/** The status path each document type walks, as drawn in the mockup. */
export const STATUS_FLOW: Record<OpType, OpStatus[]> = {
  receipt: ['draft', 'ready', 'done'],
  delivery: ['draft', 'waiting', 'ready', 'done'],
  internal: ['draft', 'waiting', 'ready', 'done'],
  adjustment: ['draft', 'done'],
};
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join('') || '?';
