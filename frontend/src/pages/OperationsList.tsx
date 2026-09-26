import { ArrowDownLeft, ArrowUpRight, ArrowsLeftRight, CalendarBlank, Kanban, ListBullets, MagnifyingGlass, Plus, Scales, Stack, User } from '@phosphor-icons/react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useMemo, useState, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Empty, ErrorBox, PageHeader, SkeletonRows, StatusPill } from '../components/ui';
import { errorMessage } from '../lib/api';
import { day, qty, STATUS_FLOW, STATUS_LABEL, TYPE_LABEL, TYPE_PATH, TYPE_PLURAL } from '../lib/format';
import { useDebounced, useDocumentTitle, useQueryState } from '../lib/hooks';
import { useOperationMutations, useOperations, useWarehouses } from '../lib/queries';
import { useToast } from '../lib/toast';
import type { OperationSummary, OpStatus, OpType } from '../lib/types';

const ICON: Record<OpType, typeof ArrowDownLeft> = {
  receipt: ArrowDownLeft,
  delivery: ArrowUpRight,
  internal: ArrowsLeftRight,
  adjustment: Scales,
};
const DIR: Record<OpType, string> = { receipt: 'in', delivery: 'out', internal: 'internal', adjustment: 'internal' };

const BLURB: Record<OpType, string> = {
  receipt: 'Goods arriving from vendors. Validate to add them to stock.',
  delivery: 'Goods leaving for customers. Stock is reserved when a delivery is ready.',
  internal: 'Moves between locations. The total stays the same, the location changes.',
  adjustment: 'Physical counts. The counted quantity replaces what the system held.',
};

/** Which drag-and-drop transitions the kanban accepts, and the API action behind each. */
function actionFor(from: OpStatus, to: OpStatus): 'confirm' | 'validate' | 'cancel' | 'check-availability' | null {
  if (to === 'canceled' && from !== 'done' && from !== 'canceled') return 'cancel';
  if (from === 'draft' && (to === 'ready' || to === 'waiting')) return 'confirm';
  if (from === 'waiting' && to === 'ready') return 'check-availability';
  if (from === 'ready' && to === 'done') return 'validate';
  return null;
}

