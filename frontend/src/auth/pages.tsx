import { ArrowLeft, ArrowRight, Check, EnvelopeSimpleOpen, Eye, EyeSlash, Info, Lightning, WarningCircle } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ApiError, errorMessage, fieldErrors, post } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import type { User, Verification } from '../lib/types';
import { Button, Field } from '../components/ui';
import { AuthLayout, AuthSwitch } from './AuthLayout';

/* The same rules the API enforces, shown live while typing. */
export const PASSWORD_RULES = [
  { id: 'len', label: 'More than 8 characters', test: (p: string) => p.length > 8 },
  { id: 'lower', label: 'A lowercase letter', test: (p: string) => /[a-z]/.test(p) },
  { id: 'upper', label: 'An uppercase letter', test: (p: string) => /[A-Z]/.test(p) },
  { id: 'special', label: 'A special character', test: (p: string) => /[^A-Za-z0-9]/.test(p) },
];

export function PasswordRules({ value }: { value: string }) {
  return (
    <ul className="password-rules" aria-label="Password requirements">
      {PASSWORD_RULES.map((r) => {
        const ok = r.test(value);
        return (
          <li key={r.id} className={ok ? 'ok' : ''}>
            {ok ? <Check size={13} weight="bold" aria-hidden="true" /> : <span aria-hidden="true" className="rule-dot" />}
            {r.label}
            <span className="sr-only">{ok ? ' (met)' : ' (not met yet)'}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function PasswordInput({
  id,
  value,
  onChange,
  invalid,
  autoComplete,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  autoComplete: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="pw">
      <input
        id={id}
        className="input"
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-error` : undefined}
        required
      />
      <button type="button" className="pw__toggle" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}>
        {show ? <EyeSlash size={18} /> : <Eye size={18} />}
      </button>
    </div>
  );
}

function useSignedIn() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  return (user: User) => {
    qc.setQueryData(['me'], user);
    const next = params.get('next');
    // only follow in-app paths
    navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true });
  };
}

/* ------------------------------------------------------------------ sign in */
export function LoginPage() {
  useDocumentTitle('Sign in');
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const done = useSignedIn();
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await post<{ user: User }>('/auth/login', { loginId, password });
      done(res.user);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'email_unverified') {
        const d = err.data as { verification: Verification; devCode?: string };
        navigate('/verify', { state: { ...d.verification, devCode: d.devCode, fromLogin: true } });
        return;
      }
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Pick up where the floor left off."
      footer={
        <AuthSwitch to="/signup" label="Create an account">
          New to StockSense?
        </AuthSwitch>
      }
    >
      <form className="auth__fields" onSubmit={submit} noValidate>
        {error && (
          <div className="error-box" role="alert">
            <WarningCircle size={20} weight="fill" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
        <Field label="Login ID" htmlFor="loginId">
          <input id="loginId" className="input" value={loginId} onChange={(e) => setLoginId(e.target.value)} autoComplete="username" autoFocus required />
        </Field>
        <Field label="Password" htmlFor="password">
          <PasswordInput id="password" value={password} onChange={setPassword} autoComplete="current-password" />
        </Field>
        <div className="auth__row">
          <Link to="/forgot-password" className="auth__link">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" variant="primary" size="lg" className="btn--block" busy={busy} disabled={!loginId || !password}>
          Sign in <ArrowRight size={18} />
        </Button>
        <DemoButton />
      </form>
    </AuthLayout>
  );
}

/* ------------------------------------------------------------------ sign up */
export function SignupPage() {
  useDocumentTitle('Create account');
  const [form, setForm] = useState({ companyName: '', name: '', loginId: '', email: '', password: '', confirmPassword: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const validate = () => {
    const e: Record<string, string> = {};
    if (form.companyName.trim().length < 2) e.companyName = 'Enter your company name';
    const id = form.loginId.trim();
    if (id.length < 6 || id.length > 12) e.loginId = 'Login ID must be 6 to 12 characters';
    else if (!/^[A-Za-z0-9._-]+$/.test(id)) e.loginId = 'Use letters, numbers, dot, dash or underscore';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) e.email = 'Enter a valid email address';
    const failed = PASSWORD_RULES.find((r) => !r.test(form.password));
    if (failed) e.password = `Password needs: ${failed.label.toLowerCase()}`;
    if (form.confirmPassword !== form.password) e.confirmPassword = 'Passwords do not match';
    return e;
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    setError('');
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const res = await post<{ verification: Verification; devCode?: string }>('/auth/signup', {
        ...form,
        loginId: form.loginId.trim(),
        email: form.email.trim(),
      });
      navigate('/verify', { state: { ...res.verification, devCode: res.devCode } });
    } catch (err) {
      setErrors(fieldErrors(err));
      if (!(err instanceof ApiError) || !Object.keys(err.fields).length) setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Create your workspace"
      subtitle="A private StockSense for your company. You become its inventory manager and invite the team later."
      footer={
        <AuthSwitch to="/login" label="Sign in">
          Already have an account?
        </AuthSwitch>
      }
    >
      <form className="auth__fields" onSubmit={submit} noValidate>
        {error && (
          <div className="error-box" role="alert">
            <WarningCircle size={20} weight="fill" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
        <div className="auth__pair">
          <Field label="Company" htmlFor="su-company" error={errors.companyName}>
            <input
              id="su-company"
              className="input"
              value={form.companyName}
              onChange={(e) => set('companyName')(e.target.value)}
              autoComplete="organization"
              maxLength={80}
              aria-invalid={!!errors.companyName || undefined}
              aria-describedby={errors.companyName ? 'su-company-error' : undefined}
              autoFocus
              required
            />
          </Field>
          <Field label="Your name" htmlFor="su-name" error={errors.name}>
            <input id="su-name" className="input" value={form.name} onChange={(e) => set('name')(e.target.value)} autoComplete="name" maxLength={80} />
          </Field>
        </div>
        <Field label="Login ID" htmlFor="su-login" error={errors.loginId} hint="6 to 12 characters. You sign in with this.">
          <input
            id="su-login"
            className="input"
            value={form.loginId}
            onChange={(e) => set('loginId')(e.target.value)}
            autoComplete="username"
            maxLength={12}
            aria-invalid={!!errors.loginId || undefined}
            aria-describedby={errors.loginId ? 'su-login-error' : undefined}
            required
          />
        </Field>
        <Field label="Email" htmlFor="su-email" error={errors.email} hint="We send a code here to confirm it is yours.">
          <input
            id="su-email"
            className="input"
            type="email"
            value={form.email}
            onChange={(e) => set('email')(e.target.value)}
            autoComplete="email"
            aria-invalid={!!errors.email || undefined}
            aria-describedby={errors.email ? 'su-email-error' : undefined}
            required
          />
        </Field>
        <Field label="Password" htmlFor="su-pass" error={errors.password}>
          <PasswordInput id="su-pass" value={form.password} onChange={set('password')} autoComplete="new-password" invalid={!!errors.password} />
          <PasswordRules value={form.password} />
        </Field>
        <Field label="Re-enter password" htmlFor="su-pass2" error={errors.confirmPassword}>
          <PasswordInput id="su-pass2" value={form.confirmPassword} onChange={set('confirmPassword')} autoComplete="new-password" invalid={!!errors.confirmPassword} />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="btn--block" busy={busy}>
          Create workspace <ArrowRight size={18} />
        </Button>
        <DemoButton />
      </form>
    </AuthLayout>
  );
}

/* ------------------------------------------------------------------ OTP input */
export function OtpInput({ value, onChange, invalid }: { value: string; onChange: (v: string) => void; invalid?: boolean }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] ?? '');
  const setAt = (i: number, d: string) => {
    const next = digits.slice();
    next[i] = d;
    onChange(next.join('').slice(0, 6));
  };
  const onKey = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) refs.current[i - 1]?.focus();
    if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
    if (e.key === 'ArrowRight' && i < 5) refs.current[i + 1]?.focus();
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (text) {
      e.preventDefault();
      onChange(text);
      refs.current[Math.min(text.length, 5)]?.focus();
    }
  };
  return (
    <div className="otp" role="group" aria-label="6-digit code">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="input otp__cell"
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          value={d}
          aria-label={`Digit ${i + 1}`}
          aria-invalid={invalid || undefined}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(-1);
            setAt(i, v);
            if (v && i < 5) refs.current[i + 1]?.focus();
          }}
          onKeyDown={onKey(i)}
          onPaste={onPaste}
          autoFocus={i === 0}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ forgot password (OTP) */
export function ForgotPage() {
  useDocumentTitle('Reset password');
  const [step, setStep] = useState<'email' | 'code' | 'password'>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [devOtp, setDevOtp] = useState<string | undefined>();
  const [token, setToken] = useState('');
  const [pw, setPw] = useState({ password: '', confirmPassword: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const done = useSignedIn();

  const run = async (fn: () => Promise<void>) => {
    setErrors({});
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      const f = fieldErrors(err);
      setErrors(Object.keys(f).length ? f : { _: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const sendCode = (e?: FormEvent) => {
    e?.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setErrors({ email: 'Enter a valid email address' });
    void run(async () => {
      const res = await post<{ message: string; devOtp?: string }>('/auth/forgot-password', { email: email.trim() });
      setMessage(res.message);
      setDevOtp(res.devOtp);
      setOtp('');
      setStep('code');
    });
  };

  const verify = (e: FormEvent) => {
    e.preventDefault();
    if (otp.length !== 6) return setErrors({ otp: 'Enter all 6 digits' });
    void run(async () => {
      const res = await post<{ resetToken: string }>('/auth/verify-otp', { email: email.trim(), otp });
      setToken(res.resetToken);
      setStep('password');
    });
  };

  const reset = (e: FormEvent) => {
    e.preventDefault();
    const failed = PASSWORD_RULES.find((r) => !r.test(pw.password));
    if (failed) return setErrors({ password: `Password needs: ${failed.label.toLowerCase()}` });
    if (pw.password !== pw.confirmPassword) return setErrors({ confirmPassword: 'Passwords do not match' });
    void run(async () => {
      const res = await post<{ user: User }>('/auth/reset-password', { resetToken: token, ...pw });
      done(res.user);
    });
  };

  const steps = ['email', 'code', 'password'] as const;
  return (
    <AuthLayout
      title="Reset password"
      subtitle={
        step === 'email'
          ? 'We will email you a 6-digit code and a reset link.'
          : step === 'code'
            ? `Enter the code sent to ${email.trim()}.`
            : 'Choose a new password. Other sessions will be signed out.'
      }
      footer={
        <AuthSwitch to="/login" label="Back to sign in">
          Remembered it?
        </AuthSwitch>
      }
    >
      <ol className="auth-steps" aria-label="Progress">
        {steps.map((s, i) => (
          <li key={s} className={steps.indexOf(step) >= i ? 'on' : ''} aria-current={step === s ? 'step' : undefined}>
            {s === 'email' ? 'Email' : s === 'code' ? 'Code' : 'New password'}
          </li>
        ))}
      </ol>
      {errors._ && (
        <div className="error-box" role="alert" style={{ marginBottom: 14 }}>
          <WarningCircle size={20} weight="fill" aria-hidden="true" />
          <span>{errors._}</span>
        </div>
      )}

      {step === 'email' && (
        <form className="auth__fields" onSubmit={sendCode} noValidate>
          <Field label="Email" htmlFor="fp-email" error={errors.email}>
            <input
              id="fp-email"
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              aria-invalid={!!errors.email || undefined}
              autoFocus
              required
            />
          </Field>
          <Button type="submit" variant="primary" size="lg" className="btn--block" busy={busy}>
            Send code <ArrowRight size={18} />
          </Button>
        </form>
      )}

      {step === 'code' && (
        <form className="auth__fields" onSubmit={verify} noValidate>
          {message && <p className="auth__note">{message}</p>}
          {devOtp && (
            <div className="note-box">
              <Info size={18} weight="fill" aria-hidden="true" />
              <span>
                Development mode: your code is <b className="mono">{devOtp}</b>. Production sends it by email only.
              </span>
            </div>
          )}
          <Field label="6-digit code" error={errors.otp}>
            <OtpInput value={otp} onChange={setOtp} invalid={!!errors.otp} />
          </Field>
          <Button type="submit" variant="primary" size="lg" className="btn--block" busy={busy} disabled={otp.length !== 6}>
            Verify code <ArrowRight size={18} />
          </Button>
          <div className="auth__row">
            <button type="button" className="auth__link as-button" onClick={() => setStep('email')}>
              <ArrowLeft size={14} /> Change email
            </button>
            <button type="button" className="auth__link as-button" onClick={() => sendCode()} disabled={busy}>
              Send a new code
            </button>
          </div>
        </form>
      )}

      {step === 'password' && (
        <form className="auth__fields" onSubmit={reset} noValidate>
          <Field label="New password" htmlFor="fp-pass" error={errors.password}>
            <PasswordInput id="fp-pass" value={pw.password} onChange={(v) => setPw((p) => ({ ...p, password: v }))} autoComplete="new-password" invalid={!!errors.password} />
            <PasswordRules value={pw.password} />
          </Field>
          <Field label="Re-enter password" htmlFor="fp-pass2" error={errors.confirmPassword}>
            <PasswordInput
              id="fp-pass2"
              value={pw.confirmPassword}
              onChange={(v) => setPw((p) => ({ ...p, confirmPassword: v }))}
              autoComplete="new-password"
              invalid={!!errors.confirmPassword}
            />
          </Field>
          <Button type="submit" variant="primary" size="lg" className="btn--block" busy={busy}>
            Save and sign in <ArrowRight size={18} />
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

/* ------------------------------------------------------------------ demo */
export function DemoButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const done = useSignedIn();
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await post<{ user: User }>('/auth/demo');
      done(res.user);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <div className="demo-cta">
      <span className="demo-cta__or">or</span>
      <Button type="button" variant="dark" size="lg" className="btn--block" busy={busy} onClick={start}>
        <Lightning size={18} weight="fill" /> Try a live demo workspace
      </Button>
      <p className="demo-cta__note">A private sample company with three weeks of history, just for you. No sign-up; it is deleted after 24 hours.</p>
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ verify email */
type VerifyState = Partial<Verification> & { devCode?: string; fromLogin?: boolean };

export function VerifyPage() {
  useDocumentTitle('Confirm your email');
  const [params] = useSearchParams();
  const token = params.get('token');
  const state = (useLocation().state ?? {}) as VerifyState;
  const done = useSignedIn();
  const [email, setEmail] = useState(state.email ?? '');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState(state.devCode);
  const [cooldown, setCooldown] = useState(state.resendIn ?? 0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [linkState, setLinkState] = useState<'idle' | 'checking' | 'failed'>(token ? 'checking' : 'idle');
  const [linkError, setLinkError] = useState('');
  const [notice, setNotice] = useState('');
  const tried = useRef(false);

  // link from the email: confirm straight away
  useEffect(() => {
    if (!token || tried.current) return;
    tried.current = true;
    post<{ user: User }>('/auth/verify-email/link', { token })
      .then((res) => done(res.user))
      .catch((err) => {
        setLinkError(errorMessage(err));
        setLinkState('failed');
      });
  }, [token, done]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setErrors({ email: 'Enter the email you signed up with' });
    if (code.length !== 6) return setErrors({ code: 'Enter all 6 digits' });
    setErrors({});
    setBusy(true);
    try {
      const res = await post<{ user: User }>('/auth/verify-email', { email: email.trim(), code });
      done(res.user);
    } catch (err) {
      const f = fieldErrors(err);
      setErrors(Object.keys(f).length ? f : { _: errorMessage(err) });
      setBusy(false);
    }
  };

  const resend = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setErrors({ email: 'Enter the email you signed up with' });
    setErrors({});
    try {
      const res = await post<{ resendIn: number; devCode?: string }>('/auth/resend-verification', { email: email.trim() });
      setCooldown(res.resendIn);
      if (res.devCode) setDevCode(res.devCode);
      setCode('');
      setNotice('A new code is on its way. Older codes stop working.');
    } catch (err) {
      setErrors({ _: errorMessage(err) });
    }
  };

  if (linkState === 'checking') {
    return (
      <AuthLayout title="Confirming your email" subtitle="One moment…">
        <div className="verify-hero" aria-busy="true">
          <EnvelopeSimpleOpen size={44} weight="duotone" />
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Check your inbox"
      subtitle={
        email ? (
          <>
            We sent a 6-digit code and a confirmation link to <b>{state.masked ?? email}</b>. Use either one.
          </>
        ) : (
          'Enter the email you signed up with and the 6-digit code we sent you.'
        )
      }
      footer={
        <AuthSwitch to="/login" label="Back to sign in">
          Wrong account?
        </AuthSwitch>
      }
    >
      <form className="auth__fields" onSubmit={submit} noValidate>
        <div className="verify-hero" aria-hidden="true">
          <EnvelopeSimpleOpen size={44} weight="duotone" />
        </div>
        {linkState === 'failed' && (
          <div className="error-box" role="alert">
            <WarningCircle size={20} weight="fill" aria-hidden="true" />
            <span>{linkError} You can still use the code, or send a new one below.</span>
          </div>
        )}
        {state.fromLogin && <p className="auth__note">Your email is not confirmed yet, so sign-in is paused. We just sent a fresh code.</p>}
        {state.sent === false && (
          <div className="error-box" role="alert">
            <WarningCircle size={20} weight="fill" aria-hidden="true" />
            <span>We could not send the email just now. Wait a minute and press “Send a new code”.</span>
          </div>
        )}
        {errors._ && (
          <div className="error-box" role="alert">
            <WarningCircle size={20} weight="fill" aria-hidden="true" />
            <span>{errors._}</span>
          </div>
        )}
        {notice && <p className="auth__note">{notice}</p>}
        {devCode && (
          <div className="note-box">
            <Info size={18} weight="fill" aria-hidden="true" />
            <span>
              Development mode: your code is <b className="mono">{devCode}</b>. Production sends it by email only.
            </span>
          </div>
        )}
        {!state.email && (
          <Field label="Email" htmlFor="vf-email" error={errors.email}>
            <input id="vf-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </Field>
        )}
        <Field label="6-digit code" error={errors.code}>
          <OtpInput value={code} onChange={setCode} invalid={!!errors.code} />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="btn--block" busy={busy} disabled={code.length !== 6}>
          Confirm and sign in <ArrowRight size={18} />
        </Button>
        <div className="auth__row">
          <span className="muted" style={{ fontSize: 13 }}>
            Nothing yet? Check spam.
          </span>
          <button type="button" className="auth__link as-button" onClick={resend} disabled={cooldown > 0}>
            {cooldown > 0 ? `Send a new code in ${cooldown}s` : 'Send a new code'}
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}

/* ------------------------------------------------------------------ reset link / invitation */
interface LinkInfo {
  loginId: string;
  name: string;
  masked: string;
  companyName: string;
  invited: boolean;
}

export function ResetLinkPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [failed, setFailed] = useState('');
  const [pw, setPw] = useState({ password: '', confirmPassword: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const done = useSignedIn();
  useDocumentTitle(info?.invited ? 'Join your team' : 'Choose a new password');

  useEffect(() => {
    if (!token) return setFailed('This link is incomplete. Open it straight from the email.');
    post<LinkInfo>('/auth/reset-link', { token })
      .then(setInfo)
      .catch((err) => setFailed(errorMessage(err)));
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const bad = PASSWORD_RULES.find((r) => !r.test(pw.password));
    if (bad) return setErrors({ password: `Password needs: ${bad.label.toLowerCase()}` });
    if (pw.password !== pw.confirmPassword) return setErrors({ confirmPassword: 'Passwords do not match' });
    setErrors({});
    setBusy(true);
    try {
      const res = await post<{ user: User }>('/auth/reset-password', { token, ...pw });
      done(res.user);
    } catch (err) {
      const f = fieldErrors(err);
      setErrors(Object.keys(f).length ? f : { _: errorMessage(err) });
      setBusy(false);
    }
  };

  if (failed) {
    return (
      <AuthLayout
        title="Link not valid"
        subtitle={failed}
        footer={
          <AuthSwitch to="/login" label="Back to sign in">
            Already set up?
          </AuthSwitch>
        }
      >
        <Link to="/forgot-password" className="btn btn--primary btn--lg btn--block">
          Get a new code <ArrowRight size={18} />
        </Link>
      </AuthLayout>
    );
  }
  if (!info) {
    return (
      <AuthLayout title="Checking your link" subtitle="One moment…">
        <div className="verify-hero" aria-busy="true">
          <EnvelopeSimpleOpen size={44} weight="duotone" />
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={info.invited ? `Join ${info.companyName}` : 'Choose a new password'}
      subtitle={
        info.invited ? (
          <>
            Hi {info.name}. Your Login ID is <b className="mono">{info.loginId}</b>. Pick a password to finish setting up.
          </>
        ) : (
          <>
            For <b className="mono">{info.loginId}</b> ({info.masked}). Other sessions will be signed out.
          </>
        )
      }
    >
      <form className="auth__fields" onSubmit={submit} noValidate>
        {errors._ && (
          <div className="error-box" role="alert">
            <WarningCircle size={20} weight="fill" aria-hidden="true" />
            <span>{errors._}</span>
          </div>
        )}
        <Field label="New password" htmlFor="rl-pass" error={errors.password}>
          <PasswordInput id="rl-pass" value={pw.password} onChange={(v) => setPw((p) => ({ ...p, password: v }))} autoComplete="new-password" invalid={!!errors.password} />
          <PasswordRules value={pw.password} />
        </Field>
        <Field label="Re-enter password" htmlFor="rl-pass2" error={errors.confirmPassword}>
          <PasswordInput
            id="rl-pass2"
            value={pw.confirmPassword}
            onChange={(v) => setPw((p) => ({ ...p, confirmPassword: v }))}
            autoComplete="new-password"
            invalid={!!errors.confirmPassword}
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="btn--block" busy={busy}>
          {info.invited ? 'Join and sign in' : 'Save and sign in'} <ArrowRight size={18} />
        </Button>
      </form>
    </AuthLayout>
  );
}
