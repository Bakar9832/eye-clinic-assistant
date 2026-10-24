import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState, type FormEvent } from 'react';
import { api, ApiError, errorText } from '../api/client';
import { useApp } from '../app-context';
import type { AppointmentTypeWithSteps } from '../pages/CalendarPage';
import { clinicTime, useStaffMe } from './staff-api';

/** A booking an admin change affects. Bookings never move by themselves: staff contact the patient. */
interface Affected {
  reference: string;
  start: string;
  patient: string | null;
  resource: string;
}

export function SettingsPage() {
  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold">Settings</h1>
      <ClinicSettings />
      <AppointmentTypes />
      <WorkingHours />
      <Leave />
      <StaffAccounts />
    </div>
  );
}

function AffectedList({ bookings, title }: { bookings: Affected[]; title: string }) {
  const { clinic } = useApp();
  if (bookings.length === 0) return null;
  return (
    <div role="status" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">
      <p className="font-medium">{title}</p>
      <ul className="list-disc pl-5">
        {bookings.map((b) => (
          <li key={b.reference + b.resource}>
            {b.reference} · {clinic ? clinicTime(b.start, clinic.timezone, 'ccc d LLL HH:mm') : b.start} · {b.patient ?? '(no name)'} · {b.resource}
          </li>
        ))}
      </ul>
    </div>
  );
}

const ZONES: string[] = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

