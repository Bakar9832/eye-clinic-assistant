import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { api, errorText } from '../api/client';
import type { AppointmentType, Availability, Ticket } from '../api/types';
import { useApp } from '../app-context';
import { TicketCard } from '../components/cards';
import { LoginNeeded } from '../components/Layout';
import { ProfileForm } from '../components/ProfileForm';
import { TimeText } from '../components/TimeText';
import { daysFrom, todayIn } from '../time/zones';

type Slot = Availability['slots'][number];

/** Public calendar of free times only. Booking needs a login. */
export function CalendarPage() {
  const { clinic, me } = useApp();
  const queryClient = useQueryClient();
  const types = useQuery({ queryKey: ['appointment-types'], queryFn: () => api<AppointmentTypeWithSteps[]>('/appointment-types') });

  const [typeCode, setTypeCode] = useState('ROUTINE_EYE_TEST');
  const [doctorId, setDoctorId] = useState('');
  const [week, setWeek] = useState(0);
  const [chosen, setChosen] = useState<Slot | null>(null);
  const [booked, setBooked] = useState<Ticket | null>(null);

  const type = types.data?.find((t) => t.code === typeCode);
  // Only doctors who can do this kind of visit (e.g. only Dr Ayesha sees children).
  const skill = type?.steps.find((s) => s.resourceKind === 'OPTOMETRIST')?.requiredSkill ?? null;
  const doctors = (clinic?.doctors ?? []).filter((d) => !skill || d.skills.includes(skill));
  const days = clinic ? daysFrom(DateTime.fromISO(todayIn(clinic.timezone)).plus({ weeks: week }).toISODate()!, 7) : [];

  const availability = useQueries({
    queries: days.map((day) => ({
      queryKey: ['availability', typeCode, doctorId, day],
      queryFn: () =>
        api<Availability>(`/availability?${new URLSearchParams({ type: typeCode, day, ...(doctorId ? { doctorId } : {}) })}`),
    })),
  });

  const book = useMutation({
    mutationFn: (slot: Slot) =>
      api<Ticket>('/me/appointments', {
        method: 'POST',
        body: { typeCode, start: slot.start, ...(slot.doctor ? { doctorId: slot.doctor.id } : {}) },
      }),
    onSuccess: (ticket) => {
      setBooked(ticket);
      setChosen(null);
      void queryClient.invalidateQueries({ queryKey: ['availability'] });
      void queryClient.invalidateQueries({ queryKey: ['my-appointments'] });
    },
  });

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Book an appointment</h1>

      <div className="flex flex-wrap gap-3">
        <label className="text-sm">
          Type
          <select
            aria-label="Appointment type"
            value={typeCode}
            onChange={(e) => {
              setTypeCode(e.target.value);
              setDoctorId('');
              setChosen(null);
            }}
            className="ml-2 rounded border border-slate-300 bg-white px-2 py-1"
          >
            {types.data?.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name} (about {t.typicalMin} min)
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Doctor
          <select
            aria-label="Doctor"
            value={doctorId}
            onChange={(e) => {
              setDoctorId(e.target.value);
              setChosen(null);
            }}
            className="ml-2 rounded border border-slate-300 bg-white px-2 py-1"
          >
            <option value="">Any doctor</option>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.displayName}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex gap-2 text-sm">
          <button disabled={week === 0} onClick={() => setWeek((w) => w - 1)} className="rounded border px-2 disabled:opacity-40">
            ← Earlier
          </button>
          <button onClick={() => setWeek((w) => w + 1)} className="rounded border px-2">
            Later →
          </button>
        </div>
      </div>

      {type && <p className="text-sm text-slate-600">{type.prepInstructions}</p>}

      {booked && <TicketCard card={{ type: 'ticket', reference: booked.reference, start: booked.start, doctor: booked.doctor?.displayName ?? null, prepInstructions: booked.prepInstructions }} />}

      {chosen && (
        <div className="rounded-lg border-2 border-brand-600 bg-white p-4">
          {me === null ? (
            <LoginNeeded what="book" />
          ) : me && !me.profileComplete ? (
            <ProfileForm />
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span>
                {type?.name}: <TimeText iso={chosen.start} />
                {chosen.doctor && ` with ${chosen.doctor.displayName}`}
              </span>
              <button onClick={() => book.mutate(chosen)} disabled={book.isPending} className="rounded bg-brand-600 px-3 py-1.5 text-white">
                Book this
              </button>
              <button onClick={() => setChosen(null)} className="text-sm text-slate-500">
                Cancel
              </button>
            </div>
          )}
          {book.error && <p role="alert" className="mt-2 text-sm text-red-700">{errorText(book.error)}</p>}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {days.map((day, i) => {
          const result = availability[i];
          const slots = result?.data?.slots ?? [];
          return (
            <section key={day} aria-label={DateTime.fromISO(day).toFormat('cccc d LLLL')} className="rounded-lg border bg-white p-3">
              <h2 className="mb-2 text-sm font-medium">{DateTime.fromISO(day).toFormat('ccc d LLL')}</h2>
              {result?.isPending ? (
                <p className="text-xs text-slate-400">Loading…</p>
              ) : slots.length === 0 ? (
                <p className="text-xs text-slate-400">No free times</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {slots.map((slot) => (
                    <button
                      key={slot.start + (slot.doctor?.id ?? '')}
                      onClick={() => {
                        setChosen(slot);
                        setBooked(null);
                      }}
                      title={slot.doctor?.displayName}
                      className={`rounded border px-2 py-1 text-sm ${chosen?.start === slot.start ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:border-brand-600'}`}
                    >
                      <TimeText iso={slot.start} compact />
                    </button>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

export type AppointmentTypeWithSteps = AppointmentType & {
  steps: { position: number; resourceKind: string; requiredSkill: string | null; offsetMin: number; durationMin: number }[];
};
