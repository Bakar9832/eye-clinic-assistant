import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorText } from '../api/client';
import { useApp } from '../app-context';
import { clinicTime } from './staff-api';

interface WaitingGlasses {
  appointmentId: string;
  reference: string;
  patient: { fullName: string | null };
  examDate: string;
  doctor: string;
}

/**
 * New prescriptions whose glasses haven't arrived yet. "Ready" emails the patient once
 * and can't be undone, so the button asks first.
 */
export function GlassesPage() {
  const { clinic } = useApp();
  const queryClient = useQueryClient();
  const waiting = useQuery({ queryKey: ['glasses'], queryFn: () => api<WaitingGlasses[]>('/staff/glasses') });
  const ready = useMutation({
    mutationFn: (appointmentId: string) => api(`/staff/appointments/${appointmentId}/glasses-ready`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['glasses'] }),
  });

  function markReady(g: WaitingGlasses) {
    const name = g.patient.fullName ?? 'this patient';
    if (window.confirm(`Email ${name} that their glasses are ready? This can't be undone.`)) ready.mutate(g.appointmentId);
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Glasses</h1>
      <p className="text-sm text-slate-500">New prescriptions waiting for their glasses, longest-waiting first.</p>
      {waiting.data?.length === 0 && <p className="text-slate-500">No glasses waiting.</p>}
      <ul className="space-y-2">
        {waiting.data?.map((g) => (
          <li key={g.appointmentId} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border bg-white p-3">
            <span className="font-medium">{g.patient.fullName ?? '(no name)'}</span>
            <span className="text-sm text-slate-500">
              Exam {clinic ? clinicTime(g.examDate, clinic.timezone, 'd LLL yyyy') : ''} · {g.doctor} · {g.reference}
            </span>
            <button
              onClick={() => markReady(g)}
              disabled={ready.isPending}
              className="ml-auto rounded border border-slate-300 px-2 py-0.5 text-sm"
            >
              Glasses ready
            </button>
          </li>
        ))}
      </ul>
      {ready.error && <p role="alert" className="text-sm text-red-700">{errorText(ready.error)}</p>}
    </div>
  );
}