export default function OperationsList({ type }: { type: OpType }) {
  useDocumentTitle(TYPE_PLURAL[type]);
  const [view, setView] = useQueryState('view', 'list');
  const [status, setStatus] = useQueryState('status');
  const [search, setSearch] = useQueryState('q');
  const [warehouseId, setWarehouse] = useQueryState('warehouse');
  const term = useDebounced(search, 250);
  const { data: warehouses = [] } = useWarehouses();

  // kanban shows every status, so it ignores the status chip
  const listStatus = view === 'kanban' ? '' : status;
  const { data, error, isLoading, isFetching, refetch } = useOperations({ type, status: listStatus, search: term, warehouseId });
  const all = useOperations({ type, search: term, warehouseId });
  const counts = useMemo(() => {
    const c: Record<string, number> = { pending: 0, late: 0 };
    for (const o of all.data ?? []) {
      c[o.status] = (c[o.status] ?? 0) + 1;
      if (o.status !== 'done' && o.status !== 'canceled') c.pending! += 1;
      if (o.late) c.late! += 1;
    }
    return c;
  }, [all.data]);

  const Icon = ICON[type];
  const flow = STATUS_FLOW[type];
  const chips: { key: string; label: string }[] = [
    { key: '', label: 'All' },
    { key: 'pending', label: 'Open' },
    ...(type === 'adjustment' ? [] : [{ key: 'late', label: 'Late' }]),
    ...flow.map((s) => ({ key: s, label: STATUS_LABEL[s] })),
    { key: 'canceled', label: 'Canceled' },
  ];

  return (
    <div>
      <PageHeader
        title={
          <span className="title-with-icon">
            <Icon size={34} weight="bold" aria-hidden="true" />
            {TYPE_PLURAL[type]}
          </span>
        }
        meta={<span>{BLURB[type]}</span>}
        actions={
          <Link className="btn btn--primary" to={`${TYPE_PATH[type]}/new`}>
            <Plus size={17} weight="bold" /> New {TYPE_LABEL[type].toLowerCase()}
          </Link>
        }
      />

      <div className="toolbar">
        <div className="input-icon grow">
          <MagnifyingGlass size={16} aria-hidden="true" />
          <input
            className="input"
            type="search"
            placeholder={type === 'adjustment' ? 'Search reference or product' : 'Search reference, contact or product'}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search"
          />
        </div>
        {warehouses.length > 1 && (
          <select className="select" value={warehouseId} onChange={(e) => setWarehouse(e.target.value)} aria-label="Warehouse">
            <option value="">All warehouses</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.shortCode}
              </option>
            ))}
          </select>
        )}
        <span className="spacer" />
        <div className="segmented" role="group" aria-label="View">
          <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>
            <ListBullets size={16} /> List
          </button>
          <button type="button" aria-pressed={view === 'kanban'} onClick={() => setView('kanban')}>
            <Kanban size={16} /> Kanban
          </button>
        </div>
      </div>

      {view === 'list' && (
        <div className="chips" role="group" aria-label="Filter by status" style={{ marginBottom: 14 }}>
          {chips.map((c) => (
            <button key={c.key} type="button" className="chip" aria-pressed={status === c.key} onClick={() => setStatus(c.key)}>
              {c.label}
              {c.key && counts[c.key] ? <span className="badge">{counts[c.key]}</span> : null}
            </button>
          ))}
        </div>
      )}

      {error ? (
        <ErrorBox error={error} retry={() => refetch()} />
      ) : view === 'kanban' ? (
        <KanbanBoard type={type} items={data ?? []} loading={isLoading} />
      ) : (
        <div className="panel" style={{ opacity: isFetching && !isLoading ? 0.7 : 1, transition: 'opacity .2s' }}>
          {isLoading ? (
            <SkeletonRows cols={6} />
          ) : !data?.length ? (
            <Empty
              icon={<Stack size={38} weight="duotone" />}
              title={search || status ? 'No documents match' : `No ${TYPE_PLURAL[type].toLowerCase()} yet`}
              action={
                <Link className="btn btn--primary btn--sm" to={`${TYPE_PATH[type]}/new`}>
                  <Plus size={15} weight="bold" /> New {TYPE_LABEL[type].toLowerCase()}
                </Link>
              }
            >
              {search || status ? 'Try another search or status.' : BLURB[type]}
            </Empty>
          ) : (
            <ListTable type={type} items={data} />
          )}
        </div>
      )}
    </div>
  );
}

