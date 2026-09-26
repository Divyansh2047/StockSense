import { ArrowRight, FileText, MagnifyingGlass, Package, Plus } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { get } from '../lib/api';
import { qtyUom, TYPE_LABEL, TYPE_PATH } from '../lib/format';
import { useDebounced } from '../lib/hooks';
import type { OperationSummary, Product } from '../lib/types';
import { StatusPill } from '../components/ui';

interface Item {
  id: string;
  group: string;
  label: ReactNode;
  hint?: ReactNode;
  icon: ReactNode;
  to: string;
  keywords: string;
}

const PAGES: Omit<Item, 'icon'>[] = [
  { id: 'p-dash', group: 'Pages', label: 'Dashboard', to: '/', keywords: 'home kpi overview' },
  { id: 'p-rec', group: 'Pages', label: 'Receipts', to: '/receipts', keywords: 'incoming in vendor' },
  { id: 'p-del', group: 'Pages', label: 'Deliveries', to: '/deliveries', keywords: 'outgoing out customer ship' },
  { id: 'p-int', group: 'Pages', label: 'Internal transfers', to: '/transfers', keywords: 'move rack' },
  { id: 'p-adj', group: 'Pages', label: 'Adjustments', to: '/adjustments', keywords: 'count physical damage' },
  { id: 'p-stock', group: 'Pages', label: 'Stock', to: '/stock', keywords: 'on hand free inventory' },
  { id: 'p-prod', group: 'Pages', label: 'Products', to: '/products', keywords: 'sku catalog' },
  { id: 'p-moves', group: 'Pages', label: 'Move history', to: '/moves', keywords: 'ledger history' },
  { id: 'p-wh', group: 'Pages', label: 'Warehouses', to: '/settings/warehouses', keywords: 'settings' },
  { id: 'p-loc', group: 'Pages', label: 'Locations', to: '/settings/locations', keywords: 'settings rack room' },
  { id: 'p-new-rec', group: 'Create', label: 'New receipt', to: '/receipts/new', keywords: 'create add receive' },
  { id: 'p-new-del', group: 'Create', label: 'New delivery', to: '/deliveries/new', keywords: 'create add ship' },
  { id: 'p-new-int', group: 'Create', label: 'New transfer', to: '/transfers/new', keywords: 'create move' },
  { id: 'p-new-adj', group: 'Create', label: 'New stock count', to: '/adjustments/new', keywords: 'create adjust count' },
  { id: 'p-new-prod', group: 'Create', label: 'New product', to: '/products/new', keywords: 'create add sku' },
];

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const term = useDebounced(text.trim(), 180);

  const products = useQuery({
    queryKey: ['palette-products', term],
    queryFn: () => get<{ items: Product[] }>('/products', { search: term }).then((r) => r.items.slice(0, 6)),
    enabled: open && term.length > 0,
  });
  const ops = useQuery({
    queryKey: ['palette-ops', term],
    queryFn: () => get<{ items: OperationSummary[] }>('/operations', { search: term, limit: 6 }).then((r) => r.items),
    enabled: open && term.length > 0,
  });

  const items = useMemo<Item[]>(() => {
    const t = text.trim().toLowerCase();
    const pages = PAGES.filter((p) => !t || `${p.label} ${p.keywords}`.toLowerCase().includes(t)).map((p) => ({
      ...p,
      icon: p.group === 'Create' ? <Plus size={17} /> : <ArrowRight size={17} />,
    }));
    const prod: Item[] = (term ? products.data ?? [] : []).map((p) => ({
      id: `prod-${p.id}`,
      group: 'Products',
      label: (
        <>
          <span className="mono">{p.sku}</span> {p.name}
        </>
      ),
      hint: `${qtyUom(p.onHand, p.uom)} on hand`,
      icon: <Package size={17} />,
      to: `/products/${p.id}`,
      keywords: '',
    }));
    const op: Item[] = (term ? ops.data ?? [] : []).map((o) => ({
      id: `op-${o.id}`,
      group: 'Documents',
      label: (
        <>
          <span className="mono">{o.reference}</span> {o.partnerName ?? TYPE_LABEL[o.type]}
        </>
      ),
      hint: <StatusPill status={o.status} late={o.late} />,
      icon: <FileText size={17} />,
      to: `${TYPE_PATH[o.type]}/${o.id}`,
      keywords: '',
    }));
    return [...op, ...prod, ...pages].slice(0, 16);
  }, [text, term, products.data, ops.data]);

  useEffect(() => {
    if (open) {
      setText('');
      setActive(0);
    }
  }, [open]);
  useEffect(() => setActive(0), [items.length]);

  const go = (it: Item | undefined) => {
    if (!it) return;
    onClose();
    navigate(it.to);
  };

  let lastGroup = '';
  return createPortal(
    <AnimatePresence>
      {open && (
        <m.div
          className="overlay palette-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onPointerDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <m.div
            className="palette"
            role="dialog"
            aria-modal="true"
            aria-label="Search"
            initial={reduce ? false : { opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ type: 'spring', stiffness: 460, damping: 36 }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, items.length - 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                go(items[active]);
              }
            }}
          >
            <div className="palette__input">
              <MagnifyingGlass size={18} aria-hidden="true" />
              <input
                ref={input}
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Search a SKU, product, reference or page"
                aria-label="Search"
                role="combobox"
                aria-expanded="true"
                aria-controls="palette-list"
                aria-activedescendant={items[active] ? `pal-${items[active]!.id}` : undefined}
              />
              <kbd>Esc</kbd>
            </div>
            <ul className="palette__list" id="palette-list" role="listbox">
              {items.map((it, i) => {
                const header = it.group !== lastGroup ? it.group : null;
                lastGroup = it.group;
                return (
                  <li key={it.id} role="presentation">
                    {header && <div className="palette__group">{header}</div>}
                    <div
                      id={`pal-${it.id}`}
                      role="option"
                      aria-selected={i === active}
                      className="palette__item"
                      onPointerEnter={() => setActive(i)}
                      onClick={() => go(it)}
                    >
                      {it.icon}
                      <span className="palette__label">{it.label}</span>
                      {it.hint && <span className="palette__hint">{it.hint}</span>}
                    </div>
                  </li>
                );
              })}
              {!items.length && <li className="combo__empty">No matches for “{text}”.</li>}
            </ul>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
