import { useState, type FormEvent } from 'react';
import { api, errorText } from '../api/client';
import { useApp } from '../app-context';

/** Name and date of birth, asked once before the first booking. The date can't be changed later here. */
export function ProfileForm({ onSaved }: { onSaved?: () => void }) {
  const { me, refreshMe } = useApp();
  const [fullName, setFullName] = useState(me?.fullName ?? '');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/me', {
        method: 'PATCH',
        body: { fullName, ...(me?.hasDateOfBirth ? {} : { dateOfBirth }) },
      });
      await refreshMe();
      onSaved?.();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <form onSubmit={submit} aria-label="Your details" className="space-y-3 rounded-lg border bg-white p-4">
      <p className="text-sm text-slate-600">Before your first booking we need your name and date of birth. Please use made-up details: this is a demo.</p>
      <label className="block">
        <span className="text-sm">Full name</span>
        <input required value={fullName} onChange={(e) => setFullName(e.target.value)} className="mt-1 w-full rounded border border-slate-300 px-2 py-1" />
      </label>
      {!me?.hasDateOfBirth && (
        <label className="block">
          <span className="text-sm">Date of birth</span>
          <input
            type="date"
            required
            value={dateOfBirth}
            onChange={(e) => setDateOfBirth(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
      )}
      <button className="rounded bg-brand-600 px-3 py-1.5 text-white">Save</button>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </form>
  );
}
