import {
  ArrowLeft,
  CheckCircle,
  ClipboardText,
  FloppyDisk,
  Printer,
  Plus,
  Trash,
  Warning,
  WarningCircle,
  X,
  ArrowClockwise,
  DotsThreeVertical,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router';
import { Combobox } from '../components/Combobox';
import { ConfirmDialog } from '../components/Dialog';
import { Menu } from '../components/Menu';
import { Button, ErrorBox, Field, SkeletonRows } from '../components/ui';
import { errorMessage, fieldErrors, post } from '../lib/api';
import { dateTime, qty, qtyUom, STATUS_FLOW, STATUS_LABEL, todayIso, TYPE_LABEL, TYPE_PATH, TYPE_PLURAL, uom } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import {
  queryClient,
  useLocations,
  useMe,
  useOperation,
  useOperationMutations,
  usePartners,
  useProducts,
  useStock,
  useTeam,
  type OperationPayload,
} from '../lib/queries';
import { useToast } from '../lib/toast';
import type { Operation, OpStatus, OpType, Partner } from '../lib/types';

interface LineDraft {
  key: string;
  productId: number | null;
  quantity: string;
}
interface Draft {
  partnerId: number | null;
  sourceLocationId: number | null;
  destLocationId: number | null;
  scheduledDate: string;
  responsibleId: number | null;
  deliveryAddress: string;
  notes: string;
  lines: LineDraft[];
}

let lineSeq = 0;
const newLine = (productId: number | null = null, quantity = ''): LineDraft => ({ key: `l${++lineSeq}`, productId, quantity });

function fromOperation(op: Operation): Draft {
  return {
    partnerId: op.partnerId,
    sourceLocationId: op.sourceLocationId,
    destLocationId: op.destLocationId,
    scheduledDate: op.scheduledDate,
    responsibleId: op.responsibleId,
    deliveryAddress: op.deliveryAddress,
    notes: op.notes,
    lines: op.lines.map((l) => newLine(l.productId, String(l.quantity))),
  };
}

function payload(type: OpType, d: Draft): OperationPayload {
  return {
    partnerId: d.partnerId,
    sourceLocationId: type === 'receipt' ? undefined : d.sourceLocationId,
    destLocationId: type === 'receipt' || type === 'internal' ? d.destLocationId : undefined,
    scheduledDate: d.scheduledDate || null,
    responsibleId: d.responsibleId,
    deliveryAddress: d.deliveryAddress,
    notes: d.notes,
    lines: d.lines
      .filter((l) => l.productId && l.quantity.trim() !== '')
      .map((l) => ({ productId: l.productId!, quantity: Number(l.quantity) })),
  };
}

const same = (a: Draft | null, b: Draft | null) =>
  !!a &&
  !!b &&
  JSON.stringify({ ...a, lines: a.lines.map((l) => [l.productId, Number(l.quantity)]) }) ===
    JSON.stringify({ ...b, lines: b.lines.map((l) => [l.productId, Number(l.quantity)]) });

/** Remount per document so switching between documents never leaks form state. */
export default function OperationFormRoute({ type }: { type: OpType }) {
  const { id } = useParams();
  return <OperationForm key={`${type}-${id ?? 'new'}`} type={type} />;
}

function OperationForm({ type }: { type: OpType }) {
  const { id: idParam } = useParams();
  const id = idParam ? Number(idParam) : undefined;
  const isNew = !id;
  const navigate = useNavigate();
  const toast = useToast();
  const { data: me } = useMe();
  const { data: op, error, isLoading, refetch } = useOperation(id);
  const { data: locations = [] } = useLocations();
  const { data: products = [] } = useProducts();
  const { data: team = [] } = useTeam();
  const partnerKind = type === 'receipt' ? 'vendor' : type === 'delivery' ? 'customer' : '';
  const { data: partners = [] } = usePartners(partnerKind ? { kind: partnerKind } : {});
  const m = useOperationMutations();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [base, setBase] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null);
  const saveRef = useRef<() => Promise<void>>(async () => undefined);
  const dirtyRef = useRef(false);
  const allowLeave = useRef(false);

  useDocumentTitle(op?.reference ?? `New ${TYPE_LABEL[type].toLowerCase()}`);

  // Load the server copy into the form, unless the user is in the middle of editing.
  useEffect(() => {
    if (!op || dirtyRef.current) return;
    const d = fromOperation(op);
    setDraft(d);
    setBase(d);
  }, [op]);
  useEffect(() => {
    if (!isNew || draft || !locations.length || !me) return;
    // default to the busiest locations rather than whatever sorts first
    const internal = locations.filter((l) => l.type === 'internal').sort((a, b) => b.productCount - a.productCount || a.id - b.id);
    const d: Draft = {
      partnerId: null,
      sourceLocationId: type === 'receipt' ? null : internal[0]?.id ?? null,
      destLocationId: type === 'receipt' ? internal[0]?.id ?? null : type === 'internal' ? internal[1]?.id ?? null : null,
      scheduledDate: todayIso(),
      responsibleId: me.id,
      deliveryAddress: '',
      notes: '',
      lines: [newLine()],
    };
    setDraft(d);
    setBase(d);
  }, [isNew, draft, locations, me, type]);

  const status: OpStatus = op?.status ?? 'draft';
  const locked = status === 'done' || status === 'canceled';
  const dirty = isNew ? !!draft && draft.lines.some((l) => l.productId) : !!draft && !!base && !same(draft, base);
  dirtyRef.current = dirty;

  // stock at the source so short lines turn red before anyone validates
  const sourceId = type === 'receipt' ? null : draft?.sourceLocationId;
  const { data: sourceStock } = useStock(sourceId ? { locationId: sourceId } : {}, !!sourceId);
  const stockAt = useMemo(() => {
    const map = new Map<number, { onHand: number; free: number }>();
    if (sourceId) for (const r of sourceStock?.items ?? []) map.set(r.id, { onHand: r.onHand, free: r.free });
    return map;
  }, [sourceStock, sourceId]);

  const productOptions = useMemo(
    () => products.map((p) => ({ value: p.id, label: `[${p.sku}] ${p.name}`, sub: p.uom })),
    [products],
  );
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const internalLocs = locations.filter((l) => l.type === 'internal');
  const opLine = (productId: number | null) => op?.lines.find((l) => l.productId === productId);

  /** How much of a line the source can supply for this document. */
  const availableFor = (productId: number) => {
    const ol = opLine(productId);
    // server figure already counts this document's own reservation
    if (ol && !dirty) return ol.available;
    const s = stockAt.get(productId);
    return (s?.free ?? 0) + (ol?.reserved ?? 0);
  };
  const needsStock = type === 'delivery' || type === 'internal';
  const shortLines = needsStock && !locked && draft
    ? draft.lines.filter((l) => l.productId && Number(l.quantity) > 0 && availableFor(l.productId) < Number(l.quantity))
    : [];

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const setLine = (key: string, patch: Partial<LineDraft>) =>
    setDraft((d) => (d ? { ...d, lines: d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) } : d));

  const validateLocal = (): boolean => {
    if (!draft) return false;
    const e: Record<string, string> = {};
    const lines = draft.lines.filter((l) => l.productId);
    if (!lines.length) e.lines = 'Add at least one product';
    for (const l of lines) {
      const n = Number(l.quantity);
      if (l.quantity.trim() === '' || !Number.isFinite(n) || n < 0 || (type !== 'adjustment' && n <= 0)) {
        e.lines = type === 'adjustment' ? 'Enter a counted quantity for every product' : 'Every product needs a quantity above zero';
      }
    }
    if (type === 'internal' && draft.sourceLocationId === draft.destLocationId) e.destLocationId = 'Pick a different location';
    setErrors(e);
    return !Object.keys(e).length;
  };

  /** Persist the draft. Returns the saved operation (or the current one when nothing changed). */
  const save = async (quiet = false): Promise<Operation | undefined> => {
    if (!draft || !validateLocal()) return undefined;
    setErrors({});
    try {
      if (isNew) {
        const created = await m.create.mutateAsync({ type, ...payload(type, draft) });
        const d = fromOperation(created);
        setBase(d);
        setDraft(d);
        if (!quiet) toast.success(`${created.reference} saved as draft`);
        allowLeave.current = true;
        navigate(`${TYPE_PATH[type]}/${created.id}`, { replace: true });
        return created;
      }
      if (!dirty) return op;
      const updated = await m.update.mutateAsync({ id: id!, body: payload(type, draft) });
      const d = fromOperation(updated);
      setBase(d);
      setDraft(d);
      if (!quiet) toast.success(`${updated.reference} saved`, updated.status === 'waiting' ? 'Still waiting for stock.' : undefined);
      return updated;
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error('Could not save', errorMessage(err));
      return undefined;
    }
  };
  saveRef.current = async () => {
    if (!locked) await save();
  };

  const run = async (action: 'confirm' | 'validate' | 'check-availability' | 'cancel') => {
    setBusy(action);
    try {
      const saved = action === 'cancel' ? op : await save(true);
      if (!saved) return;
      const res = await m.action.mutateAsync({ id: saved.id, action });
      const d = fromOperation(res);
      setBase(d);
      setDraft(d);
      if (action === 'confirm') {
        if (res.status === 'waiting') toast.info(`${res.reference} is waiting for stock`, 'It turns ready by itself as soon as enough stock arrives.');
        else toast.success(`${res.reference} is ready`, type === 'receipt' ? 'Validate once the goods are in.' : 'Stock is reserved for it.');
      } else if (action === 'validate') {
        const total = res.lines.reduce((a, l) => a + (type === 'adjustment' ? 0 : l.quantity), 0);
        const verb = type === 'receipt' ? `Stock +${qty(total)}` : type === 'delivery' ? `Stock −${qty(total)}` : type === 'internal' ? `${qty(total)} moved` : 'Count applied';
        toast.success(`${res.reference} validated`, `${verb}. Logged in the stock ledger.`);
        if (res.readied?.length) toast.info(`${res.readied.length} waiting ${res.readied.length === 1 ? 'document is' : 'documents are'} now ready`, 'The new stock unblocked them.');
      } else if (action === 'check-availability') {
        toast[res.status === 'ready' ? 'success' : 'info'](res.status === 'ready' ? `${res.reference} is ready` : 'Still not enough stock');
      } else if (action === 'cancel') {
        toast.success(`${res.reference} canceled`);
      }
    } catch (err) {
      toast.error('Could not complete that', errorMessage(err));
      void refetch();
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  const remove = async () => {
    if (!op) return;
    setBusy('delete');
    try {
      await m.remove.mutateAsync(op.id);
      toast.success(`${op.reference} deleted`);
      allowLeave.current = true;
      navigate(TYPE_PATH[type], { replace: true });
    } catch (err) {
      toast.error('Could not delete', errorMessage(err));
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  // Ctrl/Cmd+S saves
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirtyRef.current && !allowLeave.current && currentLocation.pathname !== nextLocation.pathname,
  );

  const createPartner = async (name: string) => {
    try {
      const p = await post<Partner>('/partners', { name, kind: type === 'receipt' ? 'vendor' : 'customer' });
      await queryClient.invalidateQueries({ queryKey: ['partners'] });
      set('partnerId', p.id);
      toast.success(`Contact “${p.name}” created`);
    } catch (err) {
      toast.error('Could not create the contact', errorMessage(err));
    }
  };

  if (error) return <ErrorBox error={error} retry={() => refetch()} />;
  if (!draft || (isLoading && !isNew)) {
    return (
      <div className="panel" style={{ marginTop: 20 }}>
        <SkeletonRows rows={5} cols={4} />
      </div>
    );
  }

  const flow = STATUS_FLOW[type];
  const idx = flow.indexOf(status);
  const partnerOptions = partners.map((p) => ({ value: p.id, label: p.name }));
  const title = op?.reference ?? `New ${TYPE_LABEL[type].toLowerCase()}`;

  return (
    <div className="opform" data-type={type}>
      <Link to={TYPE_PATH[type]} className="back-link">
        <ArrowLeft size={14} /> {TYPE_PLURAL[type]}
      </Link>

      <div className="opform__bar">
        <div className="opform__title">
          <h1 className={op ? 'opform__ref mono' : 'page-title'}>{title}</h1>
          <ol className="stepper" aria-label="Status">
            {(status === 'canceled' ? [...flow.slice(0, 1), 'canceled' as OpStatus] : flow).map((s, i) => (
              <li
                key={s}
                data-s={s}
                className={s === status ? 'is-current' : status !== 'canceled' && i < idx ? 'is-past' : ''}
                aria-current={s === status ? 'step' : undefined}
              >
                {STATUS_LABEL[s]}
              </li>
            ))}
          </ol>
        </div>

        <div className="opform__actions">
          {!locked && (dirty || isNew) && (
            <Button onClick={() => save()} busy={m.create.isPending || m.update.isPending} title="Save (Ctrl+S)">
              <FloppyDisk size={17} /> Save
            </Button>
          )}
          {status === 'draft' && type !== 'adjustment' && (
            <Button variant="dark" onClick={() => run('confirm')} busy={busy === 'confirm'}>
              <ClipboardText size={17} /> To Do
            </Button>
          )}
          {status === 'waiting' && (
            <Button variant="dark" onClick={() => run('check-availability')} busy={busy === 'check-availability'}>
              <ArrowClockwise size={17} /> Check availability
            </Button>
          )}
          {(status === 'ready' || (status === 'draft' && type === 'adjustment')) && (
            <Button variant="primary" onClick={() => run('validate')} busy={busy === 'validate'} disabled={shortLines.length > 0}>
              <CheckCircle size={17} weight="bold" /> {type === 'adjustment' ? 'Apply count' : 'Validate'}
            </Button>
          )}
          {status === 'done' && op && (
            <a className="btn btn--ghost" href={`/app/print/${op.id}`} target="_blank" rel="noopener">
              <Printer size={17} /> Print
            </a>
          )}
          {!isNew && op && (
            <Menu
              label="More actions"
              trigger={({ open, toggle, id: menuId }) => (
                <button type="button" className="btn btn--ghost btn--icon" aria-label="More actions" aria-expanded={open} aria-controls={menuId} onClick={toggle}>
                  <DotsThreeVertical size={18} weight="bold" />
                </button>
              )}
            >
              {(close) => (
                <>
                  {!locked && (
                    <button type="button" role="menuitem" className="menu-item" onClick={() => (close(), setConfirm('cancel'))}>
                      <X size={17} /> Cancel document
                    </button>
                  )}
                  {(status === 'draft' || status === 'canceled') && (
                    <button type="button" role="menuitem" className="menu-item" onClick={() => (close(), setConfirm('delete'))}>
                      <Trash size={17} /> Delete
                    </button>
                  )}
                  {status === 'done' && (
                    <a role="menuitem" className="menu-item" href={`/app/print/${op.id}`} target="_blank" rel="noopener">
                      <Printer size={17} /> Print
                    </a>
                  )}
                </>
              )}
            </Menu>
          )}
        </div>
      </div>

      {status === 'waiting' && (
        <div className="note-box" style={{ marginBottom: 16 }}>
          <Warning size={18} weight="fill" aria-hidden="true" />
          <span>
            <b>Waiting for stock.</b> The lines marked red are short at the source. This document turns ready by itself when a receipt or transfer brings enough in.
          </span>
        </div>
      )}
      {shortLines.length > 0 && status !== 'waiting' && (
        <div className="error-box" role="alert" style={{ marginBottom: 16 }}>
          <WarningCircle size={20} weight="fill" aria-hidden="true" />
          <span>
            {shortLines.length === 1 ? '1 product is' : `${shortLines.length} products are`} not in stock at the source. {status === 'draft' ? 'You can still mark it To Do; it will wait for stock.' : ''}
          </span>
        </div>
      )}
      {status === 'done' && op?.validatedAt && (
        <div className="done-strip">
          <CheckCircle size={18} weight="fill" aria-hidden="true" />
          Validated {dateTime(op.validatedAt)}
          {op.validatedByName ? ` by ${op.validatedByName}` : ''}. Stock and ledger updated.
        </div>
      )}

      <section className="panel opform__head">
        <div className="form-grid form-grid--3">
          {(type === 'receipt' || type === 'delivery') && (
            <Field label={type === 'receipt' ? 'Receive from' : 'Deliver to'} htmlFor="f-partner" error={errors.partnerId}>
              <Combobox
                id="f-partner"
                options={partnerOptions}
                value={draft.partnerId}
                disabled={locked}
                placeholder={type === 'receipt' ? 'Pick a vendor' : 'Pick a customer'}
                onChange={(v) => {
                  set('partnerId', v);
                  const p = partners.find((x) => x.id === v);
                  if (type === 'delivery' && p?.address && !draft.deliveryAddress) set('deliveryAddress', p.address);
                }}
                onCreate={createPartner}
                createLabel="New contact"
              />
            </Field>
          )}

          {type === 'receipt' && (
            <Field label="Destination" htmlFor="f-dest" error={errors.destLocationId ?? errors.location}>
              <select id="f-dest" className="select" value={draft.destLocationId ?? ''} disabled={locked} onChange={(e) => set('destLocationId', Number(e.target.value))}>
                {internalLocs.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.fullName}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {type !== 'receipt' && (
            <Field
              label={type === 'delivery' ? 'Operation type' : type === 'adjustment' ? 'Location counted' : 'From'}
              htmlFor="f-src"
              error={errors.sourceLocationId ?? errors.location}
              hint={type === 'delivery' ? 'Delivery order and the location it ships from' : undefined}
            >
              <select id="f-src" className="select" value={draft.sourceLocationId ?? ''} disabled={locked} onChange={(e) => set('sourceLocationId', Number(e.target.value))}>
                {internalLocs.map((l) => (
                  <option key={l.id} value={l.id}>
                    {type === 'delivery' ? `${l.warehouseCode}: Delivery from ${l.fullName}` : l.fullName}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {type === 'internal' && (
            <Field label="To" htmlFor="f-dst" error={errors.destLocationId}>
              <select id="f-dst" className="select" value={draft.destLocationId ?? ''} disabled={locked} onChange={(e) => set('destLocationId', Number(e.target.value))}>
                <option value="" disabled>
                  Pick a location
                </option>
                {internalLocs.map((l) => (
                  <option key={l.id} value={l.id} disabled={l.id === draft.sourceLocationId}>
                    {l.fullName}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label={type === 'adjustment' ? 'Count date' : 'Schedule date'} htmlFor="f-date" error={errors.scheduledDate}>
            <input id="f-date" type="date" className="input" value={draft.scheduledDate} disabled={locked} onChange={(e) => set('scheduledDate', e.target.value)} />
          </Field>

          <Field label="Responsible" htmlFor="f-resp">
            <select
              id="f-resp"
              className="select"
              value={draft.responsibleId ?? ''}
              disabled={locked}
              onChange={(e) => set('responsibleId', e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Unassigned</option>
              {team.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                  {u.id === me?.id ? ' (you)' : ''}
                </option>
              ))}
            </select>
          </Field>

          {type === 'delivery' && (
            <Field label="Delivery address" htmlFor="f-addr" className="span-2">
              <input id="f-addr" className="input" value={draft.deliveryAddress} disabled={locked} onChange={(e) => set('deliveryAddress', e.target.value)} />
            </Field>
          )}

          <Field
            label={type === 'adjustment' ? 'Reason' : 'Notes'}
            htmlFor="f-notes"
            className={type === 'delivery' ? '' : 'span-2'}
          >
            <input
              id="f-notes"
              className="input"
              value={draft.notes}
              disabled={locked}
              placeholder={type === 'adjustment' ? 'Damaged, cycle count, found stock...' : 'Optional'}
              onChange={(e) => set('notes', e.target.value)}
            />
          </Field>
        </div>
      </section>

      <section className="panel" aria-labelledby="lines-title">
        <div className="panel__head">
          <h2 id="lines-title">Products</h2>
          {errors.lines && (
            <span className="error" role="alert" style={{ color: 'var(--out)', fontSize: 13, fontWeight: 500, display: 'inline-flex', gap: 5, alignItems: 'center' }}>
              <WarningCircle size={14} weight="fill" /> {errors.lines}
            </span>
          )}
        </div>
        <div className="table-wrap">
          <table className="table lines">
            <thead>
              <tr>
                <th style={{ minWidth: 260 }}>Product</th>
                {type === 'adjustment' ? (
                  <>
                    <th className="n">{locked ? 'Recorded' : 'On hand now'}</th>
                    <th className="n" style={{ width: 170 }}>
                      Counted
                    </th>
                    <th className="n">Difference</th>
                  </>
                ) : (
                  <>
                    {needsStock && <th className="n">Available at source</th>}
                    <th className="n" style={{ width: 180 }}>
                      Quantity
                    </th>
                  </>
                )}
                {!locked && <th className="shrink" aria-label="Remove" />}
              </tr>
            </thead>
            <tbody>
              {draft.lines.map((l) => {
                const p = l.productId ? productById.get(l.productId) : undefined;
                const ol = opLine(l.productId);
                const n = Number(l.quantity);
                const avail = l.productId ? availableFor(l.productId) : 0;
                const short = needsStock && !locked && !!l.productId && n > 0 && avail < n;
                const system = locked ? ol?.systemQuantity ?? 0 : l.productId ? stockAt.get(l.productId)?.onHand ?? 0 : 0;
                const diff = l.quantity.trim() === '' ? null : n - system;
                return (
                  <tr key={l.key} className={short ? 'is-short' : ''}>
                    <td>
                      {locked ? (
                        <span className="cell-main">
                          <span className="mono muted">[{ol?.sku ?? p?.sku}]</span> {ol?.productName ?? p?.name}
                        </span>
                      ) : (
                        <Combobox
                          options={productOptions.map((o) => ({ ...o, disabled: o.value !== l.productId && draft.lines.some((x) => x.productId === o.value) }))}
                          value={l.productId}
                          onChange={(v) => setLine(l.key, { productId: v })}
                          placeholder="Search product or SKU"
                          invalid={!!errors.lines && !l.productId}
                        />
                      )}
                    </td>
                    {type === 'adjustment' ? (
                      <>
                        <td className="n">{p || ol ? qtyUom(system, p?.uom ?? ol?.uom ?? '') : ''}</td>
                        <td className="n">
                          {locked ? (
                            qtyUom(n, ol?.uom ?? '')
                          ) : (
                            <QtyInput value={l.quantity} onChange={(v) => setLine(l.key, { quantity: v })} unit={p ? uom(p.uom) : ''} label="Counted quantity" />
                          )}
                        </td>
                        <td className={`n ${diff && diff > 0 ? 'c-in' : diff && diff < 0 ? 'c-out' : ''}`}>
                          {diff === null || !l.productId ? '' : diff === 0 ? 'No change' : `${diff > 0 ? '+' : '−'}${qty(Math.abs(diff))}`}
                        </td>
                      </>
                    ) : (
                      <>
                        {needsStock && (
                          <td className="n">
                            {l.productId ? (
                              <span className={short ? 'c-out' : ''}>
                                {short && <Warning size={14} weight="fill" aria-hidden="true" style={{ display: 'inline', verticalAlign: -2, marginRight: 4 }} />}
                                {locked ? '' : qtyUom(Math.max(avail, 0), p?.uom ?? '')}
                                {short && <span className="sr-only"> (not enough stock)</span>}
                              </span>
                            ) : null}
                          </td>
                        )}
                        <td className="n">
                          {locked ? (
                            qtyUom(n, ol?.uom ?? p?.uom ?? '')
                          ) : (
                            <QtyInput value={l.quantity} onChange={(v) => setLine(l.key, { quantity: v })} unit={p ? uom(p.uom) : ''} label="Quantity" invalid={short} />
                          )}
                        </td>
                      </>
                    )}
                    {!locked && (
                      <td className="shrink">
                        <button
                          type="button"
                          className="btn btn--quiet btn--icon btn--sm"
                          aria-label="Remove line"
                          onClick={() => setDraft((d) => (d ? { ...d, lines: d.lines.length > 1 ? d.lines.filter((x) => x.key !== l.key) : [newLine()] } : d))}
                        >
                          <Trash size={16} />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!locked && (
          <div className="panel__foot">
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => setDraft((d) => (d ? { ...d, lines: [...d.lines, newLine()] } : d))}>
              <Plus size={15} weight="bold" /> Add a product
            </button>
          </div>
        )}
      </section>

      {op && (
        <p className="opform__meta">
          {op.warehouseCode} warehouse. Created {dateTime(op.createdAt)}
          {op.createdByName ? ` by ${op.createdByName}` : ''}.
        </p>
      )}

      <ConfirmDialog
        open={confirm === 'cancel'}
        onClose={() => setConfirm(null)}
        onConfirm={() => run('cancel')}
        title={`Cancel ${op?.reference ?? ''}?`}
        confirmLabel="Cancel document"
        busy={busy === 'cancel'}
      >
        Reserved stock is released and waiting documents get a chance to use it. Canceled documents stay in the history.
      </ConfirmDialog>
      <ConfirmDialog open={confirm === 'delete'} onClose={() => setConfirm(null)} onConfirm={remove} title={`Delete ${op?.reference ?? ''}?`} confirmLabel="Delete" busy={busy === 'delete'}>
        This removes the document for good. Only drafts and canceled documents can be deleted.
      </ConfirmDialog>
      <ConfirmDialog
        open={blocker.state === 'blocked'}
        onClose={() => blocker.reset?.()}
        onConfirm={() => blocker.proceed?.()}
        title="Leave without saving?"
        confirmLabel="Discard changes"
      >
        You have unsaved changes on {title}.
      </ConfirmDialog>
    </div>
  );
}

function QtyInput({ value, onChange, unit, label, invalid }: { value: string; onChange: (v: string) => void; unit: string; label: string; invalid?: boolean }) {
  return (
    <div className="input-group qty-input">
      <input
        className="input mono"
        inputMode="decimal"
        value={value}
        aria-label={label}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))}
        placeholder="0"
      />
      {unit && <span className="addon">{unit}</span>}
    </div>
  );
}
