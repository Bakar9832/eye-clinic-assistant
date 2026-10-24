import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { api, errorText } from '../api/client';
import type { Availability, Ticket } from '../api/types';
import { useApp } from '../app-context';
import { LoginNeeded } from '../components/Layout';
import { TimeText } from '../components/TimeText';
import { daysFrom, todayIn } from '../time/zones';

export function MyAppointmentsPage() {
  const { me } = useApp();
  const appointments = useQuery({
    queryKey: ['my-appointments'],
    queryFn: () => api<Ticket[]>('/me/appointments'),
    enabled: !!me,
  });

  if (me === null) return <LoginNeeded what="see your appointments" />;
  if (!appointments.data) return <p className="text-slate-500">Loading…</p>;

  const now = Date.now();
  const upcoming = appointments.data.filter((a) => a.status === 'BOOKED' && Date.parse(a.start) > now);
  const past = appointments.data.filter((a) => !upcoming.includes(a));

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">My appointments</h1>
      <section className="space-y-3">
        <h2 className="font-medium">Upcoming</h2>
        {upcoming.length === 0 && <p className="text-sm text-slate-500">Nothing booked.</p>}
        {upcoming.map((a) => (
          <AppointmentRow key={a.id} appointment={a} />
        ))}
      </section>
      {past.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Past and cancelled</h2>
          {past.map((a) => (
            <p key={a.id} className="text-sm text-slate-500">
              {a.type.name} · <TimeText iso={a.start} /> · {a.status.toLowerCase()} · {a.reference}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}

function AppointmentRow({ appointment: a }: { appointment: Ticket }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'idle' | 'confirmCancel' | 'reschedule'>('idle');
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['my-appointments'] });
    void queryClient.invalidateQueries({ queryKey: ['availability'] });
  };

  const cancel = useMutation({
    mutationFn: () => api<Ticket>(`/me/appointments/${a.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setMode('idle');
      refresh();
    },
  });

  return (
    <div className="rounded-lg border bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="font-medium">
            {a.type.name}
            {a.doctor && <span className="font-normal text-slate-600"> with {a.doctor.displayName}</span>}
          </p>
          <p>
            <TimeText iso={a.start} />
          </p>
          <p className="font-mono text-sm text-slate-500">{a.reference}</p>
        </div>
        {mode === 'idle' && (
          <div className="flex gap-2 text-sm">
            <button onClick={() => setMode('reschedule')} className="rounded border px-2 py-1">
              Move
            </button>
            <button onClick={() => setMode('confirmCancel')} className="rounded border border-red-200 px-2 py-1 text-red-700">
              Cancel
            </button>
          </div>
        )}
      </div>

      {mode === 'confirmCancel' && (
        <div className="mt-3 flex items-center gap-3 text-sm">
          <span>Cancel this appointment?</span>
          <button onClick={() => cancel.mutate()} disabled={cancel.isPending} className="rounded bg-red-600 px-2 py-1 text-white">
            Yes, cancel it
          </button>
          <button onClick={() => setMode('idle')} className="text-slate-500">
            Keep it
          </button>
        </div>
      )}
      {cancel.error && <p role="alert" className="mt-2 text-sm text-red-700">{errorText(cancel.error)}</p>}
      {mode === 'reschedule' && <Reschedule appointment={a} onDone={() => (setMode('idle'), refresh())} onClose={() => setMode('idle')} />}
    </div>
  );
}

/** Pick a new free time for the same type with the same doctor. */
function Reschedule({ appointment: a, onDone, onClose }: { appointment: Ticket; onDone: () => void; onClose: () => void }) {
  const { clinic } = useApp();
  const days = clinic ? daysFrom(todayIn(clinic.timezone), 14) : [];
  const [day, setDay] = useState(days[1] ?? '');
  const doctorId = clinic?.doctors.find((d) => d.displayName === a.doctor?.displayName)?.id;

  const slots = useQuery({
    queryKey: ['availability', a.type.code, doctorId ?? '', day],
    queryFn: () => api<Availability>(`/availability?${new URLSearchParams({ type: a.type.code, day, ...(doctorId ? { doctorId } : {}) })}`),
    enabled: !!day,
  });
  const move = useMutation({
    mutationFn: (start: string) => api<Ticket>(`/me/appointments/${a.id}/reschedule`, { method: 'POST', body: { start } }),
    onSuccess: onDone,
  });

  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      <label className="text-sm">
        New day
        <select aria-label="New day" value={day} onChange={(e) => setDay(e.target.value)} className="ml-2 rounded border border-slate-300 px-2 py-1">
          {days.map((d) => (
            <option key={d} value={d}>
              {DateTime.fromISO(d).toFormat('ccc d LLL')}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap gap-1.5">
        {slots.data?.slots.length === 0 && <span className="text-sm text-slate-500">No free times that day.</span>}
        {slots.data?.slots.map((s) => (
          <button key={s.start} onClick={() => move.mutate(s.start)} disabled={move.isPending} className="rounded border px-2 py-1 text-sm hover:border-brand-600">
            <TimeText iso={s.start} compact />
          </button>
        ))}
      </div>
      {move.error && <p role="alert" className="text-sm text-red-700">{errorText(move.error)}</p>}
      <button onClick={onClose} className="text-sm text-slate-500">
        Never mind
      </button>
    </div>
  );
}
