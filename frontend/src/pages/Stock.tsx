import { CaretDown, CaretRight, Check, MagnifyingGlass, PencilSimple, Stack, X } from '@phosphor-icons/react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { Fragment, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Empty, ErrorBox, PageHeader, SkeletonRows, StockPill } from '../components/ui';
import { errorMessage } from '../lib/api';
import { money, qty, qtyUom, uom } from '../lib/format';
import { useDebounced, useDocumentTitle, useQueryState } from '../lib/hooks';
import { invalidateInventory, setStock, useCategories, useLocations, useStock, useWarehouses } from '../lib/queries';
import { useToast } from '../lib/toast';
import type { StockRow } from '../lib/types';

/**
 * The Stock page from the mockup: product, per unit cost, on hand, free to use,
 * and "user must be able to update the stock from here". Every edit is posted as
 * an inventory adjustment, so the ledger explains each change.
 */
export default function Stock() {
  useDocumentTitle('Stock');
  const [search, setSearch] = useQueryState('q');
  const [warehouseId, setWarehouse] = useQueryState('warehouse');
  const [locationId, setLocation] = useQueryState('location');
  const [categoryId, setCategory] = useQueryState('category');
  const [stock, setStockFilter] = useQueryState('stock');
  const term = useDebounced(search);
  const { data, error, isLoading, isFetching, refetch } = useStock({ search: term, warehouseId, locationId, categoryId, stock });
  const { data: warehouses = [] } = useWarehouses();
  const { data: locations = [] } = useLocations(warehouseId ? { warehouseId } : {});
  const { data: categories = [] } = useCategories();
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div>
      <PageHeader
        title="Stock"
        meta={
          data ? (
            <>
              <span>
                <b className="mono">{money(data.totals.value)}</b> on hand at unit cost
              </span>
              <span>{data.items.length} products</span>
            </>
          ) : null
        }
        actions={
          <Link to="/adjustments/new" className="btn btn--ghost">
            <PencilSimple size={17} /> Count several products
          </Link>
        }
      />
      <div className="toolbar">
        <div className="input-icon grow">
          <MagnifyingGlass size={16} aria-hidden="true" />
          <input className="input" type="search" placeholder="Search SKU or product" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search SKU or product" />
        </div>
        <select className="select" aria-label="Warehouse" value={warehouseId} onChange={(e) => (setWarehouse(e.target.value), setLocation(''))}>
          <option value="">All warehouses</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.shortCode} {w.name}
            </option>
          ))}
        </select>
        <select className="select" aria-label="Location" value={locationId} onChange={(e) => setLocation(e.target.value)}>
          <option value="">All locations</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.fullName}
            </option>
          ))}
        </select>
        <select className="select" aria-label="Category" value={categoryId} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="chips" role="group" aria-label="Stock level" style={{ marginBottom: 14 }}>
        {[
          ['', 'All'],
          ['in', 'In stock'],
          ['low', 'Low or out'],
          ['out', 'Out of stock'],
        ].map(([k, label]) => (
          <button key={k} type="button" className="chip" aria-pressed={stock === k} onClick={() => setStockFilter(k!)}>
            {label}
          </button>
        ))}
      </div>

      {error ? (
        <ErrorBox error={error} retry={() => refetch()} />
      ) : (
        <div className="panel" style={{ opacity: isFetching && !isLoading ? 0.7 : 1, transition: 'opacity .2s' }}>
          {isLoading ? (
            <SkeletonRows cols={6} />
          ) : !data?.items.length ? (
            <Empty icon={<Stack size={38} weight="duotone" />} title="No products match">
              Clear the filters, or add products from the Products page.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="table stock-table">
                <thead>
                  <tr>
                    <th className="shrink" aria-label="Expand" />
                    <th>Product</th>
                    <th className="n">Per unit cost</th>
                    <th className="n">On hand</th>
                    <th className="n">Free to use</th>
                    <th className="n">Value</th>
                    <th>Level</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((r) => (
                    <StockRowView key={r.id} r={r} open={open.has(r.id)} toggle={() => toggle(r.id)} locationFilter={locationId ? Number(locationId) : null} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StockRowView({ r, open, toggle, locationFilter }: { r: StockRow; open: boolean; toggle: () => void; locationFilter: number | null }) {
  const reduce = useReducedMotion();
  const { data: allLocations = [] } = useLocations();
  const [adding, setAdding] = useState(false);
  const known = new Set(r.locations.map((l) => l.locationId));
  const addable = allLocations.filter((l) => l.type === 'internal' && !known.has(l.id));
  return (
    <Fragment>
      <tr className="is-link" onClick={toggle} aria-expanded={open}>
        <td className="shrink">
          <button type="button" className="btn btn--quiet btn--icon btn--xs" aria-label={open ? `Hide locations of ${r.name}` : `Show locations of ${r.name}`} onClick={(e) => (e.stopPropagation(), toggle())}>
            {open ? <CaretDown size={14} /> : <CaretRight size={14} />}
          </button>
        </td>
        <td>
          <Link to={`/products/${r.id}`} className="cell-main" onClick={(e) => e.stopPropagation()} style={{ textDecoration: 'none' }}>
            {r.name}
          </Link>
          <span className="cell-sub">
            {r.sku}
            {r.categoryName ? `  ${r.categoryName}` : ''}
          </span>
        </td>
        <td className="n">{money(r.unitCost)}</td>
        <td className="n">
          <b>{qty(r.onHand)}</b> <span className="muted">{uom(r.uom)}</span>
        </td>
        <td className="n">
          {qty(r.free)}
          {r.reserved > 0 && <span className="cell-sub">{qty(r.reserved)} reserved</span>}
        </td>
        <td className="n">{money(r.value)}</td>
        <td>
          <StockPill status={r.stockStatus} />
        </td>
      </tr>
      <AnimatePresence initial={false}>
        {open && (
          <m.tr
            className="stock-sub"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <td />
            <td colSpan={6}>
              <div className="locgrid">
                {r.locations.map((l) => (
                  <LocationQty key={l.locationId} productId={r.id} unit={r.uom} locationId={l.locationId} name={l.fullName} quantity={l.quantity} reserved={l.reserved} />
                ))}
                {!r.locations.length && !adding && <span className="muted" style={{ fontSize: 13 }}>Not stored anywhere yet.</span>}
                {adding ? (
                  <NewLocationQty productId={r.id} unit={r.uom} options={addable} onDone={() => setAdding(false)} preselect={locationFilter} />
                ) : (
                  addable.length > 0 && (
                    <button type="button" className="btn btn--quiet btn--xs" onClick={() => setAdding(true)}>
                      + Set stock at another location
                    </button>
                  )
                )}
              </div>
            </td>
          </m.tr>
        )}
      </AnimatePresence>
    </Fragment>
  );
}

function LocationQty({ productId, locationId, name, quantity, reserved, unit }: { productId: number; locationId: number; name: string; quantity: number; reserved: number; unit: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(quantity));
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(value);
    if (value.trim() === '' || !Number.isFinite(n) || n < 0) return toast.error('Enter a quantity of zero or more');
    if (n === quantity) return setEditing(false);
    setBusy(true);
    try {
      const res = await setStock({ productId, locationId, quantity: n });
      await invalidateInventory();
      const diff = n - res.previous;
      toast.success(`${name} updated to ${qtyUom(n, unit)}`, `${diff > 0 ? '+' : '−'}${qty(Math.abs(diff))} logged as ${res.reference}.`);
      setEditing(false);
    } catch (err) {
      toast.error('Could not update stock', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="locqty">
      <span className="locqty__name mono">{name}</span>
      {editing ? (
        <form className="locqty__form" onSubmit={submit}>
          <input
            className="input mono"
            autoFocus
            inputMode="decimal"
            value={value}
            aria-label={`Counted quantity at ${name}`}
            onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ''))}
            onKeyDown={(e) => e.key === 'Escape' && (setEditing(false), setValue(String(quantity)))}
          />
          <button type="submit" className="btn btn--primary btn--icon btn--xs" aria-label="Save count" disabled={busy}>
            <Check size={14} weight="bold" />
          </button>
          <button type="button" className="btn btn--quiet btn--icon btn--xs" aria-label="Cancel" onClick={() => (setEditing(false), setValue(String(quantity)))}>
            <X size={14} />
          </button>
        </form>
      ) : (
        <button type="button" className="locqty__value" onClick={() => setEditing(true)} title="Update the counted quantity">
          <b>{qtyUom(quantity, unit)}</b>
          {reserved > 0 && <span>{qty(reserved)} reserved</span>}
          <PencilSimple size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function NewLocationQty({
  productId,
  unit,
  options,
  onDone,
  preselect,
}: {
  productId: number;
  unit: string;
  options: { id: number; fullName: string }[];
  onDone: () => void;
  preselect: number | null;
}) {
  const [loc, setLoc] = useState<number>(preselect && options.some((o) => o.id === preselect) ? preselect : options[0]?.id ?? 0);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(value);
    if (!loc || value.trim() === '' || !(n > 0)) return toast.error('Pick a location and a quantity above zero');
    setBusy(true);
    try {
      const res = await setStock({ productId, locationId: loc, quantity: n });
      await invalidateInventory();
      toast.success(`Stock set to ${qtyUom(n, unit)}`, `Logged as ${res.reference}.`);
      onDone();
    } catch (err) {
      toast.error('Could not update stock', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="locqty locqty__form" onSubmit={submit}>
      <select className="select" value={loc} onChange={(e) => setLoc(Number(e.target.value))} aria-label="Location" style={{ height: 32, width: 'auto' }}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.fullName}
          </option>
        ))}
      </select>
      <input className="input mono" autoFocus inputMode="decimal" placeholder="Qty" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ''))} aria-label="Quantity" />
      <button type="submit" className="btn btn--primary btn--icon btn--xs" aria-label="Save" disabled={busy}>
        <Check size={14} weight="bold" />
      </button>
      <button type="button" className="btn btn--quiet btn--icon btn--xs" aria-label="Cancel" onClick={onDone}>
        <X size={14} />
      </button>
    </form>
  );
}
