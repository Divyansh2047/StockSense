import { ArrowDownLeft, ArrowLeft, ArrowUpRight, ArrowsLeftRight, Archive, FloppyDisk, Package } from '@phosphor-icons/react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ConfirmDialog } from '../components/Dialog';
import { Button, Empty, ErrorBox, Field, SkeletonRows, StockPill } from '../components/ui';
import { del, errorMessage, fieldErrors, patch, post } from '../lib/api';
import { dateTime, money, qty, qtyUom, uom } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import { invalidateInventory, queryClient, useCategories, useLocations, useMe, useMoves, useProduct } from '../lib/queries';
import { useToast } from '../lib/toast';
import type { Category } from '../lib/types';

const UOMS = ['Units', 'kg', 'g', 'L', 'm', 'Box', 'Sheets', 'Cans', 'Rolls', 'Pairs'];

interface Form {
  name: string;
  sku: string;
  categoryId: string;
  uom: string;
  unitCost: string;
  reorderMin: string;
  reorderMax: string;
  initialLocationId: string;
  initialQty: string;
}
const empty: Form = { name: '', sku: '', categoryId: '', uom: 'Units', unitCost: '', reorderMin: '', reorderMax: '', initialLocationId: '', initialQty: '' };

export default function ProductPage() {
  const { id } = useParams();
  return <ProductEditor key={id ?? 'new'} />;
}

