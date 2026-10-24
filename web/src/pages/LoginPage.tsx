import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, errorText } from '../api/client';
import { useApp } from '../app-context';

/** Email → 6-digit code → logged in. No passwords. Or one click into the demo patient. */
export function LoginPage() {
  const { refreshMe } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next')?.startsWith('/') ? params.get('next')! : '/';

  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const requestCode = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('/auth/request-code', { method: 'POST', body: { email } });
      setStep('code');
    });
  };

  const verify = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('/auth/verify', { method: 'POST', body: { email, code } });
      await refreshMe();
      navigate(next);
    });
  };

  const demo = () =>
    run(async () => {
      await api('/auth/demo', { method: 'POST' });
      await refreshMe();
      navigate('/');
    });

  return (
    <div className="mx-auto max-w-sm space-y-6">
      <h1 className="text-xl font-semibold">Log in</h1>

      {step === 'email' ? (
        <form onSubmit={requestCode} className="space-y-3">
          <label className="block">
            <span className="text-sm">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            />
          </label>
          <button disabled={busy} className="w-full rounded bg-brand-600 py-2 text-white disabled:opacity-50">
            Email me a code
          </button>
        </form>
      ) : (
        <form onSubmit={verify} className="space-y-3">
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
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 font-mono tracking-widest"
            />
          </label>
          <button disabled={busy} className="w-full rounded bg-brand-600 py-2 text-white disabled:opacity-50">
            Log in
          </button>
          <button type="button" onClick={() => setStep('email')} className="w-full text-sm text-slate-500">
            Use a different email
          </button>
        </form>
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
