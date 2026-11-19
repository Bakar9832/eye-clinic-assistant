import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorText } from '../api/client';
import { useApp } from '../app-context';
import { clinicTime } from './staff-api';

interface Handoff {
  id: string;
  reason: string;
  kind: 'HANDOFF' | 'CALLBACK' | 'URGENT';
  preferredTime: string | null;
  status: 'OPEN' | 'CLOSED';
  createdAt: string;
  conversationId: string | null;
  patient: { fullName: string | null; email: string } | null;
}

const KIND = {
  URGENT: { label: 'Urgent', style: 'bg-red-600 text-white' },
  CALLBACK: { label: 'Call back', style: 'bg-sky-100 text-sky-800' },
  HANDOFF: { label: 'Question', style: 'bg-slate-100 text-slate-700' },
} as const;

/** What needs a person: urgent symptoms (first), call-back requests, and questions the assistant passed on. */
export function HandoffsPage() {
  const { clinic } = useApp();
  const queryClient = useQueryClient();
  const handoffs = useQuery({ queryKey: ['handoffs'], queryFn: () => api<Handoff[]>('/staff/handoffs') });
  const close = useMutation({
    mutationFn: (id: string) => api(`/staff/handoffs/${id}/close`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['handoffs'] }),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Handoffs</h1>
      {handoffs.data?.length === 0 && <p className="text-slate-500">Nothing waiting.</p>}
      <ul className="space-y-2">
        {handoffs.data?.map((h) => (
          <li key={h.id} aria-label={`${KIND[h.kind].label} ${h.patient?.fullName ?? 'Guest'}`} className={`rounded-lg border bg-white p-3 ${h.kind === 'URGENT' ? 'border-red-300' : ''}`}>
            <div className="flex flex-wrap items-baseline gap-x-3 text-sm text-slate-500">
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${KIND[h.kind].style}`}>{KIND[h.kind].label}</span>
              <span>{clinic ? clinicTime(h.createdAt, clinic.timezone, 'ccc d LLL h:mm a') : ''}</span>
              <span>{h.patient ? `${h.patient.fullName ?? '(no name)'} · ${h.patient.email}` : 'Guest (not logged in)'}</span>
            </div>
            <p className="my-1">{h.reason}</p>
            {h.preferredTime && <p className="mb-1 text-sm text-slate-600">Best time to call: {h.preferredTime}</p>}
            <button onClick={() => close.mutate(h.id)} disabled={close.isPending} className="rounded border border-slate-300 px-2 py-0.5 text-sm">
              Mark as handled
            </button>
          </li>
        ))}
      </ul>
      {close.error && <p role="alert" className="text-sm text-red-700">{errorText(close.error)}</p>}
    </div>
  );
}
