import { useState, type FormEvent } from 'react';
import { DateTime } from 'luxon';
import { Link } from 'react-router';
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
    <section aria-label="Doctor's note" className="rounded-lg border border-line bg-white p-4">
      <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-ink">Note from {card.doctorName}</h3>
        <span className="text-sm text-slate-500">
          {DateTime.fromISO(card.recordedAt).toFormat('d LLL yyyy')}
          {card.edited && card.editedAt && (
            <span className="ml-2 rounded bg-warning-soft px-1.5 py-0.5 text-xs font-medium text-amber-800">
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
    <section aria-label="Booking ticket" className="rounded-lg border border-line bg-white p-4">
      <p className="text-sm text-slate-500">Booking reference</p>
      <p className="font-mono text-xl font-semibold tracking-wider text-ink">{card.reference}</p>
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

  if (done) return <p className="text-sm text-success">Date of birth confirmed.</p>;

  return (
    <form onSubmit={submit} aria-label="Confirm your date of birth" className="rounded-lg border border-line bg-white p-4">
      <p className="mb-2 font-medium">Confirm your date of birth to see results</p>
      <p className="mb-3 text-xs text-slate-500">This goes straight to the clinic, not to the chat assistant.</p>
      <div className="flex flex-wrap gap-2">
        <input
          type="date"
          aria-label="Date of birth"
          required
          value={dob}
          onChange={(e) => setDob(e.target.value)}
          className="rounded-lg border border-line px-3 py-1.5 tabular-nums"
        />
        <button disabled={busy || !dob} className="rounded-lg bg-ink px-3.5 py-1.5 font-medium text-white hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400">
          Confirm
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    </form>
  );
}

export type Offer = Extract<Card, { type: 'booking_offer' }>;

/**
 * A free time the patient asked about. The model wrote the question above it; these
 * buttons are the answer. Only the newest offer can be used, so an old one can't book
 * by accident.
 */
function BookingOfferCard({ card, actions }: { card: Offer; actions: OfferActions }) {
  return (
    <section aria-label="Booking offer" className="rounded-lg border border-line bg-white p-4">
      <p className="font-medium text-ink">{card.typeName}</p>
      <p className="mt-1">
        <TimeText iso={card.start} />
        {card.doctor && <span> with {card.doctor}</span>}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          disabled={!actions.active}
          onClick={() => actions.onConfirm(card)}
          className="rounded-lg bg-ink px-3.5 py-1.5 font-medium text-white hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
        >
          Confirm
        </button>
        <button
          disabled={!actions.active}
          onClick={actions.onOtherTime}
          className="rounded-lg border border-line px-3.5 py-1.5 text-ink hover:border-slate-400 disabled:opacity-50"
        >
          Choose another time
        </button>
      </div>
    </section>
  );
}

interface OfferActions {
  active: boolean;
  onConfirm: (card: Offer) => void;
  onOtherTime: () => void;
}

/** Renders whichever card a tool produced. */
/** A stalled chat: one click asks the clinic to call back (logged in), or explains how (guest). */
function CallbackOfferCard({ card, active, onRequest }: { card: Extract<Card, { type: 'callback_offer' }>; active: boolean; onRequest: () => void }) {
  return (
    <section aria-label="Call back offer" className="space-y-2 rounded-lg border border-line bg-white p-4">
      <p className="font-medium text-ink">Would it be easier to talk to someone?</p>
      {card.loggedIn ? (
        <button onClick={onRequest} disabled={!active} className="rounded-lg bg-ink px-3.5 py-1.5 font-medium text-white hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400">
          Request a call back
        </button>
      ) : (
        <p className="text-sm text-ink-muted">
          <Link to="/login" className="font-medium text-accent underline-offset-2 hover:underline">
            Log in
          </Link>{' '}
          and the clinic's staff can call you back.
        </p>
      )}
    </section>
  );
}

/**
 * The free times as buttons. A tap books that time through the page (the tap is the
 * patient's choice), the same way as Confirm on a booking offer.
 */
function SlotChoicesCard({
  card,
  active,
  onPick,
}: {
  card: Extract<Card, { type: 'slot_choices' }>;
  active: boolean;
  onPick: (offer: Offer) => void;
}) {
  return (
    <section aria-label="Free times" className="space-y-3 rounded-lg border border-line bg-white p-4">
      <p className="text-sm text-ink-muted">{card.typeName}: tap a time to book it</p>
      <div className="flex flex-wrap gap-2">
        {card.slots.map((s) => (
          <button
            key={s.start}
            onClick={() => onPick({ type: 'booking_offer', typeCode: card.typeCode, typeName: card.typeName, start: s.start, doctorId: s.doctorId, doctor: s.doctor })}
            disabled={!active}
            className="rounded-full border border-line px-3.5 py-1.5 text-left text-ink hover:border-accent hover:text-accent disabled:opacity-50"
          >
            <TimeText iso={s.start} />
            {s.doctor && <span className="block text-xs text-ink-muted">{s.doctor}</span>}
          </button>
        ))}
      </div>
    </section>
  );
}

export function CardView({
  card,
  onDobVerified,
  offer,
  callback,
  slots,
}: {
  card: Card;
  onDobVerified: () => void;
  offer?: OfferActions;
  callback?: { active: boolean; onRequest: () => void };
  slots?: { active: boolean; onPick: (offer: Offer) => void };
}) {
  switch (card.type) {
    case 'doctor_note':
      return <DoctorNoteCard card={card} />;
    case 'ticket':
      return <TicketCard card={card} />;
    case 'dob_prompt':
      return <DobCard onVerified={onDobVerified} />;
    case 'booking_offer':
      return <BookingOfferCard card={card} actions={offer ?? { active: false, onConfirm: () => {}, onOtherTime: () => {} }} />;
    case 'slot_choices':
      return <SlotChoicesCard card={card} active={slots?.active ?? false} onPick={slots?.onPick ?? (() => {})} />;
    case 'callback_offer':
      return <CallbackOfferCard card={card} active={callback?.active ?? false} onRequest={callback?.onRequest ?? (() => {})} />;
  }
}
