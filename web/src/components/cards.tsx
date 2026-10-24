import { useState, type FormEvent } from 'react';
import { DateTime } from 'luxon';
import { api, ApiError, errorText } from '../api/client';
import type { Card } from '../api/types';
import { useApp } from '../app-context';
import { TimeText } from './TimeText';

/**
 * The doctor's note, exactly as written: whitespace-pre-wrap keeps line breaks, and
 * nothing here (or in the AI) rewrites it. "Edited" tells the patient it was corrected.
 */
export function DoctorNoteCard({ card }: { card: Extract<Card, { type: 'doctor_note' }> }) {
  return (
    <section aria-label="Doctor's note" className="rounded-lg border border-brand-100 bg-white p-4 shadow-sm">
      <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold text-brand-800">Note from {card.doctorName}</h3>
        <span className="text-sm text-slate-500">
          {DateTime.fromISO(card.recordedAt).toFormat('d LLL yyyy')}
          {card.edited && card.editedAt && (
            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">
              Edited {DateTime.fromISO(card.editedAt).toFormat('d LLL yyyy')}
            </span>
          )}
        </span>
      </header>
      <p className="whitespace-pre-wrap" data-testid="doctor-note">
        {card.note}
      </p>
      <p className="mt-3 text-xs text-slate-500">
        Questions about your result? Ask to book a call with the doctor. The assistant can't interpret results.
      </p>
    </section>
  );
}

export function TicketCard({ card }: { card: Extract<Card, { type: 'ticket' }> }) {
  return (
    <section aria-label="Booking ticket" className="rounded-lg border border-brand-100 bg-white p-4 shadow-sm">
      <p className="text-sm text-slate-500">Booking reference</p>
      <p className="font-mono text-xl font-semibold tracking-wider text-brand-800">{card.reference}</p>
      <p className="mt-2">
        <TimeText iso={card.start} />
        {card.doctor && <span> with {card.doctor}</span>}
      </p>
      <p className="mt-2 text-sm text-slate-600">{card.prepInstructions}</p>
    </section>
  );
}

/**
 * The secure date-of-birth box. It sends the date straight to the clinic API, never
 * into the chat, so it never reaches the AI model or its provider.
 */
export function DobCard({ onVerified }: { onVerified: () => void }) {
  const { refreshMe } = useApp();
  const [dob, setDob] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/me/verify-dob', { method: 'POST', body: { dateOfBirth: dob } });
      setDone(true);
      onVerified();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'DOB_LOCKED') {
        setError('Too many wrong attempts, so you have been logged out. Please log in again.');
        await refreshMe();
      } else if (err instanceof ApiError && err.code === 'DOB_MISMATCH') {
        setError("That date of birth doesn't match our records.");
      } else {
        setError(errorText(err));
      }
    } finally {
      setBusy(false);
    }
  }

  if (done) return <p className="text-sm text-emerald-700">Date of birth confirmed.</p>;

  return (
    <form onSubmit={submit} aria-label="Confirm your date of birth" className="rounded-lg border border-brand-100 bg-white p-4 shadow-sm">
      <p className="mb-2 font-medium">Confirm your date of birth to see results</p>
      <p className="mb-3 text-xs text-slate-500">This goes straight to the clinic, not to the chat assistant.</p>
      <div className="flex flex-wrap gap-2">
        <input
          type="date"
          aria-label="Date of birth"
          required
          value={dob}
          onChange={(e) => setDob(e.target.value)}
          className="rounded border border-slate-300 px-2 py-1"
        />
        <button disabled={busy || !dob} className="rounded bg-brand-600 px-3 py-1 text-white disabled:opacity-50">
          Confirm
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    </form>
  );
}

/** Renders whichever card a tool produced. */
export function CardView({ card, onDobVerified }: { card: Card; onDobVerified: () => void }) {
  switch (card.type) {
    case 'doctor_note':
      return <DoctorNoteCard card={card} />;
    case 'ticket':
      return <TicketCard card={card} />;
    case 'dob_prompt':
      return <DobCard onVerified={onDobVerified} />;
  }
}
