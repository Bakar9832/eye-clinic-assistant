import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState, type FormEvent } from 'react';
import { api, ApiError, errorText, type Reason } from '../api/client';
import { useApp } from '../app-context';
import type { AppointmentTypeWithSteps } from '../pages/CalendarPage';
import { clinicTime } from './staff-api';

interface PatientHit {
  id: string;
  fullName: string | null;
  email: string;
}

interface Booked {
  reference: string;
  start: string;
}

export const MIN_REASON = 10;

/**
 * Reception books for a patient (phone calls, the front desk). If the time breaks a soft
 * rule (working hours, the grid), the API lists the warnings; staff confirm with a reason,
 * which is kept in the audit log. Hard rules (double booking, leave, skills) never bend.
 */
export function NewBookingPage() {
  const { clinic } = useApp();
  const [query, setQuery] = useState('');
  const [patient, setPatient] = useState<PatientHit | null>(null);
  const [typeCode, setTypeCode] = useState('ROUTINE_EYE_TEST');
  const [doctorId, setDoctorId] = useState('');
  const [date, setDate] = useState(() => DateTime.now().plus({ days: 1 }).toISODate()!);
  const [time, setTime] = useState('10:00');
  const [warnings, setWarnings] = useState<Reason[] | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<Booked | null>(null);
  const [busy, setBusy] = useState(false);

  const patients = useQuery({
    queryKey: ['patients', query],
    queryFn: () => api<PatientHit[]>(`/staff/patients?query=${encodeURIComponent(query)}`),
    enabled: query.trim().length >= 2 && !patient,
  });
  const types = useQuery({ queryKey: ['appointment-types'], queryFn: () => api<AppointmentTypeWithSteps[]>('/appointment-types') });
  const skill = types.data?.find((t) => t.code === typeCode)?.steps.find((s) => s.resourceKind === 'OPTOMETRIST')?.requiredSkill ?? null;
  const doctors = (clinic?.doctors ?? []).filter((d) => !skill || d.skills.includes(skill));

  if (!clinic) return null;

  // The form's date and time are clinic time; the API gets an exact moment with its offset.
  const start = DateTime.fromISO(`${date}T${time}`, { zone: clinic.timezone }).toISO();

  async function book(withOverride: boolean) {
    if (!patient || !start) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<Booked>('/staff/appointments', {
        method: 'POST',
        body: {
          patientId: patient.id,
          typeCode,
          start,
          ...(doctorId ? { doctorId } : {}),
          ...(withOverride ? { override: { reason } } : {}),
        },
      });
      setBooked(result);
      setWarnings(null);
      setReason('');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'OVERRIDE_REQUIRED') setWarnings(err.reasons);
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setBooked(null);
    setWarnings(null);
    void book(false);
  }

  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-xl font-semibold">New booking</h1>

      <section className="space-y-2">
        <label className="block text-sm">
          Patient
          {patient ? (
            <span className="ml-2">
              <strong>{patient.fullName ?? '(no name)'}</strong> · {patient.email}{' '}
              <button type="button" onClick={() => setPatient(null)} className="text-slate-500 underline">
                change
              </button>
            </span>
          ) : (
            <input
              aria-label="Find patient"
              placeholder="Name or email, at least 2 letters"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
            />
          )}
        </label>
        {!patient && patients.data && (
          <ul className="rounded border bg-white">
            {patients.data.length === 0 && <li className="p-2 text-sm text-slate-500">No patients found.</li>}
            {patients.data.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => setPatient(p)} className="w-full p-2 text-left text-sm hover:bg-slate-50">
                  {p.fullName ?? '(no name)'} · {p.email}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form onSubmit={submit} aria-label="Booking details" className="space-y-3">
        <div className="flex flex-wrap gap-3 text-sm">
          <label>
            Type
            <select aria-label="Appointment type" value={typeCode} onChange={(e) => (setTypeCode(e.target.value), setDoctorId(''))} className="ml-2 rounded border border-slate-300 bg-white px-2 py-1">
              {types.data?.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Doctor
            <select aria-label="Doctor" value={doctorId} onChange={(e) => setDoctorId(e.target.value)} className="ml-2 rounded border border-slate-300 bg-white px-2 py-1">
              <option value="">Any doctor</option>
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Date
            <input type="date" aria-label="Date" required value={date} onChange={(e) => setDate(e.target.value)} className="ml-2 rounded border border-slate-300 px-2 py-1" />
          </label>
          <label>
            Time (clinic)
            <input type="time" aria-label="Time" required value={time} onChange={(e) => setTime(e.target.value)} className="ml-2 rounded border border-slate-300 px-2 py-1" />
          </label>
        </div>
        <button disabled={!patient || busy} className="rounded bg-slate-800 px-3 py-1.5 text-white disabled:opacity-50">
          Book
        </button>
      </form>

      {warnings && (
        <section aria-label="Override needed" className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3">
          <p className="font-medium">This time breaks the usual rules:</p>
          <ul className="list-disc pl-5 text-sm">
            {warnings.map((w) => (
              <li key={w.message}>{w.message}</li>
            ))}
          </ul>
          <label className="block text-sm">
            Reason for booking anyway (kept in the audit log)
            <textarea aria-label="Reason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 block w-full rounded border border-slate-300 bg-white px-2 py-1" />
          </label>
          <button onClick={() => void book(true)} disabled={busy || reason.trim().length < MIN_REASON} className="rounded bg-amber-600 px-3 py-1 text-sm text-white disabled:opacity-50">
            Book anyway
          </button>
        </section>
      )}

      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {booked && (
        <p className="rounded bg-emerald-50 p-3 text-emerald-800">
          Booked {booked.reference} for {clinicTime(booked.start, clinic.timezone, 'ccc d LLL HH:mm')} (clinic time).
        </p>
      )}
    </div>
  );
}
