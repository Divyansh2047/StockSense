import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { dayShort, money, moneyShort } from '../lib/format';

export interface FlowPoint {
  date: string;
  inValue: number;
  outValue: number;
  inMoves: number;
  outMoves: number;
}

/** Round the scale ceiling to a clean number so ticks read 0 / 50K / 1L. */
function niceMax(v: number): number {
  if (v <= 0) return 1000;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * exp;
}

/** Rect with a rounded data-end (top for inbound, bottom for outbound) and a square baseline. */
function bar(x: number, y0: number, w: number, h: number, up: boolean): string {
  if (h <= 0.5) return '';
  const r = Math.min(4, w / 2, h);
  if (up) {
    const top = y0 - h;
    return `M${x},${y0} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${y0} Z`;
  }
  const bot = y0 + h;
  return `M${x},${y0} V${bot - r} Q${x},${bot} ${x + r},${bot} H${x + w - r} Q${x + w},${bot} ${x + w},${bot - r} V${y0} Z`;
}

/**
 * Diverging columns: value received above the baseline, value shipped below it.
 * Direction is encoded by position as well as hue, so it survives colour-vision
 * deficiency and greyscale print.
 */
export function FlowChart({ data, dimmed }: { data: FlowPoint[]; dimmed?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 236;
  const pad = { top: 14, right: 8, bottom: 26, left: 58 };
  const innerW = width - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const mid = pad.top + innerH / 2;

  const max = useMemo(() => niceMax(Math.max(1, ...data.map((d) => Math.max(d.inValue, d.outValue)))), [data]);
  const scale = (v: number) => (v / max) * (innerH / 2);
  const band = innerW / Math.max(data.length, 1);
  const barW = Math.min(24, band * 0.56);
  const ticks = [max, max / 2, 0, -max / 2, -max];
  const todayIdx = data.length - 1;
  const labelEvery = width < 520 ? 3 : 2;

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!data.length) return;
    if (e.key === 'ArrowRight') setActive((a) => Math.min((a ?? -1) + 1, data.length - 1));
    else if (e.key === 'ArrowLeft') setActive((a) => Math.max((a ?? data.length) - 1, 0));
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  };

  const tip = active !== null ? data[active] : undefined;
  const tipX = active !== null ? pad.left + band * active + band / 2 : 0;

  return (
    <div className="flowchart" ref={wrap} style={{ opacity: dimmed ? 0.55 : 1 }}>
      <svg
        width={width}
        height={H}
        role="img"
        aria-label={`Stock value received and shipped over the last ${data.length} days. Use the arrow keys to read each day.`}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        {ticks.map((t) => {
          const y = mid - scale(t);
          return (
            <g key={t}>
              <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} className={t === 0 ? 'fc-base' : 'fc-grid'} />
              <text x={pad.left - 10} y={y} className="fc-tick" textAnchor="end" dominantBaseline="middle">
                {t === 0 ? '0' : `${t > 0 ? '' : '−'}${moneyShort(Math.abs(t))}`}
              </text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const x = pad.left + band * i + (band - barW) / 2;
          const on = active === i;
          return (
            <g key={d.date} className={on ? 'fc-col is-on' : 'fc-col'}>
              {on && <rect x={pad.left + band * i} y={pad.top} width={band} height={innerH} className="fc-hover" />}
              <path d={bar(x, mid - 1, barW, scale(d.inValue), true)} className="fc-in" />
              <path d={bar(x, mid + 1, barW, scale(d.outValue), false)} className="fc-out" />
              {(i % labelEvery === (data.length - 1) % labelEvery || i === todayIdx) && (
                <text x={pad.left + band * i + band / 2} y={H - 8} className="fc-x" textAnchor="middle">
                  {i === todayIdx ? 'Today' : dayShort(d.date)}
                </text>
              )}
              {/* hit target: the whole day column, bigger than the bars */}
              <rect
                x={pad.left + band * i}
                y={pad.top}
                width={band}
                height={innerH}
                fill="transparent"
                onPointerEnter={() => setActive(i)}
                onPointerMove={() => setActive(i)}
              />
            </g>
          );
        })}
      </svg>
      {tip && (
        <div className="fc-tip" style={{ left: Math.min(Math.max(tipX, 110), width - 110) }} role="status">
          <div className="fc-tip__date">{active === todayIdx ? 'Today' : dayShort(tip.date)}</div>
          <div className="fc-tip__row">
            <i className="key key--in" aria-hidden="true" />
            <b>{money(tip.inValue)}</b>
            <span>
              in, {tip.inMoves} {tip.inMoves === 1 ? 'move' : 'moves'}
            </span>
          </div>
          <div className="fc-tip__row">
            <i className="key key--out" aria-hidden="true" />
            <b>{money(tip.outValue)}</b>
            <span>
              out, {tip.outMoves} {tip.outMoves === 1 ? 'move' : 'moves'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function FlowTable({ data }: { data: FlowPoint[] }) {
  return (
    <div className="table-wrap" style={{ maxHeight: 236 }}>
      <table className="table table--compact">
        <caption className="sr-only">Stock value received and shipped per day</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th className="n">Received</th>
            <th className="n">Shipped</th>
            <th className="n">Moves in / out</th>
          </tr>
        </thead>
        <tbody>
          {[...data].reverse().map((d) => (
            <tr key={d.date}>
              <td>{dayShort(d.date)}</td>
              <td className="n">{money(d.inValue)}</td>
              <td className="n">{money(d.outValue)}</td>
              <td className="n">
                {d.inMoves} / {d.outMoves}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
