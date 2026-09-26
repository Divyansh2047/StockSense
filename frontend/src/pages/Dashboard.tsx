import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  ArrowsLeftRight,
  ChartBar,
  CheckCircle,
  ClockCounterClockwise,
  Package,
  Plus,
  Table,
  Warning,
} from '@phosphor-icons/react';
import { motion, useReducedMotion } from 'motion/react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { FlowChart, FlowTable } from '../components/FlowChart';
import { Combobox } from '../components/Combobox';
import { Dialog } from '../components/Dialog';
import { CrateStack, Empty, ErrorBox, Field, StatusPill, Button } from '../components/ui';
import { errorMessage, post } from '../lib/api';
import { day, int, money, qtyUom, relative, TYPE_LABEL, TYPE_PATH, uom } from '../lib/format';
import { useDocumentTitle, useQueryState } from '../lib/hooks';
import { invalidateInventory, useCategories, useDashboard, useLocations, useMe, usePartners, useWarehouses } from '../lib/queries';
import { useToast } from '../lib/toast';
import type { CardStats, Dashboard as DashboardData, OpType } from '../lib/types';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/* ------------------------------------------------------------------ dock cards (from the mockup) */
function DockCard({ type, stats, big }: { type: OpType; stats: CardStats | undefined; big?: boolean }) {
  const path = TYPE_PATH[type];
  const verb = type === 'receipt' ? 'to receive' : type === 'delivery' ? 'to deliver' : 'to move';
  const icon = type === 'receipt' ? <ArrowDownLeft size={22} /> : type === 'delivery' ? <ArrowUpRight size={22} /> : <ArrowsLeftRight size={22} />;
  const s = stats ?? { pending: 0, ready: 0, waiting: 0, late: 0, upcoming: 0, today: 0 };
  const tone = type === 'receipt' ? 'in' : type === 'delivery' ? 'out' : 'neutral';
  return (
    <section className={`dock ${big ? 'dock--big' : ''}`} data-type={type} aria-labelledby={`dock-${type}`}>
      <header className="dock__head">
        <h2 id={`dock-${type}`}>
          {icon}
          {type === 'internal' ? 'Transfers' : type === 'receipt' ? 'Receipts' : 'Deliveries'}
        </h2>
        <Link to={path} className="dock__all">
          All <ArrowRight size={14} />
        </Link>
      </header>
      <div className="dock__body">
        <div className="dock__main">
          <Link className="dock__cta" to={`${path}?status=ready`}>
            <span className="dock__n">{s.ready}</span>
            <span className="dock__verb">{verb}</span>
          </Link>
          <dl className="dock__stats">
            <Link to={`${path}?status=late`} className={s.late ? 'is-alert' : ''} title="Scheduled date is before today">
              <dt>Late</dt>
              <dd>{s.late}</dd>
            </Link>
            {type !== 'receipt' && (
              <Link to={`${path}?status=waiting`} className={s.waiting ? 'is-warn' : ''} title="Waiting for stock">
                <dt>Waiting</dt>
                <dd>{s.waiting}</dd>
              </Link>
            )}
            <Link to={path} title="Scheduled after today">
              <dt>Upcoming</dt>
              <dd>{s.upcoming}</dd>
            </Link>
          </dl>
        </div>
        {big && (
          <div className="dock__visual">
            <CrateStack count={s.pending} tone={tone} />
            <span className="dock__caption">{s.pending} open</span>
          </div>
        )}
      </div>
    </section>
  );
}

function Kpi({ label, value, sub, tone, to }: { label: string; value: string; sub?: string; tone?: 'alert' | 'warn'; to?: string }) {
  const body = (
    <>
      <span className="kpi__label">{label}</span>
      <span className="kpi__value" data-tone={tone}>
        {value}
      </span>
      {sub && <span className="kpi__sub">{sub}</span>}
    </>
  );
  return to ? (
    <Link to={to} className="kpi kpi--link">
      {body}
    </Link>
  ) : (
    <div className="kpi">{body}</div>
  );
}

