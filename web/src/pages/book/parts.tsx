// The pieces of the Book page, designed for patients aged 55 and over: one decision at a
// time, plain words, text at least 18 px, targets at least 48 px with 8 px gaps, nothing
// that depends on hover, and the selected state shown by a check icon and a filled
// background as well as colour (plus aria-pressed).

import { Check, ChevronLeft, ChevronRight, Info } from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { TimeText } from '../../components/TimeText';
import type { Availability } from '../../api/types';

export type Slot = Availability['slots'][number];

/** Plain one-line descriptions. The API has names and durations, not descriptions. */
const DESCRIPTIONS: Record<string, string> = {
  ROUTINE_EYE_TEST: 'A full check of your eyesight and eye health.',
  ROUTINE_EYE_TEST_WITH_SCAN: 'A full eye check plus a scan of the back of the eye.',
  FOLLOW_UP: 'A short visit to check on something from an earlier visit.',
  DOCTOR_CALL: 'A phone or video call with a doctor.',
  SCAN_ONLY: 'A scan of the back of the eye, no full check.',
  CONTACT_LENS_FITTING: 'Fitting and trying contact lenses.',
  CHILD_EYE_EXAM: 'An eye check for a child, with a parent present.',
  FAMILY_CHECK_UP: 'One longer visit for up to 3 family members.',
};
export const describeVisit = (code: string) => DESCRIPTIONS[code] ?? '';

