import { ArrowDownLeft, ArrowUpRight, ArrowsLeftRight, ClockCounterClockwise, Kanban, ListBullets, MagnifyingGlass, X } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Empty, ErrorBox, PageHeader, SkeletonRows, StatusPill } from '../components/ui';
import { dateTime, day, qty, STATUS_LABEL, TYPE_LABEL, TYPE_PATH, uom } from '../lib/format';
import { useDebounced, useDocumentTitle, useQueryState } from '../lib/hooks';
import { useMoves, useProduct } from '../lib/queries';
import type { Move, OpStatus } from '../lib/types';

const DIR_ICON = { in: ArrowDownLeft, out: ArrowUpRight, internal: ArrowsLeftRight };

export default function Moves() {
  useDocumentTitle('Move history');
  const [view, setView] = useQueryState('view', 'list');
  const [search, setSearch] = useQueryState('q');
  const [direction, setDirection] = useQueryState('dir');
  const [kind, setKind] = useQueryState('kind');
  const [from, setFrom] = useQueryState('from');
  const [to, setTo] = useQueryState('to');
  const [productId, setProduct] = useQueryState('product');
  const [limit, setLimit] = useState(100);
  const term = useDebounced(search);
  const { data, error, isLoading, isFetching, refetch } = useMoves({ search: term, direction, kind, from, to, productId, limit });
  const product = useProduct(productId ? Number(productId) : undefined);

  return (
    <div>
      <PageHeader
        title="Move history"
        meta={
          <span>
            Every product line of every document. Done rows come straight from the stock ledger.{' '}
            {data ? <b className="mono">{data.total} rows</b> : null}
          </span>
        }
      />
      <div className="toolbar">
        <div className="input-icon grow">
          <MagnifyingGlass size={16} aria-hidden="true" />
          <input className="input" type="search" placeholder="Search reference or contact" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search reference or contact" />
        </div>
        <select className="select" aria-label="Document type" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All types</option>
          <option value="receipt">Receipts</option>
          <option value="delivery">Deliveries</option>
          <option value="internal">Transfers</option>
          <option value="adjustment">Adjustments</option>
        </select>
        <label className="date-range">
          <span className="sr-only">From date</span>
          <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
          <span aria-hidden="true">→</span>
          <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
        </label>
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
      <div className="chips" role="group" aria-label="Direction" style={{ marginBottom: 14 }}>
        {[
          ['', 'All moves'],
          ['in', 'In'],
          ['out', 'Out'],
          ['internal', 'Internal'],
        ].map(([k, label]) => (
          <button key={k} type="button" className="chip" aria-pressed={direction === k} onClick={() => setDirection(k!)}>
            {k === 'in' && <ArrowDownLeft size={14} />}
            {k === 'out' && <ArrowUpRight size={14} />}
            {k === 'internal' && <ArrowsLeftRight size={14} />}
            {label}
          </button>
        ))}
        {productId && (
          <button type="button" className="chip" aria-pressed="true" onClick={() => setProduct('')}>
            {product.data ? product.data.name : 'Product'} <X size={13} />
          </button>
        )}
      </div>

      {error ? (
        <ErrorBox error={error} retry={() => refetch()} />
      ) : isLoading ? (
        <div className="panel">
          <SkeletonRows cols={7} />
        </div>
      ) : !data?.items.length ? (
        <div className="panel">
          <Empty icon={<ClockCounterClockwise size={38} weight="duotone" />} title="No moves match">
            Try another search, direction or date range.
          </Empty>
        </div>
      ) : view === 'kanban' ? (
        <MovesKanban items={data.items} />
      ) : (
        <div className="panel" style={{ opacity: isFetching ? 0.75 : 1, transition: 'opacity .2s' }}>
          <div className="table-wrap has-mcards">
            <table className="table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Date</th>
                  <th>Product</th>
                  <th>Contact</th>
                  <th>From</th>
                  <th>To</th>
                  <th className="n">Quantity</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((m) => (
                  <MoveRow key={m.key} m={m} />
                ))}
              </tbody>
            </table>
            <ul className="mcards" aria-label="Moves">
              {data.items.map((m) => (
                <li key={m.key}>
                  <Link to={m.operationId ? `${TYPE_PATH[m.kind]}/${m.operationId}` : '/moves'} className="mcard" data-dir={m.direction}>
                    <span className="mcard__top">
                      <b className="mono">{m.reference}</b>
                      <b className={m.direction === 'in' ? 'c-in' : m.direction === 'out' ? 'c-out' : ''} style={{ font: '800 20px/1 var(--font-display)' }}>
                        {m.status === 'done' ? (m.direction === 'in' ? '+' : m.direction === 'out' ? '−' : '') : ''}
                        {qty(m.quantity)} {uom(m.uom)}
                      </b>
                    </span>
                    <span className="mcard__title">{m.productName}</span>
                    <span className="mcard__meta">
                      <span className="mono">
                        {m.fromName} → {m.toName}
                      </span>
                      <span>{m.status === 'done' ? dateTime(m.date) : day(m.date)}</span>
                      <StatusPill status={m.status} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          {data.total > data.items.length && (
            <div className="panel__foot" style={{ textAlign: 'center' }}>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setLimit((l) => l + 100)} disabled={isFetching}>
                Show more ({data.total - data.items.length} left)
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MoveRow({ m }: { m: Move }) {
  const Icon = DIR_ICON[m.direction];
  const sign = m.status === 'done' ? (m.direction === 'in' ? '+' : m.direction === 'out' ? '−' : '') : '';
  const link = m.operationId ? `${TYPE_PATH[m.kind]}/${m.operationId}` : undefined;
  return (
    <tr data-dir={m.direction} className={m.status === 'canceled' ? 'is-canceled' : ''}>
      <td className="ref">
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <Icon size={15} className={m.direction === 'in' ? 'c-in' : m.direction === 'out' ? 'c-out' : 'c-accent'} aria-label={m.direction === 'in' ? 'In' : m.direction === 'out' ? 'Out' : 'Internal'} />
          {link ? <Link to={link}>{m.reference}</Link> : m.reference}
        </span>
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>{m.status === 'done' ? dateTime(m.date) : day(m.date)}</td>
      <td>
        <Link to={`/products/${m.productId}`} className="cell-main" style={{ textDecoration: 'none' }}>
          {m.productName}
        </Link>
        <span className="cell-sub">{m.sku}</span>
      </td>
      <td>{m.partnerName ?? <span className="muted">{TYPE_LABEL[m.kind]}</span>}</td>
      <td className="mono" style={{ fontSize: 13 }}>
        {m.fromName}
      </td>
      <td className="mono" style={{ fontSize: 13 }}>
        {m.toName}
      </td>
      <td className="n qty">
        {m.kind === 'adjustment' && m.status !== 'done' ? 'count ' : sign}
        {qty(m.quantity)} <span className="muted">{uom(m.uom)}</span>
      </td>
      <td>
        <StatusPill status={m.status} />
      </td>
    </tr>
  );
}

function MovesKanban({ items }: { items: Move[] }) {
  const cols: OpStatus[] = ['draft', 'waiting', 'ready', 'done', 'canceled'];
  const grouped = useMemo(() => Object.fromEntries(cols.map((c) => [c, items.filter((m) => m.status === c)])), [items]);
  return (
    <div className="kanban">
      {cols.map((c) => (
        <section key={c} className="kanban__col" aria-label={`${STATUS_LABEL[c]}, ${grouped[c]!.length} moves`}>
          <header className="kanban__head">
            <h3>
              <span className="pill" data-status={c}>
                {STATUS_LABEL[c]}
              </span>
            </h3>
            <span className="badge">{grouped[c]!.length}</span>
          </header>
          <div className="kanban__cards">
            {grouped[c]!.slice(0, 40).map((m) => (
              <Link key={m.key} to={m.operationId ? `${TYPE_PATH[m.kind]}/${m.operationId}` : '/moves'} className="kcard" data-dir={m.direction} draggable={false} style={{ cursor: 'pointer' }}>
                <div className="kcard__top">
                  <span className="kcard__ref">{m.reference}</span>
                  <b className={m.direction === 'in' ? 'c-in' : m.direction === 'out' ? 'c-out' : ''} style={{ font: '800 18px/1 var(--font-display)' }}>
                    {m.direction === 'in' ? '+' : m.direction === 'out' ? '−' : ''}
                    {qty(m.quantity)} {uom(m.uom)}
                  </b>
                </div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{m.productName}</div>
                <div className="kcard__meta">
                  <span className="mono">
                    {m.fromName} → {m.toName}
                  </span>
                  <span>{day(m.date)}</span>
                </div>
              </Link>
            ))}
            {!grouped[c]!.length && <div className="kanban__empty">Empty</div>}
          </div>
        </section>
      ))}
    </div>
  );
}