function ClinicSettings() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () =>
      api<{ name: string; timezone: string; slotGridMin: number; offerRecheckAfterNewPrescription: boolean; outcomeEditWindowHours: number }>('/staff/settings'),
  });
  const [changes, setChanges] = useState<Record<string, unknown>>({});
  const save = useMutation({
    mutationFn: () => api<{ bookingsOutsideHours: Affected[] }>('/staff/settings', { method: 'PATCH', body: changes }),
    onSuccess: () => {
      setChanges({});
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['clinic'] });
    },
  });
  if (!settings.data) return null;
  const value = <K extends keyof typeof settings.data>(key: K) => (key in changes ? changes[key] : settings.data![key]) as (typeof settings.data)[K];
  const set = (key: string, v: unknown) => setChanges((c) => ({ ...c, [key]: v }));

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  return (
    <section aria-label="Clinic settings" className="space-y-3">
      <h2 className="font-medium">Clinic</h2>
      <form onSubmit={submit} className="grid max-w-lg gap-2 text-sm">
        <label>
          Name <input aria-label="Clinic name" value={value('name')} onChange={(e) => set('name', e.target.value)} className="ml-2 rounded border border-slate-300 px-2 py-1" />
        </label>
        <label>
          Clinic time zone
          <select aria-label="Clinic time zone" value={value('timezone')} onChange={(e) => set('timezone', e.target.value)} className="ml-2 max-w-60 rounded border border-slate-300 bg-white px-2 py-1">
            {[...new Set([value('timezone'), ...ZONES])].map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </label>
        <label>
          Slot grid
          <select aria-label="Slot grid" value={value('slotGridMin')} onChange={(e) => set('slotGridMin', Number(e.target.value))} className="ml-2 rounded border border-slate-300 bg-white px-2 py-1">
            {[5, 10, 15, 20, 30, 60].map((m) => (
              <option key={m} value={m}>
                every {m} min
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={value('offerRecheckAfterNewPrescription')} onChange={(e) => set('offerRecheckAfterNewPrescription', e.target.checked)} /> Offer a follow-up after a new prescription
        </label>
        <label>
          Outcome edit window (hours)
          <input
            type="number"
            aria-label="Outcome edit window"
            min={1}
            max={720}
            value={value('outcomeEditWindowHours')}
            onChange={(e) => set('outcomeEditWindowHours', Number(e.target.value))}
            className="ml-2 w-20 rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <button disabled={Object.keys(changes).length === 0 || save.isPending} className="w-fit rounded bg-slate-800 px-3 py-1 text-white disabled:opacity-50">
          Save clinic settings
        </button>
      </form>
      {save.error && <p role="alert" className="text-sm text-red-700">{errorText(save.error)}</p>}
      {save.data && <AffectedList bookings={save.data.bookingsOutsideHours} title="These upcoming bookings are now outside working hours. Please contact the patients:" />}
    </section>
  );
}

function AppointmentTypes() {
  const queryClient = useQueryClient();
  const types = useQuery({ queryKey: ['appointment-types'], queryFn: () => api<AppointmentTypeWithSteps[]>('/appointment-types') });
  return (
    <section aria-label="Appointment types" className="space-y-2">
      <h2 className="font-medium">Appointment types</h2>
      <p className="text-sm text-slate-500">Step lengths are calendar time, slack included. Later steps move back automatically. Existing bookings keep their times.</p>
      {types.data?.map((t) => (
        <TypeRow key={t.code} type={t} onSaved={() => queryClient.invalidateQueries({ queryKey: ['appointment-types'] })} />
      ))}
    </section>
  );
}

function TypeRow({ type, onSaved }: { type: AppointmentTypeWithSteps; onSaved: () => void }) {
  const [typicalMin, setTypicalMin] = useState(type.typicalMin);
  const [durations, setDurations] = useState<Record<number, number>>(Object.fromEntries(type.steps.map((s) => [s.position, s.durationMin])));
  const save = useMutation({
    mutationFn: () =>
      api(`/staff/appointment-types/${type.code}`, {
        method: 'PATCH',
        body: {
          typicalMin,
          stepDurations: type.steps.filter((s) => durations[s.position] !== s.durationMin).map((s) => ({ position: s.position, durationMin: durations[s.position] })),
        },
      }),
    onSuccess: onSaved,
  });
  return (
    <form
      aria-label={type.name}
      onSubmit={(e) => (e.preventDefault(), save.mutate())}
      className="flex flex-wrap items-center gap-3 rounded border bg-white p-2 text-sm"
    >
      <span className="w-48 font-medium">{type.name}</span>
      <label>
        told {' '}
        <input type="number" aria-label={`${type.name} patient time`} min={1} max={180} value={typicalMin} onChange={(e) => setTypicalMin(Number(e.target.value))} className="w-16 rounded border border-slate-300 px-1" /> min
      </label>
      {type.steps.map((s) => (
        <label key={s.position}>
          {s.resourceKind.toLowerCase()}{' '}
          <input
            type="number"
            aria-label={`${type.name} step ${s.position}`}
            min={1}
            max={180}
            value={durations[s.position]}
            onChange={(e) => setDurations((d) => ({ ...d, [s.position]: Number(e.target.value) }))}
            className="w-14 rounded border border-slate-300 px-1"
          />
        </label>
      ))}
      <button className="rounded border border-slate-300 px-2">Save</button>
      {save.error && <span role="alert" className="text-red-700">{errorText(save.error)}</span>}
    </form>
  );
}

interface ResourceView {
  id: string;
  kind: string;
  displayName: string;
  workingHours: { weekday: number; start: string; end: string }[];
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function WorkingHours() {
  const queryClient = useQueryClient();
  const resources = useQuery({ queryKey: ['resources'], queryFn: () => api<ResourceView[]>('/staff/resources') });
  const [resourceId, setResourceId] = useState('');
  const [windows, setWindows] = useState<ResourceView['workingHours'] | null>(null);
  const selected = resources.data?.find((r) => r.id === resourceId);
  const shown = windows ?? selected?.workingHours ?? [];

  const save = useMutation({
    mutationFn: () => api<{ bookingsOutsideHours: Affected[] }>(`/staff/resources/${resourceId}/working-hours`, { method: 'PUT', body: { windows: shown } }),
    onSuccess: () => {
      setWindows(null);
      void queryClient.invalidateQueries({ queryKey: ['resources'] });
    },
  });
  const edit = (i: number, patch: Partial<ResourceView['workingHours'][number]>) => setWindows(shown.map((w, j) => (j === i ? { ...w, ...patch } : w)));

  return (
    <section aria-label="Working hours" className="space-y-2">
      <h2 className="font-medium">Working hours</h2>
      <select aria-label="Whose hours" value={resourceId} onChange={(e) => (setResourceId(e.target.value), setWindows(null), save.reset())} className="rounded border border-slate-300 bg-white px-2 py-1 text-sm">
        <option value="">Choose a person or machine…</option>
        {resources.data?.map((r) => (
          <option key={r.id} value={r.id}>
            {r.displayName}
          </option>
        ))}
      </select>
      {selected && (
        <div className="space-y-1 text-sm">
          {shown.map((w, i) => (
            <div key={i} className="flex items-center gap-2">
              <select aria-label={`Window ${i + 1} day`} value={w.weekday} onChange={(e) => edit(i, { weekday: Number(e.target.value) })} className="rounded border border-slate-300 bg-white px-1">
                {WEEKDAYS.map((d, n) => (
                  <option key={d} value={n + 1}>
                    {d}
                  </option>
                ))}
              </select>
              <input type="time" aria-label={`Window ${i + 1} start`} value={w.start} onChange={(e) => edit(i, { start: e.target.value })} className="rounded border border-slate-300 px-1" />
              –
              <input type="time" aria-label={`Window ${i + 1} end`} value={w.end} onChange={(e) => edit(i, { end: e.target.value })} className="rounded border border-slate-300 px-1" />
              <button type="button" onClick={() => setWindows(shown.filter((_, j) => j !== i))} className="text-slate-500">
                remove
              </button>
            </div>
          ))}
          <div className="flex gap-3">
            <button type="button" onClick={() => setWindows([...shown, { weekday: 1, start: '09:00', end: '17:00' }])} className="text-slate-600 underline">
              Add a window
            </button>
            <button onClick={() => save.mutate()} disabled={save.isPending} className="rounded bg-slate-800 px-3 py-1 text-white">
              Save hours
            </button>
          </div>
          {save.error && <p role="alert" className="text-red-700">{errorText(save.error)}</p>}
          {save.data && <AffectedList bookings={save.data.bookingsOutsideHours} title="These upcoming bookings are now outside working hours. Please contact the patients:" />}
        </div>
      )}
    </section>
  );
}

function Leave() {
  const { clinic } = useApp();
  const resources = useQuery({ queryKey: ['resources'], queryFn: () => api<ResourceView[]>('/staff/resources') });
  const [resourceId, setResourceId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [inTheWay, setInTheWay] = useState<Affected[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!clinic) return;
    setInTheWay([]);
    setMessage(null);
    // Whole days in clinic time: from the start of the first day to the end of the last.
    const start = DateTime.fromISO(from, { zone: clinic.timezone }).toISO();
    const end = DateTime.fromISO(to, { zone: clinic.timezone }).plus({ days: 1 }).toISO();
    try {
      await api(`/staff/resources/${resourceId}/time-off`, { method: 'POST', body: { start, end, ...(reason ? { reason } : {}) } });
      setMessage('Leave saved. Those days no longer offer appointments with them.');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'BOOKINGS_IN_THE_WAY') setInTheWay((err.body.bookings as Affected[]) ?? []);
      else setMessage(errorText(err));
    }
  }

  return (
    <section aria-label="Leave" className="space-y-2">
      <h2 className="font-medium">Leave</h2>
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2 text-sm">
        <select aria-label="Who is away" required value={resourceId} onChange={(e) => setResourceId(e.target.value)} className="rounded border border-slate-300 bg-white px-2 py-1">
          <option value="">Who…</option>
          {resources.data?.map((r) => (
            <option key={r.id} value={r.id}>
              {r.displayName}
            </option>
          ))}
        </select>
        <input type="date" aria-label="First day" required value={from} onChange={(e) => setFrom(e.target.value)} className="rounded border border-slate-300 px-1" />
        to
        <input type="date" aria-label="Last day" required value={to} min={from} onChange={(e) => setTo(e.target.value)} className="rounded border border-slate-300 px-1" />
        <input aria-label="Reason" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} className="rounded border border-slate-300 px-2 py-1" />
        <button className="rounded bg-slate-800 px-3 py-1 text-white">Add leave</button>
      </form>
      {message && <p role="status" className="text-sm">{message}</p>}
      <AffectedList bookings={inTheWay} title="Not saved: these appointments need them. Move the patients first:" />
    </section>
  );
}

function StaffAccounts() {
  const queryClient = useQueryClient();
  const me = useStaffMe();
  const users = useQuery({
    queryKey: ['staff-users'],
    queryFn: () => api<{ id: string; email: string; displayName: string; role: string; active: boolean }[]>('/staff/users'),
  });
  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api(`/staff/users/${id}`, { method: 'PATCH', body: { active } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['staff-users'] }),
  });
  return (
    <section aria-label="Staff accounts" className="space-y-2">
      <h2 className="font-medium">Staff accounts</h2>
      <ul className="divide-y rounded border bg-white text-sm">
        {users.data?.map((u) => (
          <li key={u.id} className="flex items-center gap-3 p-2">
            <span className="w-40">{u.displayName}</span>
            <span className="w-56 text-slate-500">{u.email}</span>
            <span className="w-24 text-slate-500">{u.role.toLowerCase()}</span>
            <button
              onClick={() => toggle.mutate({ id: u.id, active: !u.active })}
              disabled={u.id === me?.id}
              title={u.id === me?.id ? "You can't switch off your own account" : undefined}
              className="rounded border border-slate-300 px-2 disabled:opacity-40"
            >
              {u.active ? 'Switch off' : 'Switch on'}
            </button>
          </li>
        ))}
      </ul>
      {toggle.error && <p role="alert" className="text-sm text-red-700">{errorText(toggle.error)}</p>}
    </section>
  );
}