/** A step's heading and its content. */
export function Step({ id, number, title, children }: { id: string; number: number; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-4">
      <h2 id={id} className="flex items-center gap-3 text-xl">
        <span aria-hidden className="grid size-9 place-items-center rounded-full bg-ink font-semibold text-white">
          {number}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A large selectable button: filled background, a check icon and aria-pressed when chosen. */
export function Choice({
  selected,
  onSelect,
  disabled,
  children,
  label,
  className = '',
  tabIndex,
}: {
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
  children: ReactNode;
  label?: string;
  className?: string;
  /** For a roving tab stop: -1 for every button in a group except the current one. */
  tabIndex?: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      tabIndex={tabIndex}
      disabled={disabled}
      onClick={onSelect}
      className={`relative min-h-12 rounded-lg border-2 px-4 py-3 text-left ${
        selected ? 'border-ink bg-ink text-white' : 'border-line bg-white text-ink'
      } disabled:cursor-not-allowed disabled:border-line disabled:bg-surface disabled:text-ink-muted ${className}`}
    >
      {selected && <Check aria-hidden className="absolute top-3 right-3 size-5" strokeWidth={3} />}
      {children}
    </button>
  );
}

/**
 * Arrow keys (and Home/End) move focus between the enabled buttons of a group, so a
 * keyboard user doesn't have to Tab through every day or time; the group is one Tab stop.
 */
export function arrowKeys(event: KeyboardEvent<HTMLElement>) {
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (current === -1 || buttons.length === 0) return;
  event.preventDefault();
  const next =
    event.key === 'Home' ? 0
    : event.key === 'End' ? buttons.length - 1
    : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? Math.max(0, current - 1)
    : Math.min(buttons.length - 1, current + 1);
  buttons[next].focus();
}

/** Which button of a group takes the Tab stop: the selected one, else the first enabled one. */
function tabStop<T>(items: T[], isSelected: (item: T) => boolean, isEnabled: (item: T) => boolean) {
  return items.find((i) => isSelected(i) && isEnabled(i)) ?? items.find(isEnabled);
}

export interface VisitType {
  code: string;
  name: string;
  typicalMin: number;
}

export function VisitTypePicker({ types, value, onChange }: { types: VisitType[]; value: string; onChange: (code: string) => void }) {
  return (
    <div role="group" aria-label="Type of visit" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {types.map((t) => {
        const selected = t.code === value;
        return (
          <Choice key={t.code} selected={selected} onSelect={() => onChange(t.code)} className="pr-11">
            <span className="block font-semibold">{t.name}</span>
            <span className={`mt-1 block ${selected ? 'text-slate-200' : 'text-ink-muted'}`}>{describeVisit(t.code)}</span>
            <span className={`mt-1 block ${selected ? 'text-slate-200' : 'text-ink-muted'}`}>About {t.typicalMin} minutes</span>
          </Choice>
        );
      })}
    </div>
  );
}

export function DoctorPicker({
  doctors,
  value,
  onChange,
}: {
  doctors: { id: string; displayName: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="space-y-2">
      <p id="doctor-label" className="font-medium">
        Doctor
      </p>
      <div role="group" aria-labelledby="doctor-label" className="flex flex-wrap gap-2">
        <Choice selected={value === ''} onSelect={() => onChange('')} className="pr-11">
          Any doctor (soonest)
        </Choice>
        {doctors.map((d) => (
          <Choice key={d.id} selected={value === d.id} onSelect={() => onChange(d.id)} className="pr-11">
            {d.displayName}
          </Choice>
        ))}
      </div>
    </div>
  );
}

export interface DayInfo {
  day: string; // YYYY-MM-DD
  weekday: string; // "Fri"
  date: string; // "20"
  month: string; // "Nov"
  fullName: string; // "Friday 20 November"
  relative: 'Today' | 'Tomorrow' | null;
  status: 'loading' | 'error' | 'ready';
  slots: Slot[];
}

export function WeekStrip({
  days,
  selected,
  onSelect,
  onEarlier,
  onLater,
  canGoEarlier,
}: {
  days: DayInfo[];
  selected: string | null;
  onSelect: (day: string) => void;
  onEarlier: () => void;
  onLater: () => void;
  canGoEarlier: boolean;
}) {
  return (
    // Code order = visual order (Earlier, days, Later), so Tab follows what you see: at the
    // sides on wider screens, above and below the days (full width) on phones.
    <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
      <button
        type="button"
        onClick={onEarlier}
        disabled={!canGoEarlier}
        className="flex min-h-12 shrink-0 items-center justify-center gap-1 rounded-lg border-2 border-line px-3 text-ink sm:flex-col disabled:cursor-not-allowed disabled:bg-surface disabled:text-ink-muted"
      >
        <ChevronLeft aria-hidden className="size-5 max-sm:rotate-90" />
        <span>Earlier</span>
      </button>
      <div role="group" aria-label="Pick a day" onKeyDown={arrowKeys} className="grid min-w-0 flex-1 grid-cols-4 gap-2 sm:grid-cols-7">
        {days.map((d) => {
          const enabled = (x: DayInfo) => x.status === 'ready' && x.slots.length > 0;
          const stop = tabStop(days, (x) => x.day === selected, enabled);
          const free = d.slots.length;
          const empty = d.status === 'ready' && free === 0;
          const label = `${d.fullName}${d.relative ? ` (${d.relative.toLowerCase()})` : ''}, ${
            d.status === 'loading' ? 'loading' : empty ? 'no times' : `${free} free time${free === 1 ? '' : 's'}`
          }`;
          return (
            <Choice
              key={d.day}
              label={label}
              selected={selected === d.day}
              disabled={!enabled(d)}
              tabIndex={stop?.day === d.day ? 0 : -1}
              onSelect={() => onSelect(d.day)}
              className="flex flex-col items-center justify-center gap-0.5 px-1 py-2 text-center"
            >
              <span>{d.relative ?? d.weekday}</span>
              <span className="text-2xl leading-none font-semibold tabular-nums">{d.date}</span>
              <span>{d.month}</span>
              {empty && <span>No times</span>}
              {d.status === 'loading' && <span aria-hidden className="mt-1 h-3 w-10 animate-pulse rounded bg-slate-200" />}
              {d.status === 'error' && <span>Not loaded</span>}
            </Choice>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onLater}
        className="flex min-h-12 shrink-0 items-center justify-center gap-1 rounded-lg border-2 border-line px-3 text-ink sm:flex-col"
      >
        <span className="sm:order-last">Later</span>
        <ChevronRight aria-hidden className="size-5 max-sm:rotate-90" />
      </button>
    </div>
  );
}

export function TimeGrid({
  morning,
  afternoon,
  isSelected,
  onSelect,
}: {
  morning: Slot[];
  afternoon: Slot[];
  isSelected: (slot: Slot) => boolean;
  onSelect: (slot: Slot) => void;
}) {
  const all = [...morning, ...afternoon];
  const stop = tabStop(all, isSelected, () => true);
  const group = (title: string, slots: Slot[]) =>
    slots.length > 0 && (
      <div className="space-y-2">
        <h3 className="text-lg">{title}</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {slots.map((slot) => (
            <Choice
              key={slot.start + (slot.doctor?.id ?? '')}
              selected={isSelected(slot)}
              onSelect={() => onSelect(slot)}
              tabIndex={slot === stop ? 0 : -1}
              className="pr-10 text-lg"
            >
              <TimeText iso={slot.start} compact large />
              {slot.doctor && <span className={`block ${isSelected(slot) ? 'text-slate-200' : 'text-ink-muted'}`}>{slot.doctor.displayName}</span>}
            </Choice>
          ))}
        </div>
      </div>
    );
  return (
    <div className="space-y-5" onKeyDown={arrowKeys}>
      {group('Morning', morning)}
      {group('Afternoon', afternoon)}
    </div>
  );
}

/** The preparation reminder: calm, with an icon, shown once a time is chosen. */
export function PrepNote({ text }: { text: string }) {
  return (
    <div role="note" className="flex gap-3 rounded-lg border border-line bg-surface p-4">
      <Info aria-hidden className="mt-0.5 size-6 shrink-0 text-accent" />
      <div>
        <p className="font-medium">Before your visit</p>
        <p className="text-ink-muted">{text}</p>
      </div>
    </div>
  );
}

/** Placeholder time buttons while the day's free times load. */
export function TimeGridSkeleton() {
  return (
    <div aria-busy="true" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      <span className="sr-only">Loading free times…</span>
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} aria-hidden className="h-16 animate-pulse rounded-lg bg-slate-100" />
      ))}
    </div>
  );
}
