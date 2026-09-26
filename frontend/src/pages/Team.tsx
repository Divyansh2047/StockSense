import { EnvelopeSimple, PaperPlaneTilt, UserPlus, UsersThree } from '@phosphor-icons/react';
import { useState, type FormEvent } from 'react';
import { Dialog } from '../components/Dialog';
import { Button, Empty, ErrorBox, Field, PageHeader, SkeletonRows } from '../components/ui';
import { errorMessage, fieldErrors, patch, post } from '../lib/api';
import { dateTime, initials } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import { queryClient, useMe, useTeam } from '../lib/queries';
import { useToast } from '../lib/toast';
import type { Role } from '../lib/types';

export default function Team() {
  useDocumentTitle('Team');
  const { data: me } = useMe();
  const { data, error, isLoading, refetch } = useTeam();
  const toast = useToast();
  const canEdit = me?.role === 'manager';
  const [inviting, setInviting] = useState(false);

  const setRole = async (id: number, role: Role, name: string) => {
    try {
      await patch(`/users/${id}/role`, { role });
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.success(`${name} is now ${role === 'manager' ? 'an inventory manager' : 'warehouse staff'}`);
    } catch (err) {
      toast.error('Could not change the role', errorMessage(err));
    }
  };

  const resend = async (id: number, email: string) => {
    try {
      const res = await post<{ sent: boolean; devLink?: string }>(`/users/${id}/invite`);
      if (res.sent) toast.success('Invitation sent again', `A fresh link went to ${email}.`);
      else toast.error('Could not send the email', 'The mail service did not accept it. Try again in a minute.');
    } catch (err) {
      toast.error('Could not resend', errorMessage(err));
    }
  };

  return (
    <div style={{ maxWidth: 980 }}>
      <PageHeader
        title="Team"
        meta={<span>Managers run settings and the catalog. Staff receive, pick, ship, transfer and count.</span>}
        actions={
          canEdit && (
            <Button variant="primary" onClick={() => setInviting(true)}>
              <UserPlus size={17} /> Invite teammate
            </Button>
          )
        }
      />
      {error ? (
        <ErrorBox error={error} retry={() => refetch()} />
      ) : (
        <div className="panel">
          {isLoading ? (
            <SkeletonRows rows={3} cols={4} />
          ) : !data?.length ? (
            <Empty icon={<UsersThree size={38} weight="duotone" />} title="Just you so far">
              Invite teammates and they will appear here.
            </Empty>
          ) : (
            <ul className="team">
              {data.map((u) => (
                <li key={u.id}>
                  <span className="avatar" aria-hidden="true">
                    {initials(u.name)}
                  </span>
                  <div className="team__who">
                    <b>
                      {u.name}
                      {u.id === me?.id ? ' (you)' : ''}
                    </b>
                    <span className="mono">
                      {u.loginId}  {u.email}
                    </span>
                  </div>
                  {u.emailVerified ? (
                    <span className="muted team__since">Joined {dateTime(u.createdAt)}</span>
                  ) : (
                    <span className="team__status">
                      <span className="tag tag--warn">Invited</span>
                      {canEdit && (
                        <button type="button" className="btn btn--quiet btn--xs" onClick={() => resend(u.id, u.email)}>
                          <PaperPlaneTilt size={14} /> Resend
                        </button>
                      )}
                    </span>
                  )}
                  {canEdit && u.id !== me?.id ? (
                    <select className="select" value={u.role} aria-label={`Role for ${u.name}`} onChange={(e) => setRole(u.id, e.target.value as Role, u.name)}>
                      <option value="manager">Inventory manager</option>
                      <option value="staff">Warehouse staff</option>
                    </select>
                  ) : (
                    <span className="tag">{u.role === 'manager' ? 'Inventory manager' : 'Warehouse staff'}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <InviteDialog open={inviting} onClose={() => setInviting(false)} sandbox={!!me?.company.sandbox} company={me?.company.name ?? ''} />
    </div>
  );
}

function InviteDialog({ open, onClose, sandbox, company }: { open: boolean; onClose: () => void; sandbox: boolean; company: string }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', email: '', loginId: '', role: 'staff' as Role });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = 'Enter a name';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errs.email = 'Enter a valid email address';
    const id = form.loginId.trim();
    if (id.length < 6 || id.length > 12) errs.loginId = 'Login ID must be 6 to 12 characters';
    else if (!/^[A-Za-z0-9._-]+$/.test(id)) errs.loginId = 'Use letters, numbers, dot, dash or underscore';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const res = await post<{ sent: boolean }>('/users', { ...form, loginId: id, email: form.email.trim() });
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      if (res.sent) toast.success(`Invitation sent to ${form.email.trim()}`, 'They choose a password from the link, which also confirms their email.');
      else toast.error('Added, but the email did not go out', 'Use “Resend” on the Team page in a minute.');
      setForm({ name: '', email: '', loginId: '', role: 'staff' });
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      if (!Object.keys(fieldErrors(err)).length) toast.error('Could not invite', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Invite a teammate"
      description={sandbox ? 'Invitations are off in demo workspaces so nobody gets emailed by accident.' : `They join ${company} and get an email with a link to set their password.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="invite-form" busy={busy} disabled={sandbox}>
            <EnvelopeSimple size={17} /> Send invitation
          </Button>
        </>
      }
    >
      <form id="invite-form" onSubmit={submit} noValidate style={{ display: 'grid', gap: 14 }}>
        <Field label="Name" htmlFor="iv-name" error={errors.name}>
          <input id="iv-name" className="input" value={form.name} onChange={(e) => set('name')(e.target.value)} maxLength={80} />
        </Field>
        <Field label="Email" htmlFor="iv-email" error={errors.email}>
          <input id="iv-email" type="email" className="input" value={form.email} onChange={(e) => set('email')(e.target.value)} />
        </Field>
        <div className="grid-2">
          <Field label="Login ID" htmlFor="iv-login" error={errors.loginId} hint="6 to 12 characters">
            <input id="iv-login" className="input mono" value={form.loginId} maxLength={12} onChange={(e) => set('loginId')(e.target.value)} />
          </Field>
          <Field label="Role" htmlFor="iv-role">
            <select id="iv-role" className="select" value={form.role} onChange={(e) => set('role')(e.target.value)}>
              <option value="staff">Warehouse staff</option>
              <option value="manager">Inventory manager</option>
            </select>
          </Field>
        </div>
      </form>
    </Dialog>
  );
}
