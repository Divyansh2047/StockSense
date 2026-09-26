import { Printer } from '@phosphor-icons/react';
import { useEffect } from 'react';
import { useParams } from 'react-router';
import { Logo } from '../components/ui';
import { dateTime, day, qty, STATUS_LABEL, TYPE_LABEL, uom } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import { useOperation } from '../lib/queries';

/** A clean A4 document for the paper trail. Opens the print dialog on its own. */
export default function OperationPrint() {
  const { id } = useParams();
  const { data: op, error } = useOperation(Number(id));
  useDocumentTitle(op ? `${op.reference} (print)` : 'Print');

  useEffect(() => {
    if (!op) return;
    const t = window.setTimeout(() => window.print(), 400);
    return () => window.clearTimeout(t);
  }, [op]);

  if (error) return <p style={{ padding: 32 }}>Could not load this document.</p>;
  if (!op) return <p style={{ padding: 32 }}>Preparing document…</p>;

  const total = op.lines.reduce((a, l) => a + l.quantity, 0);
  return (
    <div className="print">
      <button type="button" className="btn btn--primary print__btn" onClick={() => window.print()}>
        <Printer size={17} /> Print
      </button>
      <header className="print__head">
        <div className="print__brand">
          <Logo size={30} />
          <span>StockSense</span>
        </div>
        <div className="print__doc">
          <span>{TYPE_LABEL[op.type]}</span>
          <b>{op.reference}</b>
          <em>{STATUS_LABEL[op.status]}</em>
        </div>
      </header>

      <dl className="print__meta">
        {op.partnerName && (
          <div>
            <dt>{op.type === 'receipt' ? 'Received from' : 'Delivered to'}</dt>
            <dd>{op.partnerName}</dd>
          </div>
        )}
        <div>
          <dt>From</dt>
          <dd>{op.sourceName}</dd>
        </div>
        <div>
          <dt>To</dt>
          <dd>{op.destName}</dd>
        </div>
        <div>
          <dt>Scheduled</dt>
          <dd>{day(op.scheduledDate)}</dd>
        </div>
        {op.validatedAt && (
          <div>
            <dt>Validated</dt>
            <dd>
              {dateTime(op.validatedAt)}
              {op.validatedByName ? `, ${op.validatedByName}` : ''}
            </dd>
          </div>
        )}
        {op.responsibleName && (
          <div>
            <dt>Responsible</dt>
            <dd>{op.responsibleName}</dd>
          </div>
        )}
        {op.deliveryAddress && (
          <div className="wide">
            <dt>Delivery address</dt>
            <dd>{op.deliveryAddress}</dd>
          </div>
        )}
      </dl>

      <table className="print__table">
        <thead>
          <tr>
            <th>#</th>
            <th>SKU</th>
            <th>Product</th>
            {op.type === 'adjustment' && <th className="n">Recorded</th>}
            <th className="n">{op.type === 'adjustment' ? 'Counted' : 'Quantity'}</th>
            <th>Unit</th>
          </tr>
        </thead>
        <tbody>
          {op.lines.map((l, i) => (
            <tr key={l.id}>
              <td>{i + 1}</td>
              <td className="mono">{l.sku}</td>
              <td>{l.productName}</td>
              {op.type === 'adjustment' && <td className="n">{qty(l.systemQuantity ?? 0)}</td>}
              <td className="n">{qty(l.quantity)}</td>
              <td>{uom(l.uom)}</td>
            </tr>
          ))}
        </tbody>
        {op.type !== 'adjustment' && (
          <tfoot>
            <tr>
              <td colSpan={3}>Total</td>
              <td className="n">{qty(total)}</td>
              <td />
            </tr>
          </tfoot>
        )}
      </table>

      {op.notes && <p className="print__notes">Notes: {op.notes}</p>}

      <footer className="print__sign">
        <div>
          <span />
          Prepared by
        </div>
        <div>
          <span />
          {op.type === 'receipt' ? 'Received by' : op.type === 'delivery' ? 'Received by customer' : 'Checked by'}
        </div>
      </footer>
      <p className="print__foot">
        Printed {new Date().toLocaleString('en-IN')} from StockSense. Every move on this document is recorded in the stock ledger under {op.reference}.
      </p>
    </div>
  );
}
