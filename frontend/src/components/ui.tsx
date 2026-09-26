import { CircleNotch, WarningCircle } from '@phosphor-icons/react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { STATUS_LABEL } from '../lib/format';
import type { OpStatus, StockStatus } from '../lib/types';

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d="M12 2l9 5-9 5-9-5z" fill="#ffb224" />
      <path d="M3 7l9 5v10l-9-5z" fill="currentColor" />
      <path d="M21 7l-9 5v10l9-5z" fill="currentColor" opacity=".55" />
    </svg>
  );
}

export function StatusPill({ status, late }: { status: OpStatus; late?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      <span className="pill" data-status={status}>
        {STATUS_LABEL[status]}
      </span>
      {late && <span className="pill pill--late">Late</span>}
    </span>
  );
}

export function StockPill({ status }: { status: StockStatus }) {
  if (status === 'ok') return <span className="pill pill--ok">In stock</span>;
  if (status === 'low') return <span className="pill pill--low">Low</span>;
  return <span className="pill pill--out">Out</span>;
}

export function Button({
  busy,
  children,
  variant = 'ghost',
  size,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  variant?: 'primary' | 'ghost' | 'quiet' | 'dark' | 'danger' | 'in';
  size?: 'xs' | 'sm' | 'lg';
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      aria-busy={busy || undefined}
      className={`btn btn--${variant} ${size ? `btn--${size}` : ''} ${className}`}
    >
      {busy && <CircleNotch size={16} className="spin" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function PageHeader({
  title,
  meta,
  actions,
  back,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-head__text">
        {back}
        <h1 className="page-title">{title}</h1>
        {meta && <div className="page-meta">{meta}</div>}
      </div>
      {actions && <div className="page-head__actions">{actions}</div>}
    </header>
  );
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
  className = '',
}: {
  label: ReactNode;
  htmlFor?: string;
  error?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`field ${className}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? (
        <span className="error" id={htmlFor ? `${htmlFor}-error` : undefined} role="alert">
          <WarningCircle size={14} weight="fill" aria-hidden="true" />
          {error}
        </span>
      ) : hint ? (
        <span className="hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function SkeletonRows({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="skeleton-rows" aria-hidden="true">
      {Array.from({ length: rows }, (_, r) => (
        <div className="skeleton-row" key={r} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {Array.from({ length: cols }, (_, c) => (
            <div className="skeleton" key={c} style={{ height: 14, width: `${55 + ((r * 7 + c * 13) % 40)}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <WarningCircle size={20} weight="fill" aria-hidden="true" />
      <div style={{ flex: 1 }}>
        <b>Could not load this.</b> {error instanceof Error ? error.message : ''}
      </div>
      {retry && (
        <button className="btn btn--ghost btn--xs" type="button" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  );
}

/** Isometric stack of crates, one per open document (capped at 9). Geometry is projected, not drawn by hand. */
const SLOTS: [number, number, number][] = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [2, 0, 0], [2, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1],
];
const A = 22; // crate edge in px
const iso = (x: number, y: number, z: number): [number, number] => [0.866 * A * (x - y), 0.5 * A * (x + y) - A * z];
const pts = (...p: [number, number, number][]) => p.map(([x, y, z]) => iso(x, y, z).map((v) => v.toFixed(1)).join(',')).join(' ');
const ALL = SLOTS.flatMap(([x, y, z]) => [iso(x, y + 1, z), iso(x + 1, y, z), iso(x, y, z + 1), iso(x + 1, y + 1, z)]);
const minX = Math.min(...ALL.map((p) => p[0])) - 2;
const maxX = Math.max(...ALL.map((p) => p[0])) + 2;
const minY = Math.min(...ALL.map((p) => p[1])) - 2;
const maxY = Math.max(...ALL.map((p) => p[1])) + 2;

export function CrateStack({ count, tone = 'neutral' }: { count: number; tone?: 'neutral' | 'in' | 'out' }) {
  const n = Math.min(Math.max(count, 0), SLOTS.length);
  // paint back to front
  const crates = SLOTS.slice(0, n)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c[0] + a.c[1] + a.c[2] - (b.c[0] + b.c[1] + b.c[2]) || a.c[2] - b.c[2]);
  return (
    <svg className="crates" data-tone={tone} viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`} width={maxX - minX} height={maxY - minY} aria-hidden="true">
      <ellipse className="crates__shadow" cx={iso(1.5, 1, 0)[0]} cy={iso(1.5, 1, 0)[1] + 4} rx={A * 2.2} ry={A * 0.7} />
      {crates.map(({ c: [x, y, z], i }) => (
        <g key={i} className="crate" style={{ animationDelay: `${i * 70}ms` }}>
          <polygon className="crate__top" points={pts([x, y, z + 1], [x + 1, y, z + 1], [x + 1, y + 1, z + 1], [x, y + 1, z + 1])} />
          <polygon className="crate__left" points={pts([x, y + 1, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x, y + 1, z + 1])} />
          <polygon className="crate__right" points={pts([x + 1, y, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x + 1, y, z + 1])} />
          <polygon className="crate__tape" points={pts([x + 0.42, y, z + 1], [x + 0.58, y, z + 1], [x + 0.58, y + 1, z + 1], [x + 0.42, y + 1, z + 1])} />
          <polygon className="crate__tape crate__tape--side" points={pts([x + 0.42, y + 1, z], [x + 0.58, y + 1, z], [x + 0.58, y + 1, z + 1], [x + 0.42, y + 1, z + 1])} />
        </g>
      ))}
    </svg>
  );
}