function ProductEditor() {
  const { id: idParam } = useParams();
  const id = idParam ? Number(idParam) : undefined;
  const isNew = !id;
  const navigate = useNavigate();
  const toast = useToast();
  const { data: me } = useMe();
  const { data: product, error, isLoading, refetch } = useProduct(id);
  const { data: categories = [] } = useCategories();
  const { data: locations = [] } = useLocations();
  const moves = useMoves(id ? { productId: id, limit: 12 } : {}, !!id);
  const [form, setForm] = useState<Form>(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [newCategory, setNewCategory] = useState('');
  useDocumentTitle(product?.name ?? 'New product');

  useEffect(() => {
    if (product) {
      setForm({
        name: product.name,
        sku: product.sku,
        categoryId: product.categoryId ? String(product.categoryId) : '',
        uom: product.uom,
        unitCost: String(product.unitCost),
        reorderMin: String(product.reorderMin),
        reorderMax: String(product.reorderMax),
        initialLocationId: '',
        initialQty: '',
      });
    }
  }, [product]);
  useEffect(() => {
    if (isNew && !form.initialLocationId && locations[0]) setForm((f) => ({ ...f, initialLocationId: String(locations[0]!.id) }));
  }, [isNew, locations, form.initialLocationId]);

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const num = (s: string) => (s.trim() === '' ? 0 : Number(s));

  const dirty = useMemo(() => {
    if (isNew) return true;
    if (!product) return false;
    return (
      form.name !== product.name ||
      form.sku.toUpperCase() !== product.sku ||
      form.categoryId !== (product.categoryId ? String(product.categoryId) : '') ||
      form.uom !== product.uom ||
      num(form.unitCost) !== product.unitCost ||
      num(form.reorderMin) !== product.reorderMin ||
      num(form.reorderMax) !== product.reorderMax
    );
  }, [form, product, isNew]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = 'Enter a product name';
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(form.sku.trim())) errs.sku = 'Letters, numbers, dot, dash or underscore, up to 32';
    for (const k of ['unitCost', 'reorderMin', 'reorderMax', 'initialQty'] as const) {
      if (form[k].trim() !== '' && !(Number(form[k]) >= 0)) errs[k] = 'Zero or more';
    }
    if (num(form.reorderMax) > 0 && num(form.reorderMax) < num(form.reorderMin)) errs.reorderMax = 'Max should be at least the min';
    setErrors(errs);
    if (Object.keys(errs).length) return;

    const body = {
      name: form.name.trim(),
      sku: form.sku.trim(),
      categoryId: form.categoryId ? Number(form.categoryId) : null,
      uom: form.uom.trim() || 'Units',
      unitCost: num(form.unitCost),
      reorderMin: num(form.reorderMin),
      reorderMax: num(form.reorderMax),
    };
    setBusy(true);
    try {
      if (isNew) {
        const initialStock = num(form.initialQty) > 0 && form.initialLocationId ? { locationId: Number(form.initialLocationId), quantity: num(form.initialQty) } : null;
        const res = await post<{ id: number }>('/products', { ...body, initialStock });
        await invalidateInventory();
        toast.success(`${body.name} created`, initialStock ? `Initial stock of ${qtyUom(initialStock.quantity, body.uom)} logged as an adjustment.` : undefined);
        navigate(`/products/${res.id}`, { replace: true });
      } else {
        await patch(`/products/${id}`, body);
        await invalidateInventory();
        toast.success('Product saved');
      }
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error('Could not save the product', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const addCategory = async () => {
    const name = newCategory.trim();
    if (!name) return;
    try {
      const c = await post<Category>('/categories', { name });
      await queryClient.invalidateQueries({ queryKey: ['categories'] });
      setForm((f) => ({ ...f, categoryId: String(c.id) }));
      setNewCategory('');
    } catch (err) {
      toast.error('Could not add the category', errorMessage(err));
    }
  };

  const archive = async () => {
    try {
      const res = await del<{ archived?: boolean } | undefined>(`/products/${id}`);
      await invalidateInventory();
      toast.success(res?.archived ? 'Product archived' : 'Product deleted', res?.archived ? 'It has history, so it stays in old documents.' : undefined);
      navigate('/products', { replace: true });
    } catch (err) {
      toast.error('Could not remove the product', errorMessage(err));
    } finally {
      setConfirm(false);
    }
  };

  const replenish = async () => {
    const loc = locations[0];
    if (!loc || !id) return;
    try {
      const res = await post<{ id: number }>(`/products/${id}/replenish`, { locationId: loc.id });
      await invalidateInventory();
      navigate(`/receipts/${res.id}`);
    } catch (err) {
      toast.error('Could not create the receipt', errorMessage(err));
    }
  };

  if (error) return <ErrorBox error={error} retry={() => refetch()} />;
  if (!isNew && isLoading) {
    return (
      <div className="panel">
        <SkeletonRows rows={5} cols={3} />
      </div>
    );
  }

  return (
    <div className="product-page">
      <Link to="/products" className="back-link">
        <ArrowLeft size={14} /> Products
      </Link>
      <header className="page-head">
        <div className="page-head__text">
          <h1 className="page-title">{isNew ? 'New product' : product?.name}</h1>
          {product && (
            <div className="page-meta">
              <span className="tag">{product.sku}</span>
              <StockPill status={product.stockStatus} />
              {product.archived && <span className="pill">Archived</span>}
              <span>Added {dateTime(product.createdAt)}</span>
            </div>
          )}
        </div>
        {product && (
          <div className="page-head__actions">
            {product.stockStatus !== 'ok' && (
              <Button variant="dark" onClick={replenish}>
                <ArrowDownLeft size={17} /> Replenish
              </Button>
            )}
            {me?.role === 'manager' && !product.archived && (
              <Button onClick={() => setConfirm(true)}>
                <Archive size={17} /> Archive
              </Button>
            )}
          </div>
        )}
      </header>

      {product && (
        <div className="product-stats">
          <div>
            <span>On hand</span>
            <b>{qtyUom(product.onHand, product.uom)}</b>
          </div>
          <div>
            <span>Free to use</span>
            <b>{qtyUom(product.free, product.uom)}</b>
          </div>
          <div>
            <span>Reserved</span>
            <b>{qtyUom(product.reserved, product.uom)}</b>
          </div>
          <div>
            <span>Stock value</span>
            <b>{money(product.onHand * product.unitCost)}</b>
          </div>
        </div>
      )}

      <div className="product-grid">
        <form className="panel" onSubmit={submit} noValidate aria-labelledby="pf-title">
          <div className="panel__head">
            <h2 id="pf-title">Details</h2>
          </div>
          <div className="panel__body">
            <div className="form-grid">
              <Field label="Product name" htmlFor="p-name" error={errors.name} className="span-2">
                <input id="p-name" className="input" value={form.name} onChange={set('name')} aria-invalid={!!errors.name || undefined} autoFocus={isNew} />
              </Field>
              <Field label="SKU / code" htmlFor="p-sku" error={errors.sku} hint="Unique. Stored in capitals.">
                <input id="p-sku" className="input mono" value={form.sku} onChange={set('sku')} aria-invalid={!!errors.sku || undefined} style={{ textTransform: 'uppercase' }} />
              </Field>
              <Field label="Unit of measure" htmlFor="p-uom">
                <input id="p-uom" className="input" list="uoms" value={form.uom} onChange={set('uom')} />
                <datalist id="uoms">
                  {UOMS.map((u) => (
                    <option key={u} value={u} />
                  ))}
                </datalist>
              </Field>
              <Field label="Category" htmlFor="p-cat">
                <select id="p-cat" className="select" value={form.categoryId} onChange={set('categoryId')}>
                  <option value="">No category</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="New category" htmlFor="p-newcat" hint="Type a name and add it">
                <div className="input-group">
                  <input id="p-newcat" className="input" value={newCategory} onChange={(e) => setNewCategory(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addCategory())} />
                  <button type="button" className="btn btn--ghost" style={{ borderRadius: '0 var(--radius) var(--radius) 0', borderLeft: 0 }} onClick={addCategory}>
                    Add
                  </button>
                </div>
              </Field>
              <Field label="Per unit cost" htmlFor="p-cost" error={errors.unitCost}>
                <div className="input-group">
                  <input id="p-cost" className="input mono" inputMode="decimal" value={form.unitCost} onChange={set('unitCost')} placeholder="0" />
                  <span className="addon">₹</span>
                </div>
              </Field>
              <div className="span-2 reorder-box">
                <p className="reorder-box__title">Reordering rule</p>
                <p className="muted" style={{ fontSize: 13 }}>
                  Alert when stock falls to the minimum. Replenishing suggests enough to reach the maximum.
                </p>
                <div className="form-grid" style={{ marginTop: 12 }}>
                  <Field label="Minimum" htmlFor="p-min" error={errors.reorderMin}>
                    <div className="input-group">
                      <input id="p-min" className="input mono" inputMode="decimal" value={form.reorderMin} onChange={set('reorderMin')} placeholder="0" />
                      <span className="addon">{uom(form.uom)}</span>
                    </div>
                  </Field>
                  <Field label="Maximum" htmlFor="p-max" error={errors.reorderMax}>
                    <div className="input-group">
                      <input id="p-max" className="input mono" inputMode="decimal" value={form.reorderMax} onChange={set('reorderMax')} placeholder="0" />
                      <span className="addon">{uom(form.uom)}</span>
                    </div>
                  </Field>
                </div>
              </div>
              {isNew && (
                <>
                  <Field label="Initial stock (optional)" htmlFor="p-init" error={errors.initialQty}>
                    <div className="input-group">
                      <input id="p-init" className="input mono" inputMode="decimal" value={form.initialQty} onChange={set('initialQty')} placeholder="0" />
                      <span className="addon">{uom(form.uom)}</span>
                    </div>
                  </Field>
                  <Field label="At location" htmlFor="p-initloc">
                    <select id="p-initloc" className="select" value={form.initialLocationId} onChange={set('initialLocationId')}>
                      {locations.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.fullName}
                        </option>
                      ))}
                    </select>
                  </Field>
                </>
              )}
            </div>
          </div>
          <div className="panel__foot" style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button type="submit" variant="primary" busy={busy} disabled={!dirty}>
              <FloppyDisk size={17} /> {isNew ? 'Create product' : 'Save changes'}
            </Button>
          </div>
        </form>

        {product && (
          <div className="product-side">
            <section className="panel">
              <div className="panel__head">
                <h2>Where it is</h2>
              </div>
              {product.locations.length ? (
                <table className="table table--compact">
                  <tbody>
                    {product.locations.map((l) => (
                      <tr key={l.locationId}>
                        <td className="mono">{l.fullName}</td>
                        <td className="n">{qtyUom(l.quantity, product.uom)}</td>
                        <td className="n muted">{l.reserved > 0 ? `${qty(l.reserved)} reserved` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty icon={<Package size={30} weight="duotone" />} title="No stock anywhere">
                  Receive it or set a quantity from the Stock page.
                </Empty>
              )}
            </section>
            <section className="panel">
              <div className="panel__head">
                <h2>Recent moves</h2>
                <Link className="btn btn--quiet btn--xs" to={`/moves?product=${product.id}`}>
                  All
                </Link>
              </div>
              <ol className="feed">
                {(moves.data?.items ?? []).map((m) => (
                  <li key={m.key} className="feed__item" data-dir={m.direction}>
                    <span className="feed__dir" aria-hidden="true">
                      {m.direction === 'in' ? <ArrowDownLeft size={15} /> : m.direction === 'out' ? <ArrowUpRight size={15} /> : <ArrowsLeftRight size={15} />}
                    </span>
                    <span className="feed__main">
                      <b className="mono">{m.reference}</b>
                      <span>
                        {m.fromName} → {m.toName}
                      </span>
                    </span>
                    <span className="feed__qty">
                      <b>{qtyUom(m.quantity, m.uom)}</b>
                      <span>{m.status === 'done' ? dateTime(m.date) : m.status}</span>
                    </span>
                  </li>
                ))}
                {moves.data && !moves.data.items.length && <li className="combo__empty">No moves yet.</li>}
              </ol>
            </section>
          </div>
        )}
      </div>

      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={archive} title={`Archive ${product?.name ?? ''}?`} confirmLabel="Archive">
        Archived products disappear from pickers and lists. Documents and ledger entries that mention it stay intact. Products with stock on hand must be counted to zero first.
      </ConfirmDialog>
    </div>
  );
}