/* ------------------------------------------------------------------ replenish from a reorder rule */
function ReplenishDialog({ item, onClose }: { item: DashboardData['lowStock'][number] | null; onClose: () => void }) {
  const { data: locations = [] } = useLocations();
  const { data: vendors = [] } = usePartners({ kind: 'vendor' });
  const toast = useToast();
  const navigate = useNavigate();
  const suggested = item ? Math.max((item.reorderMax || item.reorderMin * 2) - item.onHand - item.incoming, 1) : 1;
  const [qty, setQty] = useState<string>('');
  const [locationId, setLocationId] = useState<number | null>(null);
  const [partnerId, setPartnerId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const loc = locationId ?? locations[0]?.id ?? null;

  const submit = async () => {
    if (!item || !loc) return;
    setBusy(true);
    try {
      const res = await post<{ id: number }>(`/products/${item.id}/replenish`, {
        locationId: loc,
        partnerId,
        quantity: Number(qty || suggested),
      });
      await invalidateInventory();
      toast.success('Draft receipt created', `${item.name}: ${qtyUom(Number(qty || suggested), item.uom)}`);
      onClose();
      navigate(`/receipts/${res.id}`);
    } catch (err) {
      toast.error('Could not create the receipt', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!item}
      onClose={onClose}
      title="Replenish"
      description={item ? `${item.name} is at ${qtyUom(item.onHand, item.uom)}, reorder point ${qtyUom(item.reorderMin, item.uom)}.` : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} busy={busy} disabled={!loc}>
            Create draft receipt
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Quantity" htmlFor="rp-qty" hint={`Suggested ${int(suggested)} to reach the max`}>
          <div className="input-group">
            <input id="rp-qty" className="input mono" inputMode="decimal" placeholder={String(suggested)} value={qty} onChange={(e) => setQty(e.target.value)} />
            <span className="addon">{item ? uom(item.uom) : ''}</span>
          </div>
        </Field>
        <Field label="Receive into" htmlFor="rp-loc">
          <select id="rp-loc" className="select" value={loc ?? ''} onChange={(e) => setLocationId(Number(e.target.value))}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.fullName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Vendor (optional)" htmlFor="rp-vendor" className="span-2">
          <Combobox id="rp-vendor" options={vendors.map((v) => ({ value: v.id, label: v.name }))} value={partnerId} onChange={setPartnerId} placeholder="Pick a vendor" />
        </Field>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ page */
export default function Dashboard() {
  useDocumentTitle('Dashboard');
  const { data: me } = useMe();
  const reduce = useReducedMotion();
  const [warehouseId, setWarehouse] = useQueryState('warehouse');
  const [locationId, setLocation] = useQueryState('location');
  const [categoryId, setCategory] = useQueryState('category');
  const [type, setType] = useQueryState('type');
  const [status, setStatus] = useQueryState('status');
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [replenish, setReplenish] = useState<DashboardData['lowStock'][number] | null>(null);

  const filters = { warehouseId, locationId, categoryId, type, status };
  const { data, error, isLoading, isFetching, refetch } = useDashboard(filters);
  const { data: warehouses = [] } = useWarehouses();
  const { data: locations = [] } = useLocations(warehouseId ? { warehouseId } : {});
  const { data: categories = [] } = useCategories();
  const active = [warehouseId, locationId, categoryId, type, status].filter(Boolean).length;

  const flowTotals = useMemo(() => {
    const m = data?.movement ?? [];
    return { in: m.reduce((a, d) => a + d.inValue, 0), out: m.reduce((a, d) => a + d.outValue, 0) };
  }, [data]);

  const enter = (i: number) =>
    reduce ? {} : { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.5, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] as const } };

  const k = data?.kpis;
  return (
    <div className="dash">
      <header className="dash__head">
        <div>
          <p className="dash__hello">
            {greeting()}, {me?.name.split(' ')[0]}
          </p>
          <h1 className="page-title">Today on the floor</h1>
        </div>
        <div className="page-head__actions">
          <Link className="btn btn--ghost" to="/deliveries/new">
            <ArrowUpRight size={17} /> New delivery
          </Link>
          <Link className="btn btn--primary" to="/receipts/new">
            <Plus size={17} weight="bold" /> New receipt
          </Link>
        </div>
      </header>

      {/* one filter row, scoping everything below it */}
      <div className="filters" role="group" aria-label="Dashboard filters">
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
        <select className="select" aria-label="Product category" value={categoryId} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select className="select" aria-label="Document type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All documents</option>
          <option value="receipt">Receipts</option>
          <option value="delivery">Deliveries</option>
          <option value="internal">Internal transfers</option>
          <option value="adjustment">Adjustments</option>
        </select>
        <select className="select" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Open (any status)</option>
          <option value="draft">Draft</option>
          <option value="waiting">Waiting</option>
          <option value="ready">Ready</option>
          <option value="late">Late</option>
          <option value="done">Done</option>
          <option value="canceled">Canceled</option>
        </select>
        {active > 0 && (
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            onClick={() => {
              setWarehouse('');
              setLocation('');
              setCategory('');
              setType('');
              setStatus('');
            }}
          >
            Clear {active}
          </button>
        )}
      </div>

      {error && <ErrorBox error={error} retry={() => refetch()} />}

      <div className={`dash__grid ${isFetching && !isLoading ? 'is-refreshing' : ''}`}>
        <motion.div className="dash__docks" {...enter(0)}>
          <DockCard type="receipt" stats={data?.cards.receipt} big />
          <DockCard type="delivery" stats={data?.cards.delivery} big />
          <DockCard type="internal" stats={data?.cards.internal} />
        </motion.div>

        <motion.div className="kpis" {...enter(1)} aria-busy={isLoading}>
          <Kpi label="Products in stock" value={k ? int(k.productsInStock) : '0'} sub={k ? `of ${k.productCount} in the catalog` : ''} to="/stock?stock=in" />
          <Kpi label="Low stock" value={k ? int(k.lowStock) : '0'} sub="At or under reorder point" tone={k?.lowStock ? 'warn' : undefined} to="/stock?stock=low" />
          <Kpi label="Out of stock" value={k ? int(k.outOfStock) : '0'} sub="Nothing left on hand" tone={k?.outOfStock ? 'alert' : undefined} to="/stock?stock=out" />
          <Kpi label="Stock value" value={k ? money(k.stockValue) : '0'} sub="On hand at unit cost" />
          <Kpi label="Reserved" value={k ? int(k.unitsReserved) : '0'} sub="Held for ready orders" />
        </motion.div>

        <motion.section className="panel dash__flow" {...enter(2)} aria-labelledby="flow-title">
          <div className="panel__head">
            <div>
              <h2 id="flow-title">Stock value moved</h2>
              <div className="sub">
                Last 14 days, at unit cost. {money(flowTotals.in)} received, {money(flowTotals.out)} shipped.
              </div>
            </div>
            <div className="flow-legend">
              <span>
                <i className="key key--in" aria-hidden="true" /> Received
              </span>
              <span>
                <i className="key key--out" aria-hidden="true" /> Shipped
              </span>
              <div className="segmented" role="group" aria-label="View">
                <button type="button" aria-pressed={view === 'chart'} onClick={() => setView('chart')} aria-label="Chart view">
                  <ChartBar size={15} />
                </button>
                <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')} aria-label="Table view">
                  <Table size={15} />
                </button>
              </div>
            </div>
          </div>
          <div className="panel__body">
            {view === 'chart' ? <FlowChart data={data?.movement ?? []} dimmed={isFetching && !isLoading} /> : <FlowTable data={data?.movement ?? []} />}
          </div>
        </motion.section>

        <motion.section className="panel dash__low" {...enter(3)} aria-labelledby="low-title">
          <div className="panel__head">
            <div>
              <h2 id="low-title">Needs reordering</h2>
              <div className="sub">At or below the reorder point</div>
            </div>
            <Link to="/stock?stock=low" className="btn btn--quiet btn--xs">
              Stock <ArrowRight size={13} />
            </Link>
          </div>
          {data && !data.lowStock.length ? (
            <Empty icon={<CheckCircle size={34} weight="duotone" />} title="Everything is above its minimum">
              Set reorder points on products to get warned before a shelf runs dry.
            </Empty>
          ) : (
            <ul className="lowlist">
              {(data?.lowStock ?? []).map((p) => {
                const pct = p.reorderMin > 0 ? Math.min(1, p.onHand / p.reorderMin) : 0;
                return (
                  <li key={p.id} className="lowitem" data-out={p.onHand <= 0}>
                    <Link to={`/products/${p.id}`} className="lowitem__name">
                      <b>{p.name}</b>
                      <span className="mono">{p.sku}</span>
                    </Link>
                    <div className="lowitem__level" aria-label={`${qtyUom(p.onHand, p.uom)} on hand of ${qtyUom(p.reorderMin, p.uom)} minimum`}>
                      <span className="lowitem__qty">
                        {p.onHand <= 0 ? <Warning size={14} weight="fill" aria-hidden="true" /> : null}
                        {qtyUom(p.onHand, p.uom)}
                      </span>
                      <span className="lowitem__meter" aria-hidden="true">
                        <span style={{ width: `${Math.max(pct * 100, 3)}%` }} />
                      </span>
                      <span className="lowitem__min">min {qtyUom(p.reorderMin, p.uom)}</span>
                    </div>
                    {p.incoming > 0 ? (
                      <span className="tag" title="Already on an open receipt">
                        +{qtyUom(p.incoming, p.uom)} due
                      </span>
                    ) : (
                      <button type="button" className="btn btn--ghost btn--xs" onClick={() => setReplenish(p)}>
                        Replenish
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </motion.section>

        <motion.section className="panel dash__ops" {...enter(4)} aria-labelledby="ops-title">
          <div className="panel__head">
            <div>
              <h2 id="ops-title">{type ? `${TYPE_LABEL[type as OpType]}s` : 'Open documents'}</h2>
              <div className="sub">{status ? `Status: ${status}` : 'Draft, waiting and ready'}, scoped by the filters above</div>
            </div>
          </div>
          {data && !data.operations.length ? (
            <Empty icon={<Package size={34} weight="duotone" />} title="Nothing matches these filters">
              Change the filters or create a document.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="table table--compact">
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Contact</th>
                    <th>From → To</th>
                    <th>Scheduled</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.operations ?? []).map((o) => (
                    <OpRow key={o.id} o={o} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </motion.section>

        <motion.section className="panel dash__feed" {...enter(5)} aria-labelledby="feed-title">
          <div className="panel__head">
            <div>
              <h2 id="feed-title">Latest moves</h2>
              <div className="sub">Straight from the stock ledger</div>
            </div>
            <Link to="/moves" className="btn btn--quiet btn--xs">
              <ClockCounterClockwise size={14} /> History
            </Link>
          </div>
          <ol className="feed">
            {(data?.recentMoves ?? []).map((m) => (
              <li key={m.id} className="feed__item" data-dir={m.direction}>
                <span className="feed__dir" aria-hidden="true">
                  {m.direction === 'in' ? <ArrowDownLeft size={15} /> : m.direction === 'out' ? <ArrowUpRight size={15} /> : <ArrowsLeftRight size={15} />}
                </span>
                <span className="feed__main">
                  <b className="mono">{m.reference}</b>
                  <span>
                    {m.productName}, {m.fromName} → {m.toName}
                  </span>
                </span>
                <span className="feed__qty">
                  <b>
                    {m.direction === 'in' ? '+' : m.direction === 'out' ? '−' : ''}
                    {qtyUom(m.quantity, m.uom)}
                  </b>
                  <span>{relative(m.date)}</span>
                </span>
              </li>
            ))}
          </ol>
        </motion.section>
      </div>

      <ReplenishDialog key={replenish?.id ?? 0} item={replenish} onClose={() => setReplenish(null)} />
    </div>
  );
}

function OpRow({ o }: { o: DashboardData['operations'][number] }) {
  const navigate = useNavigate();
  const to = `${TYPE_PATH[o.type]}/${o.id}`;
  const dir = o.type === 'receipt' ? 'in' : o.type === 'delivery' ? 'out' : 'internal';
  return (
    <tr className="is-link" data-dir={dir} onClick={() => navigate(to)}>
      <td className="ref">
        <Link to={to} onClick={(e) => e.stopPropagation()}>
          {o.reference}
        </Link>
      </td>
      <td>{o.partnerName ?? <span className="muted">No contact</span>}</td>
      <td className="mono" style={{ fontSize: 12.5 }}>
        {o.sourceName} → {o.destName}
      </td>
      <td>{day(o.scheduledDate)}</td>
      <td>
        <StatusPill status={o.status} late={o.late} />
      </td>
    </tr>
  );
}
