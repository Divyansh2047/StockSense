import { MapPin, PencilSimple, Plus, Trash } from '@phosphor-icons/react';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog, Dialog } from '../components/Dialog';
import { Button, Empty, ErrorBox, Field, PageHeader, SkeletonRows } from '../components/ui';
import { del, errorMessage, fieldErrors, patch, post } from '../lib/api';
import { int } from '../lib/format';
import { useDocumentTitle, useQueryState } from '../lib/hooks';
import { queryClient, useLocations, useMe, useWarehouses } from '../lib/queries';
import { useToast } from '../lib/toast';
import type { Location } from '../lib/types';
import { ManagerNote } from './Warehouses';

export default function Locations() {
  useDocumentTitle('Locations');
  const { data: me } = useMe();
  const canEdit = me?.role === 'manager';
  const [warehouseId, setWarehouse] = useQueryState('warehouse');
  const { data: warehouses = [] } = useWarehouses();
  const { data, error, isLoading, refetch } = useLocations(warehouseId ? { warehouseId } : {});
  const [editing, setEditing] = useState<Location | 'new' | null>(null);
  const [removing, setRemoving] = useState<Location | null>(null);
  const toast = useToast();

  const remove = async () => {
    if (!removing) return;
    try {
      await del(`/locations/${removing.id}`);
      await queryClient.invalidateQueries({ queryKey: ['locations'] });
      await queryClient.invalidateQueries({ queryKey: ['warehouses'] });
      toast.success(`${removing.fullName} deleted`);
    } catch (err) {
      toast.error('Could not delete', errorMessage(err));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Locations"
        meta={<span>Rooms, racks and bays inside a warehouse. Stock always sits at a location.</span>}
        actions={
          canEdit && (
            <Button variant="primary" onClick={() => setEditing('new')} disabled={!warehouses.length}>
              <Plus size={17} weight="bold" /> New location
            </Button>
          )
        }
      />
      {!canEdit && <ManagerNote />}
      <div className="toolbar">
        <select className="select" aria-label="Warehouse" value={warehouseId} onChange={(e) => setWarehouse(e.target.value)}>
          <option value="">All warehouses</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.shortCode} {w.name}
            </option>
          ))}
        </select>
      </div>
      {error ? (
        <ErrorBox error={error} retry={() => refetch()} />
      ) : (
        <div className="panel">
          {isLoading ? (
            <SkeletonRows rows={4} cols={5} />
          ) : !data?.length ? (
            <Empty icon={<MapPin size={38} weight="duotone" />} title="No locations here">
              Add a room, rack or bay to start storing stock in it.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Full name</th>
                    <th>Name</th>
                    <th>Short code</th>
                    <th>Warehouse</th>
                    <th className="n">Products</th>
                    <th className="n">Units on hand</th>
                    {canEdit && <th className="shrink" aria-label="Actions" />}
                  </tr>
                </thead>
                <tbody>
                  {data.map((l) => (
                    <tr key={l.id}>
                      <td className="ref">{l.fullName}</td>
                      <td>{l.name}</td>
                      <td className="mono">{l.shortCode}</td>
                      <td>{l.warehouseName}</td>
                      <td className="n">{l.productCount}</td>
                      <td className="n">{int(l.unitsOnHand)}</td>
                      {canEdit && (
                        <td className="shrink">
                          <Button size="xs" variant="quiet" onClick={() => setEditing(l)} aria-label={`Edit ${l.fullName}`}>
                            <PencilSimple size={15} />
                          </Button>
                          <Button size="xs" variant="quiet" onClick={() => setRemoving(l)} aria-label={`Delete ${l.fullName}`}>
                            <Trash size={15} />
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      <LocationDialog key={editing === 'new' ? 'new' : editing?.id ?? 'none'} value={editing} defaultWarehouse={warehouseId ? Number(warehouseId) : warehouses[0]?.id} onClose={() => setEditing(null)} />
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={remove} title={`Delete ${removing?.fullName ?? ''}?`} confirmLabel="Delete location">
        Only empty locations with no history can be deleted.
      </ConfirmDialog>
    </div>
  );
}

function LocationDialog({ value, onClose, defaultWarehouse }: { value: Location | 'new' | null; onClose: () => void; defaultWarehouse?: number }) {
  const current = value && value !== 'new' ? value : null;
  const { data: warehouses = [] } = useWarehouses();
  const [form, setForm] = useState({
    name: current?.name ?? '',
    shortCode: current?.shortCode ?? '',
    warehouseId: String(current?.warehouseId ?? defaultWarehouse ?? ''),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const wh = warehouses.find((w) => String(w.id) === form.warehouseId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = 'Enter a name';
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(form.shortCode.trim())) errs.shortCode = 'Up to 16 letters, numbers, dash or underscore';
    if (!form.warehouseId) errs.warehouseId = 'Pick a warehouse';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const body = { ...form, warehouseId: Number(form.warehouseId) };
      if (current) await patch(`/locations/${current.id}`, body);
      else await post('/locations', body);
      await queryClient.invalidateQueries({ queryKey: ['locations'] });
      await queryClient.invalidateQueries({ queryKey: ['warehouses'] });
      toast.success(current ? 'Location saved' : `${wh?.shortCode}/${form.shortCode} created`);
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
      title={current ? 'Edit location' : 'New location'}
      description={wh && form.shortCode ? <span className="mono">{`${wh.shortCode}/${form.shortCode}`}</span> : 'Holds stock inside a warehouse.'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="loc-form" busy={busy}>
            Save
          </Button>
        </>
      }
    >
      <form id="loc-form" className="form-grid" onSubmit={submit} noValidate>
        <Field label="Name" htmlFor="loc-name" error={errors.name} className="span-2">
          <input id="loc-name" className="input" placeholder="Production rack" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Short code" htmlFor="loc-code" error={errors.shortCode}>
          <input id="loc-code" className="input mono" placeholder="Production" value={form.shortCode} onChange={(e) => setForm({ ...form, shortCode: e.target.value })} />
        </Field>
        <Field label="Warehouse" htmlFor="loc-wh" error={errors.warehouseId}>
          <select id="loc-wh" className="select" value={form.warehouseId} onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.shortCode} {w.name}
              </option>
            ))}
          </select>
        </Field>
      </form>
    </Dialog>
  );
}
