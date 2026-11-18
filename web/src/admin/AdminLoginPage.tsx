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
    <div className="mx-auto mt-16 max-w-sm space-y-4 px-4">
      <h1 className="text-xl font-semibold">Staff login</h1>
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="text-sm">Work email</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5" />
        </label>
        <label className="block">
          <span className="text-sm">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
          />
        </label>
        <button className="w-full rounded bg-slate-800 py-2 text-white">Log in</button>
      </form>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <p className="text-xs text-slate-500">
        Demo accounts: dr.ayesha@clinic.example, reception@clinic.example, admin@clinic.example. Passwords are set by the clinic's admin.
      </p>
    </div>
  );
}
