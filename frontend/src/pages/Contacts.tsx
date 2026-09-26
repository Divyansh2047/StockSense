import { AddressBook, MagnifyingGlass, PencilSimple, Plus, Trash } from '@phosphor-icons/react';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog, Dialog } from '../components/Dialog';
import { Button, Empty, ErrorBox, Field, PageHeader, SkeletonRows } from '../components/ui';
import { del, errorMessage, fieldErrors, patch, post } from '../lib/api';
import { useDebounced, useDocumentTitle, useQueryState } from '../lib/hooks';
import { queryClient, usePartners } from '../lib/queries';
import { useToast } from '../lib/toast';
import type { Partner } from '../lib/types';

const KIND: Record<Partner['kind'], string> = { vendor: 'Vendor', customer: 'Customer', both: 'Vendor and customer' };

export default function Contacts() {
  useDocumentTitle('Contacts');
  const [search, setSearch] = useQueryState('q');
  const [kind, setKind] = useQueryState('kind');
  const term = useDebounced(search);
  const { data, error, isLoading, refetch } = usePartners({ search: term, kind });
  const [editing, setEditing] = useState<Partner | 'new' | null>(null);
  const [removing, setRemoving] = useState<Partner | null>(null);
  const toast = useToast();

  const remove = async () => {
    if (!removing) return;
    try {
      await del(`/partners/${removing.id}`);
      await queryClient.invalidateQueries({ queryKey: ['partners'] });
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
        title="Contacts"
        meta={<span>Vendors you receive from and customers you deliver to.</span>}
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus size={17} weight="bold" /> New contact
          </Button>
        }
      />
      <div className="toolbar">
        <div className="input-icon grow">
          <MagnifyingGlass size={16} aria-hidden="true" />
          <input className="input" type="search" placeholder="Search name or email" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search contacts" />
        </div>
        <div className="segmented" role="group" aria-label="Kind">
          {[
            ['', 'All'],
            ['vendor', 'Vendors'],
            ['customer', 'Customers'],
          ].map(([k, label]) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k!)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {error ? (
        <ErrorBox error={error} retry={() => refetch()} />
      ) : (
        <div className="panel">
          {isLoading ? (
            <SkeletonRows rows={5} cols={5} />
          ) : !data?.length ? (
            <Empty icon={<AddressBook size={38} weight="duotone" />} title="No contacts found">
              Contacts can also be created straight from a receipt or delivery.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Email</th>
                    <th>Phone</th>
                    <th>Address</th>
                    <th className="n">Documents</th>
                    <th className="shrink" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {data.map((p) => (
                    <tr key={p.id}>
                      <td className="cell-main">{p.name}</td>
                      <td>
                        <span className="tag">{KIND[p.kind]}</span>
                      </td>
                      <td>{p.email ? <a href={`mailto:${p.email}`}>{p.email}</a> : <span className="muted">None</span>}</td>
                      <td className="mono" style={{ fontSize: 13 }}>
                        {p.phone}
                      </td>
                      <td className="muted" style={{ fontSize: 13 }}>
                        {p.address}
                      </td>
                      <td className="n">{p.operationCount ?? 0}</td>
                      <td className="shrink">
                        <Button size="xs" variant="quiet" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}>
                          <PencilSimple size={15} />
                        </Button>
                        <Button size="xs" variant="quiet" onClick={() => setRemoving(p)} aria-label={`Delete ${p.name}`}>
                          <Trash size={15} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      <PartnerDialog key={editing === 'new' ? 'new' : editing?.id ?? 'none'} value={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={remove} title={`Delete ${removing?.name ?? ''}?`} confirmLabel="Delete contact">
        Contacts that appear on documents cannot be deleted.
      </ConfirmDialog>
    </div>
  );
}

function PartnerDialog({ value, onClose }: { value: Partner | 'new' | null; onClose: () => void }) {
  const current = value && value !== 'new' ? value : null;
  const [form, setForm] = useState({
    name: current?.name ?? '',
    kind: current?.kind ?? 'both',
    email: current?.email ?? '',
    phone: current?.phone ?? '',
    address: current?.address ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return setErrors({ name: 'Enter a name' });
    setBusy(true);
    try {
      if (current) await patch(`/partners/${current.id}`, form);
      else await post('/partners', form);
      await queryClient.invalidateQueries({ queryKey: ['partners'] });
      toast.success(current ? 'Contact saved' : `${form.name} added`);
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
      title={current ? 'Edit contact' : 'New contact'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="partner-form" busy={busy}>
            Save
          </Button>
        </>
      }
    >
      <form id="partner-form" className="form-grid" onSubmit={submit} noValidate>
        <Field label="Name" htmlFor="pa-name" error={errors.name}>
          <input id="pa-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Type" htmlFor="pa-kind">
          <select id="pa-kind" className="select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Partner['kind'] })}>
            <option value="vendor">Vendor</option>
            <option value="customer">Customer</option>
            <option value="both">Vendor and customer</option>
          </select>
        </Field>
        <Field label="Email" htmlFor="pa-email" error={errors.email}>
          <input id="pa-email" type="email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Phone" htmlFor="pa-phone">
          <input id="pa-phone" className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="Address" htmlFor="pa-addr" className="span-2" hint="Deliveries to this contact start with this address.">
          <textarea id="pa-addr" className="textarea" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </Field>
      </form>
    </Dialog>
  );
}