function ListTable({ type, items }: { type: OpType; items: OperationSummary[] }) {
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  return (
    <div className="table-wrap has-mcards">
      <table className="table">
        <thead>
          <tr>
            <th>Reference</th>
            <th>From</th>
            <th>To</th>
            {type !== 'adjustment' && type !== 'internal' && <th>Contact</th>}
            <th>Schedule date</th>
            <th className="n">Qty</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <AnimatePresence initial={false}>
            {items.map((o, i) => {
              const to = `${TYPE_PATH[o.type]}/${o.id}`;
              return (
                <motion.tr
                  key={o.id}
                  className="is-link"
                  data-dir={DIR[type]}
                  onClick={() => navigate(to)}
                  initial={reduce ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: Math.min(i, 12) * 0.02 }}
                >
                  <td className="ref">
                    <Link to={to} onClick={(e) => e.stopPropagation()}>
                      {o.reference}
                    </Link>
                  </td>
                  <td className="mono" style={{ fontSize: 13 }}>
                    {o.sourceName}
                  </td>
                  <td className="mono" style={{ fontSize: 13 }}>
                    {o.destName}
                  </td>
                  {type !== 'adjustment' && type !== 'internal' && <td>{o.partnerName ?? <span className="muted">No contact</span>}</td>}
                  <td>{day(o.scheduledDate)}</td>
                  <td className="n">
                    {qty(o.totalQuantity)}
                    <span className="cell-sub" style={{ display: 'inline', marginLeft: 6 }}>
                      {o.lineCount} {o.lineCount === 1 ? 'line' : 'lines'}
                    </span>
                  </td>
                  <td>
                    <StatusPill status={o.status} late={o.late} />
                  </td>
                </motion.tr>
              );
            })}
          </AnimatePresence>
        </tbody>
      </table>
      {/* phones get cards instead of a wide table */}
      <ul className="mcards" aria-label={`${TYPE_PLURAL[type]} list`}>
        {items.map((o) => (
          <li key={o.id}>
            <Link to={`${TYPE_PATH[o.type]}/${o.id}`} className="mcard" data-dir={DIR[type]}>
              <span className="mcard__top">
                <b className="mono">{o.reference}</b>
                <StatusPill status={o.status} late={o.late} />
              </span>
              <span className="mcard__title">{o.partnerName ?? `${o.sourceName} → ${o.destName}`}</span>
              <span className="mcard__meta">
                <span className="mono">
                  {o.sourceName} → {o.destName}
                </span>
                <span>{day(o.scheduledDate)}</span>
                <span>
                  {qty(o.totalQuantity)} in {o.lineCount} {o.lineCount === 1 ? 'line' : 'lines'}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function KanbanBoard({ type, items, loading }: { type: OpType; items: OperationSummary[]; loading: boolean }) {
  const columns: OpStatus[] = [...STATUS_FLOW[type], 'canceled'];
  const { action } = useOperationMutations();
  const toast = useToast();
  const reduce = useReducedMotion();
  const [drag, setDrag] = useState<OperationSummary | null>(null);
  const [over, setOver] = useState<OpStatus | null>(null);

  const drop = async (e: DragEvent, to: OpStatus) => {
    e.preventDefault();
    setOver(null);
    const op = drag;
    setDrag(null);
    if (!op || op.status === to) return;
    const act = actionFor(op.status, to);
    if (!act) {
      toast.info('That move is not allowed', `${STATUS_LABEL[op.status]} cannot go straight to ${STATUS_LABEL[to]}.`);
      return;
    }
    try {
      const res = await action.mutateAsync({ id: op.id, action: act });
      if (res.status !== to) toast.info(`${res.reference} is ${STATUS_LABEL[res.status].toLowerCase()}`, res.status === 'waiting' ? 'Not enough free stock yet.' : undefined);
      else toast.success(`${res.reference} moved to ${STATUS_LABEL[to]}`);
    } catch (err) {
      toast.error(`Could not update ${op.reference}`, errorMessage(err));
    }
  };

  return (
    <div className="kanban" aria-busy={loading}>
      {columns.map((col) => {
        const cards = items.filter((o) => o.status === col);
        const allowed = drag ? drag.status === col || !!actionFor(drag.status, col) : true;
        return (
          <section
            key={col}
            className={`kanban__col ${over === col && allowed ? 'is-drop' : ''} ${drag && !allowed ? 'is-blocked' : ''}`}
            onDragOver={(e) => {
              if (allowed) {
                e.preventDefault();
                setOver(col);
              }
            }}
            onDragLeave={() => setOver((o) => (o === col ? null : o))}
            onDrop={(e) => drop(e, col)}
            aria-label={`${STATUS_LABEL[col]}, ${cards.length} documents`}
          >
            <header className="kanban__head">
              <h3>
                <span className="pill" data-status={col}>
                  {STATUS_LABEL[col]}
                </span>
              </h3>
              <span className="badge">{cards.length}</span>
            </header>
            <div className="kanban__cards">
              <AnimatePresence initial={false}>
                {cards.map((o) => (
                  <motion.div key={o.id} layout={!reduce} initial={reduce ? false : { opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
                    <Link
                      to={`${TYPE_PATH[o.type]}/${o.id}`}
                      className={`kcard ${drag?.id === o.id ? 'is-dragging' : ''}`}
                      data-dir={DIR[type]}
                      draggable
                      onDragStart={(e) => {
                        setDrag(o);
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', o.reference);
                      }}
                      onDragEnd={() => {
                        setDrag(null);
                        setOver(null);
                      }}
                    >
                      <div className="kcard__top">
                        <span className="kcard__ref">{o.reference}</span>
                        {o.late && <span className="pill pill--late">Late</span>}
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>{o.partnerName ?? `${o.sourceName} → ${o.destName}`}</div>
                      <div className="kcard__meta">
                        <span>
                          <CalendarBlank size={13} /> {day(o.scheduledDate)}
                        </span>
                        <span>
                          <Stack size={13} /> {qty(o.totalQuantity)} in {o.lineCount} {o.lineCount === 1 ? 'line' : 'lines'}
                        </span>
                        {o.responsibleName && (
                          <span>
                            <User size={13} /> {o.responsibleName}
                          </span>
                        )}
                      </div>
                    </Link>
                  </motion.div>
                ))}
              </AnimatePresence>
              {!cards.length && <div className="kanban__empty">{drag && allowed && drag.status !== col ? 'Drop here' : 'Empty'}</div>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
