import { MapPin, PencilSimple, Plus, Trash, Warehouse as WarehouseIcon } from '@phosphor-icons/react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ConfirmDialog, Dialog } from '../components/Dialog';
import { Button, Empty, ErrorBox, Field, PageHeader, SkeletonRows } from '../components/ui';
import { del, errorMessage, fieldErrors, patch, post } from '../lib/api';
import { int } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import { queryClient, useLocations, useMe, useWarehouses } from '../lib/queries';
import { useToast } from '../lib/toast';
import type { Warehouse } from '../lib/types';

export function ManagerNote() {
  return <div className="note-box" style={{ marginBottom: 16 }}>Only inventory managers can change settings. Ask a manager if something here needs updating.</div>;
}

export default function Warehouses() {
  useDocumentTitle('Warehouses');
  const { data: me } = useMe();
  const canEdit = me?.role === 'manager';
  const { data, error, isLoading, refetch } = useWarehouses();
  const { data: locations = [] } = useLocations();
  const [editing, setEditing] = useState<Warehouse | 'new' | null>(null);
  const [removing, setRemoving] = useState<Warehouse | null>(null);
  const toast = useToast();

  const remove = async () => {
    if (!removing) return;
    try {
      await del(`/warehouses/${removing.id}`);
      await queryClient.invalidateQueries({ queryKey: ['warehouses'] });
      await queryClient.invalidateQueries({ queryKey: ['locations'] });
      toast.success(`${removing.name} deleted`);
    } catch (err) {
      toast.error('Could not delete', errorMessage(err));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Warehouses"
        meta={<span>Each warehouse has a short code used in every reference, like WH/IN/0001.</span>}
        actions={
          canEdit && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus size={17} weight="bold" /> New warehouse
            </Button>
          )
        }
      />
      {!canEdit && <ManagerNote />}
      {error ? (
        <ErrorBox error={error} retry={() => refetch()} />
      ) : isLoading ? (
        <div className="panel">
          <SkeletonRows rows={3} cols={4} />
        </div>
      ) : !data?.length ? (
        <div className="panel">
          <Empty icon={<WarehouseIcon size={38} weight="duotone" />} title="No warehouses yet">
            Create the first one. It starts with a Stock location you can receive into.
          </Empty>
        </div>
      ) : (
        <div className="wh-grid">
          {data.map((w) => (
            <article key={w.id} className="wh-card">
              <div className="wh-card__code">{w.shortCode}</div>
              <div className="wh-card__body">
                <h2>{w.name}</h2>
                <p className="muted">{w.address || 'No address yet'}</p>
                <dl>
                  <div>
                    <dt>Locations</dt>
                    <dd>{w.locationCount}</dd>
                  </div>
                  <div>
                    <dt>Units on hand</dt>
                    <dd>{int(w.unitsOnHand)}</dd>
                  </div>
                  <div>
                    <dt>Open documents</dt>
                    <dd>{w.openOperations}</dd>
                  </div>
                </dl>
                <div className="wh-card__locs">
                  {locations
                    .filter((l) => l.warehouseId === w.id)
                    .map((l) => (
                      <span key={l.id} className="tag">
                        {l.fullName}
                      </span>
                    ))}
                </div>
              </div>
              <footer className="wh-card__foot">
                <Link className="btn btn--quiet btn--sm" to={`/settings/locations?warehouse=${w.id}`}>
                  <MapPin size={15} /> Locations
                </Link>
                {canEdit && (
                  <>
                    <Button size="sm" variant="quiet" onClick={() => setEditing(w)}>
                      <PencilSimple size={15} /> Edit
                    </Button>
                    <Button size="sm" variant="quiet" onClick={() => setRemoving(w)} aria-label={`Delete ${w.name}`}>
                      <Trash size={15} />
                    </Button>
                  </>
                )}
              </footer>
            </article>
          ))}
        </div>
      )}
      <WarehouseDialog key={editing === 'new' ? 'new' : editing?.id ?? 'none'} value={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={remove} title={`Delete ${removing?.name ?? ''}?`} confirmLabel="Delete warehouse">
        Only possible when the warehouse has no stock and no documents. Its empty locations are removed too.
      </ConfirmDialog>
    </div>
  );
}

function WarehouseDialog({ value, onClose }: { value: Warehouse | 'new' | null; onClose: () => void }) {
  const current = value && value !== 'new' ? value : null;
  const [form, setForm] = useState({ name: current?.name ?? '', shortCode: current?.shortCode ?? '', address: current?.address ?? '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = 'Enter a name';
    if (!/^[A-Za-z0-9]{1,8}$/.test(form.shortCode.trim())) errs.shortCode = '1 to 8 letters or numbers';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      if (current) await patch(`/warehouses/${current.id}`, form);
      else await post('/warehouses', form);
      await queryClient.invalidateQueries({ queryKey: ['warehouses'] });
      await queryClient.invalidateQueries({ queryKey: ['locations'] });
      toast.success(current ? 'Warehouse saved' : `${form.shortCode.toUpperCase()} created`, current ? undefined : 'It comes with a Stock location.');
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error('Could not save', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!value}
      onClose={onClose}
      title={current ? 'Edit warehouse' : 'New warehouse'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="wh-form" busy={busy}>
            Save
          </Button>
        </>
      }
    >
      <form id="wh-form" className="form-grid" onSubmit={submit} noValidate>
        <Field label="Name" htmlFor="wh-name" error={errors.name} className="span-2">
          <input id="wh-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Short code" htmlFor="wh-code" error={errors.shortCode} hint="Used in references, e.g. WH/IN/0001">
          <input
            id="wh-code"
            className="input mono"
            maxLength={8}
            value={form.shortCode}
            style={{ textTransform: 'uppercase' }}
            onChange={(e) => setForm({ ...form, shortCode: e.target.value })}
          />
        </Field>
        <Field label="Address" htmlFor="wh-addr" className="span-2">
          <textarea id="wh-addr" className="textarea" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </Field>
      </form>
    </Dialog>
  );
}
