import { FloppyDisk, SignOut } from '@phosphor-icons/react';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { PasswordInput, PasswordRules, PASSWORD_RULES } from '../auth/pages';
import { Button, Field, PageHeader } from '../components/ui';
import { errorMessage, fieldErrors, patch, post } from '../lib/api';
import { dateTime, initials } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import { queryClient, useMe } from '../lib/queries';
import { useToast } from '../lib/toast';
import type { User } from '../lib/types';

export default function Profile() {
  useDocumentTitle('My profile');
  const { data: me } = useMe();
  const toast = useToast();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState({ currentPassword: '', password: '', confirmPassword: '' });
  const [pwErrors, setPwErrors] = useState<Record<string, string>>({});
  const [pwBusy, setPwBusy] = useState(false);

  useEffect(() => {
    if (me) setForm({ name: me.name, email: me.email });
  }, [me]);
  if (!me) return null;

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const res = await patch<{ user: User }>('/auth/me', form);
      queryClient.setQueryData(['me'], res.user);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.success('Profile saved');
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error('Could not save', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    const failed = PASSWORD_RULES.find((r) => !r.test(pw.password));
    if (failed) return setPwErrors({ password: `Password needs: ${failed.label.toLowerCase()}` });
    if (pw.password !== pw.confirmPassword) return setPwErrors({ confirmPassword: 'Passwords do not match' });
    setPwBusy(true);
    setPwErrors({});
    try {
      const res = await post<{ user: User }>('/auth/change-password', pw);
      queryClient.setQueryData(['me'], res.user);
      setPw({ currentPassword: '', password: '', confirmPassword: '' });
      toast.success('Password changed', 'Other sessions were signed out.');
    } catch (err) {
      setPwErrors(fieldErrors(err));
      toast.error('Could not change the password', errorMessage(err));
    } finally {
      setPwBusy(false);
    }
  };

  const logout = async () => {
    await post('/auth/logout').catch(() => undefined);
    queryClient.clear();
    queryClient.setQueryData(['me'], null);
    navigate('/login', { replace: true });
  };

  const dirty = form.name !== me.name || form.email !== me.email;
  return (
    <div style={{ maxWidth: 880 }}>
      <PageHeader
        title="My profile"
        actions={
          <Button onClick={logout}>
            <SignOut size={17} /> Log out
          </Button>
        }
      />
      <div className="profile-card">
        <span className="avatar avatar--xl" aria-hidden="true">
          {initials(me.name)}
        </span>
        <div>
          <h2>{me.name}</h2>
          <p className="muted">
            <span className="mono">{me.loginId}</span>. {me.role === 'manager' ? 'Inventory manager' : 'Warehouse staff'}. Member since {dateTime(me.createdAt)}.
          </p>
        </div>
      </div>

      <div className="profile-grid">
        <form className="panel" onSubmit={saveProfile} noValidate>
          <div className="panel__head">
            <h2>Details</h2>
          </div>
          <div className="panel__body" style={{ display: 'grid', gap: 16 }}>
            <Field label="Name" htmlFor="pr-name" error={errors.name}>
              <input id="pr-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Email" htmlFor="pr-email" error={errors.email} hint="Password reset codes go here.">
              <input id="pr-email" type="email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="Login ID" htmlFor="pr-login" hint="Login IDs cannot be changed.">
              <input id="pr-login" className="input mono" value={me.loginId} disabled />
            </Field>
          </div>
          <div className="panel__foot" style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button type="submit" variant="primary" busy={busy} disabled={!dirty}>
              <FloppyDisk size={17} /> Save
            </Button>
          </div>
        </form>

        <form className="panel" onSubmit={changePassword} noValidate>
          <div className="panel__head">
            <h2>Change password</h2>
          </div>
          <div className="panel__body" style={{ display: 'grid', gap: 16 }}>
            <Field label="Current password" htmlFor="pr-cur" error={pwErrors.currentPassword}>
              <PasswordInput id="pr-cur" value={pw.currentPassword} onChange={(v) => setPw({ ...pw, currentPassword: v })} autoComplete="current-password" invalid={!!pwErrors.currentPassword} />
            </Field>
            <Field label="New password" htmlFor="pr-new" error={pwErrors.password}>
              <PasswordInput id="pr-new" value={pw.password} onChange={(v) => setPw({ ...pw, password: v })} autoComplete="new-password" invalid={!!pwErrors.password} />
              <PasswordRules value={pw.password} />
            </Field>
            <Field label="Re-enter new password" htmlFor="pr-new2" error={pwErrors.confirmPassword}>
              <PasswordInput id="pr-new2" value={pw.confirmPassword} onChange={(v) => setPw({ ...pw, confirmPassword: v })} autoComplete="new-password" invalid={!!pwErrors.confirmPassword} />
            </Field>
          </div>
          <div className="panel__foot" style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button type="submit" variant="dark" busy={pwBusy} disabled={!pw.currentPassword || !pw.password}>
              Change password
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
