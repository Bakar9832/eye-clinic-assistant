import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, errorText } from '../api/client';
import type { AppointmentType, Availability, Ticket } from '../api/types';
import { useApp } from '../app-context';
import { TicketCard } from '../components/cards';
import { ProfileForm } from '../components/ProfileForm';
import { TimeText } from '../components/TimeText';
import { daysFrom, todayIn } from '../time/zones';
import { DoctorPicker, PrepNote, Step, TimeGrid, TimeGridSkeleton, VisitTypePicker, WeekStrip, type DayInfo, type Slot } from './book/parts';

const DEFAULT_TYPE = 'ROUTINE_EYE_TEST';
// Disabled: dark grey on light grey (7.2:1), readable for this audience, not just faded.
const primary = 'min-h-12 rounded-lg bg-ink px-6 font-semibold text-white hover:bg-slate-800 disabled:bg-slate-100 disabled:text-ink-muted';

/**
 * Book: one decision at a time (visit, doctor, day, time), then Confirm. The choice lives
 * in the address (?type, doctor, day, start, slotDoctor), so "Log in to confirm" brings the
 * patient back to the same choice. Free times only; booking needs a login.
 */
export function CalendarPage() {
  const { clinic, me } = useApp();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const types = useQuery({ queryKey: ['appointment-types'], queryFn: () => api<AppointmentTypeWithSteps[]>('/appointment-types') });
  const [booked, setBooked] = useState<Ticket | null>(null);

  const typeCode = params.get('type') ?? DEFAULT_TYPE;
  const doctorId = params.get('doctor') ?? '';
  const today = clinic ? todayIn(clinic.timezone) : null;
  const dayParam = params.get('day');
  // The week the chosen day is in (e.g. back from login), else this week. Worked out once
  // the clinic's "today" is known.
  const [week, setWeek] = useState(0);
  const [weekFromAddress, setWeekFromAddress] = useState(false);
  useEffect(() => {
    if (!today || weekFromAddress) return;
    setWeekFromAddress(true);
    if (dayParam) setWeek(Math.max(0, Math.floor(DateTime.fromISO(dayParam).diff(DateTime.fromISO(today), 'days').days / 7)));
  }, [today, dayParam, weekFromAddress]);

  /** Changes the choice in the address (replace: no new history entry per tap). */
  const choose = (change: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(change)) {
          if (value === null || value === '') next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );

  // Urgent visits are arranged by staff: patients can't book them, so they aren't offered.
  const visitTypes = (types.data ?? []).filter((t) => !t.isUrgent);
  const type = types.data?.find((t) => t.code === typeCode);
  // Only doctors who can do this kind of visit (e.g. only Dr Ayesha sees children).
  const skill = type?.steps.find((s) => s.resourceKind === 'OPTOMETRIST')?.requiredSkill ?? null;
  const doctors = (clinic?.doctors ?? []).filter((d) => !skill || d.skills.includes(skill));

  const dates = today ? daysFrom(DateTime.fromISO(today).plus({ weeks: week }).toISODate()!, 7) : [];
  const availability = useQueries({
    queries: dates.map((day) => ({
      queryKey: ['availability', typeCode, doctorId, day],
      queryFn: () => api<Availability>(`/availability?${new URLSearchParams({ type: typeCode, day, ...(doctorId ? { doctorId } : {}) })}`),
    })),
  });
  const days: DayInfo[] = dates.map((day, i) => {
    const d = DateTime.fromISO(day);
    const result = availability[i];
    const offset = today ? d.diff(DateTime.fromISO(today), 'days').days : -1;
    return {
      day,
      weekday: d.toFormat('ccc'),
      date: d.toFormat('d'),
      month: d.toFormat('LLL'),
      fullName: d.toFormat('cccc d LLLL'),
      relative: offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : null,
      status: result?.isPending ? 'loading' : result?.isError ? 'error' : 'ready',
      slots: result?.data?.slots ?? [],
    };
  });

  // The chosen day, or the first day with free times.
  const withTimes = days.filter((d) => d.status === 'ready' && d.slots.length > 0);
  const selectedDay = withTimes.find((d) => d.day === dayParam) ?? withTimes[0] ?? null;
  const slots = selectedDay?.slots ?? [];
  const sameSlot = (a: Slot, start: string | null, doctor: string | null) => a.start === start && (a.doctor?.id ?? null) === (doctor || null);
  const chosen = slots.find((s) => sameSlot(s, params.get('start'), params.get('slotDoctor'))) ?? null;
  const soonest = withTimes[0]?.slots[0] ?? null;
  const loadingWeek = days.length === 0 || days.some((d) => d.status === 'loading');
  const failedDays = days.filter((d) => d.status === 'error');
  const emptyWeek = days.length > 0 && days.every((d) => d.status === 'ready' && d.slots.length === 0);
  const retryFailed = () => availability.forEach((q) => q.isError && void q.refetch());
  /** Earlier/Later: a new week starts with no day or time chosen (its first free day is picked). */
  const moveWeek = (by: number) => {
    setWeek((w) => Math.max(0, w + by));
    choose({ day: null, start: null, slotDoctor: null });
  };

  const hourOf = (slot: Slot) => (clinic ? DateTime.fromISO(slot.start, { zone: clinic.timezone }).hour : 0);
  const morning = slots.filter((s) => hourOf(s) < 12);
  const afternoon = slots.filter((s) => hourOf(s) >= 12);

  const pick = (slot: Slot, day: string) => {
    setBooked(null);
    choose({ day, start: slot.start, slotDoctor: slot.doctor?.id ?? null });
  };

  const book = useMutation({
    mutationFn: (slot: Slot) =>
      api<Ticket>('/me/appointments', {
        method: 'POST',
        body: { typeCode, start: slot.start, ...(slot.doctor ? { doctorId: slot.doctor.id } : {}) },
      }),
    onSuccess: (ticket) => {
      setBooked(ticket);
      choose({ start: null, slotDoctor: null });
      void queryClient.invalidateQueries({ queryKey: ['availability'] });
      void queryClient.invalidateQueries({ queryKey: ['my-appointments'] });
    },
  });

  const loginTo = `/login?next=${encodeURIComponent(`/calendar?${params.toString()}`)}`;
  const needsDetails = Boolean(me && !me.profileComplete);

  return (
    <div className="space-y-10 pb-4 text-[1.125rem]">
      <header className="space-y-1">
        <h1 className="text-3xl">Book an appointment</h1>
        <p className="text-ink-muted">Pick a visit, a day and a time.</p>
      </header>

      {booked && (
        <div className="space-y-2">
          <p className="font-semibold text-success">You're booked.</p>
          <TicketCard card={{ type: 'ticket', reference: booked.reference, start: booked.start, doctor: booked.doctor?.displayName ?? null, prepInstructions: booked.prepInstructions }} />
        </div>
      )}

      <Step id="step-visit" number={1} title="What do you need?">
        <VisitTypePicker types={visitTypes} value={typeCode} onChange={(code) => choose({ type: code, doctor: null, start: null, slotDoctor: null })} />
        <DoctorPicker doctors={doctors} value={doctorId} onChange={(id) => choose({ doctor: id, start: null, slotDoctor: null })} />
      </Step>

      {soonest && withTimes[0] && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border-2 border-ink p-5">
          <p>
            <span className="font-semibold">Soonest available: </span>
            <TimeText iso={soonest.start} />
            {soonest.doctor && ` with ${soonest.doctor.displayName}`}
          </p>
          <button type="button" onClick={() => pick(soonest, withTimes[0].day)} className={primary}>
            Choose this time
          </button>
        </div>
      )}

      <Step id="step-day" number={2} title="Pick a day">
        <WeekStrip
          days={days}
          selected={selectedDay?.day ?? null}
          onSelect={(day) => choose({ day, start: null, slotDoctor: null })}
          canGoEarlier={week > 0}
          onEarlier={() => moveWeek(-1)}
          onLater={() => moveWeek(1)}
        />
        {failedDays.length > 0 && (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-danger-soft p-4 text-red-900">
            <span>We couldn't load the free times for {failedDays.length === 1 ? failedDays[0].fullName : `${failedDays.length} days`}.</span>
            <button type="button" onClick={retryFailed} className="min-h-12 rounded-lg border-2 border-red-300 bg-white px-5 font-semibold text-red-900">
              Retry
            </button>
          </div>
        )}
        {emptyWeek && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-line p-5">
            <span>No free times this week, try later.</span>
            <button type="button" onClick={() => moveWeek(1)} className={primary}>
              Later
            </button>
          </div>
        )}
      </Step>

      <Step id="step-time" number={3} title="Pick a time">
        {selectedDay ? (
          <>
            <p className="text-ink-muted">{selectedDay.fullName}. Times are in clinic time.</p>
            <TimeGrid morning={morning} afternoon={afternoon} isSelected={(s) => chosen === s} onSelect={(s) => pick(s, selectedDay.day)} />
          </>
        ) : loadingWeek ? (
          <TimeGridSkeleton />
        ) : (
          <p className="text-ink-muted">{emptyWeek ? 'No free times this week. Use Later to see the next week.' : 'Pick a day with free times first.'}</p>
        )}
      </Step>

      {chosen && type && <PrepNote text={type.prepInstructions} />}
      {chosen && needsDetails && <ProfileForm />}

      {/* -bottom-6 + extra bottom padding: covers the page area's own padding, so nothing shows beneath the bar. */}
      <div className="sticky -bottom-6 z-10 -mx-1 flex flex-wrap items-center justify-between gap-4 rounded-t-lg border-2 border-b-0 border-ink bg-white px-5 pt-4 pb-10">
        <p aria-live="polite" className="min-w-0">
          {chosen && type ? (
            <>
              <span className="font-semibold">{type.name}</span>, <TimeText iso={chosen.start} />
              {chosen.doctor && `, with ${chosen.doctor.displayName}`}
            </>
          ) : (
            <span className="text-ink-muted">Choose a time to continue. The button below works once you have.</span>
          )}
        </p>
        {me === null ? (
          <Link to={loginTo} aria-disabled={!chosen} className={`${primary} inline-flex w-full items-center justify-center sm:w-auto ${chosen ? '' : 'pointer-events-none bg-slate-100 text-ink-muted'}`}>
            Log in to confirm
          </Link>
        ) : needsDetails ? (
          <span className="text-ink-muted">Add your details above to confirm.</span>
        ) : (
          <button type="button" onClick={() => chosen && book.mutate(chosen)} disabled={!chosen || book.isPending || me === undefined} className={`${primary} w-full sm:w-auto`}>
            Confirm booking
          </button>
        )}
        {book.error && (
          <p role="alert" className="w-full text-red-800">
            {errorText(book.error)}
          </p>
        )}
      </div>
    </div>
  );
}

export type AppointmentTypeWithSteps = AppointmentType & {
  steps: { position: number; resourceKind: string; requiredSkill: string | null; offsetMin: number; durationMin: number }[];
};
