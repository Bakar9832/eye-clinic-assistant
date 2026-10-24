import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api, errorText } from '../api/client';

/** The staff door: same email-code flow as patients, separate account and cookie. */
export function AdminLoginPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (step === 'email') {
        await api('/staff/auth/request-code', { method: 'POST', body: { email } });
        setStep('code');
      } else {
        await api('/staff/auth/verify', { method: 'POST', body: { email, code } });
        // Forget the cached "nobody is logged in", or the admin area would read it and
        // bounce straight back here before asking the API again.
        queryClient.removeQueries({ queryKey: ['staff-me'] });
        navigate('/admin');
      }
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="mx-auto mt-16 max-w-sm space-y-4 px-4">
      <h1 className="text-xl font-semibold">Staff login</h1>
      <form onSubmit={submit} className="space-y-3">
        {step === 'email' ? (
          <label className="block">
            <span className="text-sm">Work email</span>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5" />
          </label>
        ) : (
          <label className="block">
            <span className="text-sm">Code sent to {email}</span>
            <input
              inputMode="numeric"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 font-mono tracking-widest"
            />
          </label>
        )}
        <button className="w-full rounded bg-slate-800 py-2 text-white">{step === 'email' ? 'Email me a code' : 'Log in'}</button>
      </form>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <p className="text-xs text-slate-500">Demo accounts: dr.ayesha@clinic.example, reception@clinic.example, admin@clinic.example. Codes appear in the API's log.</p>
    </div>
  );
}
