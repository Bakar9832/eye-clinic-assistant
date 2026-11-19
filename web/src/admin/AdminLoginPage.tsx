import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api, errorText } from '../api/client';

/** The staff door: email + password, separate account and cookie. Staff can't sign up here. */
export function AdminLoginPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/staff/auth/login', { method: 'POST', body: { email, password } });
      // Forget the cached "nobody is logged in", or the admin area would read it and
      // bounce straight back here before asking the API again.
      queryClient.removeQueries({ queryKey: ['staff-me'] });
      navigate('/admin');
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="min-h-screen bg-surface px-4 pt-16">
    <div className="mx-auto max-w-sm space-y-4 rounded-lg border border-line bg-white p-6 sm:p-8">
      <h1 className="text-2xl">Staff login</h1>
      <p className="text-sm text-ink-muted">For clinic staff. Patients log in on the main site.</p>
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="text-sm">Work email</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded-lg border border-line px-3 py-1.5 bg-white" />
        </label>
        <label className="block">
          <span className="text-sm">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line px-3 py-1.5 bg-white"
          />
        </label>
        <button className="w-full py-2 rounded-lg bg-ink font-medium text-white hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400">Log in</button>
      </form>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </div>
    </div>
  );
}
