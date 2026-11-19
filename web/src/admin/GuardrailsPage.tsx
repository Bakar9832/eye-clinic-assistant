import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import { useApp } from '../app-context';
import { clinicTime } from './staff-api';

type Kind = 'BLOCKED' | 'URGENT_SYMPTOMS' | 'URGENCY_CLAIM' | 'STALLED' | 'CHAT_CAP';

export interface GuardrailEvent {
  id: string;
  kind: Kind;
  action: string;
  reasonCode: string;
  message: string;
  createdAt: string;
  conversationId: string | null;
  patient: { fullName: string | null; email: string } | null;
  repeated: boolean;
}

const KINDS: Record<Kind, { label: string; style: string }> = {
  BLOCKED: { label: 'Blocked', style: 'bg-slate-100 text-slate-700' },
  URGENT_SYMPTOMS: { label: 'Urgent symptoms', style: 'bg-red-100 text-red-800' },
  URGENCY_CLAIM: { label: 'Urgency claim', style: 'bg-amber-100 text-amber-900' },
  STALLED: { label: 'Stalled chat', style: 'bg-sky-100 text-sky-800' },
  CHAT_CAP: { label: 'Daily chat cap', style: 'bg-violet-100 text-violet-800' },
};

/** What the guardrails stopped or flagged: refused bookings, urgent symptoms, urgency claims, stalled chats. */
export function GuardrailsPage() {
  const { clinic } = useApp();
  const [kind, setKind] = useState<Kind | ''>('');
  const events = useQuery({
    queryKey: ['guardrails', kind],
    queryFn: () => api<GuardrailEvent[]>(`/staff/guardrails${kind ? `?kind=${kind}` : ''}`),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl">Guardrails</h1>
        <label className="text-sm">
          Show{' '}
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind | '')} className="ml-1 rounded-lg border border-line px-3 py-1.5 bg-white">
            <option value="">Everything</option>
            {(Object.keys(KINDS) as Kind[]).map((k) => (
              <option key={k} value={k}>
                {KINDS[k].label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-sm text-slate-600">Refused or blocked patient actions and other flags, newest first.</p>
      {events.data?.length === 0 && <p className="rounded-lg border border-dashed border-line p-6 text-center text-ink-muted">Nothing logged. Refused bookings and flags will appear here.</p>}
      <ul className="space-y-2">
        {events.data?.map((e) => (
          <li key={e.id} aria-label={`${KINDS[e.kind].label} ${e.patient?.fullName ?? 'Guest'}`} className="rounded-lg border border-line bg-white p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className={`rounded-md px-2 py-0.5 font-medium ${KINDS[e.kind].style}`}>{KINDS[e.kind].label}</span>
              {e.repeated && <span className="rounded bg-amber-600 px-2 py-0.5 font-medium text-white">Repeated</span>}
              <span className="text-slate-500">{clinic ? clinicTime(e.createdAt, clinic.timezone, 'ccc d LLL h:mm a') : ''}</span>
              <span className="text-slate-700">
                {e.patient ? `${e.patient.fullName ?? '(no name)'} · ${e.patient.email}` : 'Guest (not logged in)'}
              </span>
              <span className="font-mono text-xs text-slate-500">
                {e.action} · {e.reasonCode}
              </span>
            </div>
            <p className="mt-1 text-slate-800">{e.message}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
