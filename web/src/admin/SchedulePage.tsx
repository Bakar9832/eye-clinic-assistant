import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState, type FormEvent } from 'react';
import { api, errorText } from '../api/client';
import { useApp } from '../app-context';
import { todayIn } from '../time/zones';
import { clinicTime, OUTCOME_CODES, OUTCOME_LABELS, useStaffMe, type OutcomeCode, type OutcomeView, type ScheduleItem } from './staff-api';

export const NOTE_LIMIT = 500;

/** The clinic's day, in clinic time. Doctors record outcomes for their own exams from here. */
export function SchedulePage() {
  const { clinic } = useApp();
  const staff = useStaffMe();
  const [day, setDay] = useState(() => (clinic ? todayIn(clinic.timezone) : DateTime.now().toISODate()!));
  const schedule = useQuery({
    queryKey: ['schedule', day],
    queryFn: () => api<{ appointments: ScheduleItem[] }>(`/staff/schedule?day=${day}`),
  });

  if (!clinic) return null;
  const now = Date.now();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Schedule</h1>
        <input type="date" aria-label="Day" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} className="rounded border border-slate-300 px-2 py-1" />
        <span className="text-sm text-slate-500">Times in clinic time ({clinic.timezone})</span>
      </div>

      {schedule.data?.appointments.length === 0 && <p className="text-slate-500">No appointments on this day.</p>}
      <ul className="divide-y rounded-lg border bg-white">
        {schedule.data?.appointments.map((a) => {
          const canRecord = staff?.role === 'DOCTOR' && a.examinedByMe && a.status === 'BOOKED' && Date.parse(a.start) <= now;
          const canCorrect = staff?.role === 'DOCTOR' && a.examinedByMe && a.hasOutcome;
          return (
            <li key={a.id} className="space-y-2 p-3" aria-label={`${clinicTime(a.start, clinic.timezone)} ${a.patient.fullName ?? ''}`}>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="font-mono">{clinicTime(a.start, clinic.timezone)}</span>
                <span className="font-medium">{a.patient.fullName ?? '(no name yet)'}</span>
                <span className="text-sm text-slate-600">{a.type.name}</span>
                {a.doctor && <span className="text-sm text-slate-600">{a.doctor}</span>}
                <span className={`rounded px-1.5 text-xs ${a.status === 'CANCELLED' ? 'bg-slate-100 text-slate-500' : a.status === 'COMPLETED' ? 'bg-emerald-50 text-emerald-700' : 'bg-sky-50 text-sky-700'}`}>
                  {a.status.toLowerCase()}
                </span>
                <span className="font-mono text-xs text-slate-400">{a.reference}</span>
              </div>
              {canRecord && <OutcomeEditor appointmentId={a.id} day={day} />}
              {canCorrect && <OutcomeEditor appointmentId={a.id} day={day} existing />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Record (POST) or correct (PUT) an outcome. The note is sent exactly as typed. */
function OutcomeEditor({ appointmentId, day, existing = false }: { appointmentId: string; day: string; existing?: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const current = useQuery({
    queryKey: ['outcome', appointmentId],
    queryFn: () => api<OutcomeView>(`/staff/appointments/${appointmentId}/outcome`),
    enabled: existing && open,
  });
  const [code, setCode] = useState<OutcomeCode | ''>('');
  const [note, setNote] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api<OutcomeView>(`/staff/appointments/${appointmentId}/outcome`, {
        method: existing ? 'PUT' : 'POST',
        body: { code: code || current.data?.code, patientNote: note ?? current.data?.patientNote ?? '' },
      }),
    onSuccess: () => {
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['schedule', day] });
      void queryClient.invalidateQueries({ queryKey: ['outcome', appointmentId] });
    },
  });

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded border border-slate-300 px-2 py-1 text-sm">
        {existing ? 'Correct outcome' : 'Record outcome'}
      </button>
    );
  }
  if (existing && current.data?.editable === false) {
    return (
      <p className="text-sm text-slate-500">
        This outcome can no longer be corrected: the edit window ended {DateTime.fromISO(current.data.editableUntil!).toFormat('d LLL HH:mm')}.
      </p>
    );
  }

  const shownCode = code || current.data?.code || '';
  const shownNote = note ?? current.data?.patientNote ?? '';

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  return (
    <form onSubmit={submit} aria-label={existing ? 'Correct outcome' : 'Record outcome'} className="space-y-2 rounded bg-slate-50 p-3">
      <label className="block text-sm">
        Outcome
        <select aria-label="Outcome" required value={shownCode} onChange={(e) => setCode(e.target.value as OutcomeCode)} className="ml-2 rounded border border-slate-300 bg-white px-2 py-1">
          <option value="" disabled>
            Choose…
          </option>
          {OUTCOME_CODES.map((c) => (
            <option key={c} value={c}>
              {OUTCOME_LABELS[c]}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        Note for the patient (shown to them word for word)
        <textarea
          aria-label="Note for the patient"
          required
          maxLength={NOTE_LIMIT}
          rows={3}
          value={shownNote}
          onChange={(e) => setNote(e.target.value)}
          className="mt-1 block w-full rounded border border-slate-300 bg-white px-2 py-1"
        />
        <span className="text-xs text-slate-500">
          {shownNote.length}/{NOTE_LIMIT}
        </span>
      </label>
      <div className="flex gap-2">
        <button disabled={save.isPending || !shownCode || !shownNote} className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:opacity-50">
          {existing ? 'Save correction' : 'Save outcome'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-slate-500">
          Close
        </button>
      </div>
      {save.error && <p role="alert" className="text-sm text-red-700">{errorText(save.error)}</p>}
    </form>
  );
}
