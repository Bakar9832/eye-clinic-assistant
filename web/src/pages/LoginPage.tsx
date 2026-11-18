import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, errorText } from '../api/client';
import { useApp } from '../app-context';

type Mode = 'login' | 'signup' | 'reset';

const TITLES: Record<Mode, string> = { login: 'Log in', signup: 'Create account', reset: 'Reset your password' };
/** Must match the API's PASSWORD_MIN; the API checks it again. */
const PASSWORD_MIN = 8;

const inputClass = 'mt-1 w-full rounded border border-slate-300 px-2 py-1.5';
const primaryClass = 'w-full rounded bg-brand-600 py-2 text-white disabled:opacity-50';
const linkClass = 'text-sm text-brand-700 underline-offset-2 hover:underline';

/**
 * Log in with email + password. Creating an account and resetting a password share one
 * flow: email → a 6-digit code is emailed → the code and a new password → logged in.
 */
export function LoginPage() {
  const { refreshMe } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next')?.startsWith('/') ? params.get('next')! : '/';

  const [mode, setMode] = useState<Mode>('login');
  const [codeSent, setCodeSent] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function switchTo(next: Mode) {
    setMode(next);
    setCodeSent(false);
    setPassword('');
    setCode('');
    setError(null);
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function loggedIn(to: string) {
    await refreshMe();
    navigate(to);
  }

  const logIn = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('/auth/login', { method: 'POST', body: { email, password } });
      await loggedIn(next);
    });
  };

  const requestCode = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('/auth/request-code', { method: 'POST', body: { email } });
      setCodeSent(true);
    });
  };

  const setNewPassword = (e: FormEvent) => {
    e.preventDefault();
    if (password.length < PASSWORD_MIN) {
      setError(`Your password needs at least ${PASSWORD_MIN} characters.`);
      return;
    }
    void run(async () => {
      // Sign-up also sends name and date of birth, so a new patient can book straight away.
      const profile = mode === 'signup' ? { fullName, dateOfBirth } : {};
      await api('/auth/set-password', { method: 'POST', body: { email, code, password, ...profile } });
      await loggedIn(next);
    });
  };

  const demo = () =>
    run(async () => {
      await api('/auth/demo', { method: 'POST' });
      await loggedIn('/');
    });

  const emailField = (
    <label className="block">
      <span className="text-sm">Email</span>
      <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
    </label>
  );

  return (
    <div className="mx-auto max-w-sm space-y-6">
      <h1 className="text-xl font-semibold">{TITLES[mode]}</h1>

      {mode === 'login' && (
        <form onSubmit={logIn} className="space-y-3">
          {emailField}
          <label className="block">
            <span className="text-sm">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </label>
          <button disabled={busy} className={primaryClass}>
            Log in
          </button>
          <div className="flex justify-between">
            <button type="button" onClick={() => switchTo('signup')} className={linkClass}>
              Create an account
            </button>
            <button type="button" onClick={() => switchTo('reset')} className={linkClass}>
              Forgot password?
            </button>
          </div>
        </form>
      )}

      {mode !== 'login' && !codeSent && (
        <form onSubmit={requestCode} className="space-y-3">
          <p className="text-sm text-slate-600">
            {mode === 'signup'
              ? "We'll email you a 6-digit code to check the address is yours."
              : "We'll email you a 6-digit code so you can choose a new password."}
          </p>
          {emailField}
          <button disabled={busy} className={primaryClass}>
            Email me a code
          </button>
        </form>
      )}

      {mode !== 'login' && codeSent && (
        <form onSubmit={setNewPassword} className="space-y-3">
          <p className="text-sm text-slate-600">
            If <strong>{email}</strong> can receive email, a 6-digit code is on its way. It expires in 10 minutes.
          </p>
          <label className="block">
            <span className="text-sm">Code</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className={`${inputClass} font-mono tracking-widest`}
            />
          </label>
          <label className="block">
            <span className="text-sm">{mode === 'signup' ? 'Choose a password' : 'New password'}</span>
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN}
              maxLength={128}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
            <span className="text-xs text-slate-500">At least {PASSWORD_MIN} characters.</span>
          </label>
          {mode === 'signup' && (
            <fieldset className="space-y-3 rounded border border-slate-200 p-3">
              <legend className="px-1 text-sm text-slate-600">Your details (needed to book)</legend>
              <p className="text-xs text-slate-500">This is a demo: please use a made-up name and date of birth.</p>
              <label className="block">
                <span className="text-sm">Full name</span>
                <input autoComplete="name" required maxLength={100} value={fullName} onChange={(e) => setFullName(e.target.value)} className={inputClass} />
              </label>
              <label className="block">
                <span className="text-sm">Date of birth</span>
                <input type="date" required value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} className={inputClass} />
              </label>
            </fieldset>
          )}
          <button disabled={busy} className={primaryClass}>
            {mode === 'signup' ? 'Create account' : 'Save new password'}
          </button>
          <button type="button" onClick={() => setCodeSent(false)} className="w-full text-sm text-slate-500">
            Use a different email
          </button>
        </form>
      )}

      {mode !== 'login' && (
        <button type="button" onClick={() => switchTo('login')} className={linkClass}>
          Back to log in
        </button>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="border-t pt-6 text-center">
        <p className="mb-2 text-sm text-slate-600">Just looking around?</p>
        <button onClick={demo} disabled={busy} className="rounded border border-brand-600 px-4 py-2 text-brand-700 disabled:opacity-50">
          Try as demo patient
        </button>
      </div>
    </div>
  );
}
