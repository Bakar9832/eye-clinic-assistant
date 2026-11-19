import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState, type FormEvent } from 'react';
import { api, errorText } from '../api/client';
import { useApp } from '../app-context';
import { todayIn } from '../time/zones';
import { clinicTime, OUTCOME_CODES, OUTCOME_LABELS, useStaffMe, type OutcomeCode, type OutcomeView, type ScheduleItem } from './staff-api';

const NOTE_LIMIT = 500;

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
        <h1 className="text-2xl">Schedule</h1>
        <input type="date" aria-label="Day" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} className="rounded-lg border border-line px-3 py-1.5 bg-white" />
        <span className="text-sm text-slate-500">Times in clinic time ({clinic.timezone})</span>
      </div>

      {schedule.data?.appointments.length === 0 && <p className="rounded-lg border border-dashed border-line p-6 text-center text-ink-muted">No appointments on this day.</p>}
      <ul className="divide-y divide-line rounded-lg border border-line bg-white">
        {schedule.data?.appointments.map((a) => {
          const canRecord = staff?.role === 'DOCTOR' && a.examinedByMe && a.status === 'BOOKED' && Date.parse(a.start) <= now;
          const canCorrect = staff?.role === 'DOCTOR' && a.examinedByMe && a.hasOutcome;
          return (
            <li key={a.id} className="space-y-2 px-4 py-3" aria-label={`${clinicTime(a.start, clinic.timezone)} ${a.patient.fullName ?? ''}`}>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="w-20 font-medium tabular-nums">{clinicTime(a.start, clinic.timezone)}</span>
                <span className="font-medium">{a.patient.fullName ?? '(no name yet)'}</span>
                <span className="text-sm text-slate-600">{a.type.name}</span>
                {a.doctor && <span className="text-sm text-slate-600">{a.doctor}</span>}
                <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${a.status === 'CANCELLED' ? 'bg-slate-100 text-ink-muted' : a.status === 'COMPLETED' ? 'bg-slate-100 text-ink' : 'bg-accent-soft text-accent'}`}>
                  {a.status.toLowerCase()}
                </span>
                <span className="font-mono text-xs text-ink-muted">{a.reference}</span>
                {a.attentionReason && (
                  <span title={a.attentionReason} className="rounded-md border border-red-200 bg-danger-soft px-2 py-0.5 text-xs font-medium text-danger">
                    Attention needed
                  </span>
                )}
              </div>
              {a.attentionReason && <p className="text-sm text-danger">{a.attentionReason}</p>}
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
      <button onClick={() => setOpen(true)} className="rounded-lg border border-line px-3 py-1.5 text-sm bg-white">
        {existing ? 'Correct outcome' : 'Record outcome'}
      </button>
    );
  }
  if (existing && current.data?.editable === false) {
    return (
      <p className="text-sm text-slate-500">
        This outcome can no longer be corrected: the edit window ended {DateTime.fromISO(current.data.editableUntil!).toFormat('d LLL h:mm a')}.
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
    <form onSubmit={submit} aria-label={existing ? 'Correct outcome' : 'Record outcome'} className="space-y-3 rounded-lg border border-line bg-surface p-4">
      <label className="block text-sm">
        Outcome
        <select aria-label="Outcome" required value={shownCode} onChange={(e) => setCode(e.target.value as OutcomeCode)} className="ml-2 rounded-lg border border-line bg-white px-3 py-1.5">
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
          className="mt-1 block w-full rounded-lg border border-line bg-white px-3 py-1.5"
        />
        <span className="text-xs text-slate-500">
          {shownNote.length}/{NOTE_LIMIT}
        </span>
      </label>
      <div className="flex gap-2">
        <button disabled={save.isPending || !shownCode || !shownNote} className="px-3 py-1 text-sm rounded-lg bg-ink font-medium text-white hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400">
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
