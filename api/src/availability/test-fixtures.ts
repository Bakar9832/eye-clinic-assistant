// Test data for the availability functions: the same people, hours and skills as
// prisma/seed.ts, with readable ids. Each clinic() call returns a fresh copy, so a test
// can add busy times or leave without affecting other tests.

import { DateTime } from 'luxon';
import type { Interval, Slot, SlotResource, SlotStep, WorkingWindow } from './types.js';

export const KARACHI = 'Asia/Karachi';

// Week of the seeded booking. 2026-10-26 is a Monday.
export const MON = '2026-10-26';
export const TUE = '2026-10-27';
export const SAT = '2026-10-31';
export const SUN = '2026-11-01';

/** A `now` earlier than every test day, so no slot counts as "in the past". */
export const LONG_AGO = new Date('2026-01-01T00:00:00Z');

/** Clinic-local wall time → UTC Date. local('2026-10-26', '09:00') = 04:00 UTC. */
export function local(day: string, time: string, zone = KARACHI): Date {
  return DateTime.fromISO(`${day}T${time}`, { zone }).toJSDate();
}

export function between(day: string, from: string, to: string, zone = KARACHI): Interval {
  return { start: local(day, from, zone), end: local(day, to, zone) };
}

/** Slot start times as clinic-local "HH:mm", for readable assertions. */
export function startTimes(slots: Slot[], zone = KARACHI): string[] {
  return slots.map((slot) => DateTime.fromJSDate(slot.start, { zone }).toFormat('HH:mm'));
}

/** The slot starting at a local time, or undefined. */
export function slotAt(slots: Slot[], time: string, zone = KARACHI): Slot | undefined {
  return slots.find((slot) => DateTime.fromJSDate(slot.start, { zone }).toFormat('HH:mm') === time);
}

/** Which resource took a step of a slot. */
export function whoDid(slot: Slot | undefined, position: number): string | undefined {
  return slot?.assignments.find((a) => a.position === position)?.resourceId;
}

const MON_FRI = [1, 2, 3, 4, 5];

const minutes = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

export function hours(weekdays: number[], start: string, end: string): WorkingWindow[] {
  return weekdays.map((weekday) => ({ weekday, startMin: minutes(start), endMin: minutes(end) }));
}

export function resource(
  id: string,
  kind: SlotResource['kind'],
  skills: SlotResource['skills'],
  workingHours: WorkingWindow[],
): SlotResource {
  return { id, kind, skills, workingHours, timeOff: [], busy: [], appointmentsToday: 0 };
}

export function clinic() {
  return {
    ayesha: resource('dr-ayesha', 'OPTOMETRIST', ['PAEDIATRIC'], [
      ...hours(MON_FRI, '09:00', '13:00'),
      ...hours(MON_FRI, '14:00', '17:00'),
    ]),
    bilal: resource('dr-bilal', 'OPTOMETRIST', ['CONTACT_LENS'], [
      ...hours([1, 3, 4], '12:00', '20:00'),
      ...hours([6], '09:00', '14:00'),
    ]),
    sara: resource('tech-sara', 'TECHNICIAN', ['PRETEST', 'SCAN'], hours(MON_FRI, '09:00', '17:00')),
    usman: resource('tech-usman', 'TECHNICIAN', ['PRETEST'], hours([2, 3, 4, 5, 6], '10:00', '18:00')),
    scanner: resource('scanner-oct', 'SCANNER', [], hours([1, 2, 3, 4, 5, 6], '09:00', '20:00')),
  };
}

const pretest = (): Omit<SlotStep, 'position'> => ({
  resourceKind: 'TECHNICIAN',
  requiredSkill: 'PRETEST',
  offsetMin: 0,
  durationMin: 10,
});
const exam = (offsetMin: number, durationMin: number, requiredSkill: SlotStep['requiredSkill'] = null) => ({
  resourceKind: 'OPTOMETRIST' as const,
  requiredSkill,
  offsetMin,
  durationMin,
});
const scanAt = (offsetMin: number): Omit<SlotStep, 'position'>[] => [
  { resourceKind: 'SCANNER', requiredSkill: null, offsetMin, durationMin: 10 },
  { resourceKind: 'TECHNICIAN', requiredSkill: 'SCAN', offsetMin, durationMin: 10 },
];
const numbered = (steps: Omit<SlotStep, 'position'>[]): SlotStep[] =>
  steps.map((step, i) => ({ position: i + 1, ...step }));

/** Steps per appointment type, matching prisma/seed.ts. */
export const TYPES = {
  ROUTINE: numbered([pretest(), exam(10, 20)]),
  ROUTINE_WITH_SCAN: numbered([pretest(), exam(10, 20), ...scanAt(30)]),
  FOLLOW_UP: numbered([exam(0, 15)]),
  SCAN_ONLY: numbered(scanAt(0)),
  CONTACT_LENS: numbered([exam(0, 45, 'CONTACT_LENS')]),
  CHILD: numbered([pretest(), exam(10, 30, 'PAEDIATRIC')]),
  URGENT: numbered([exam(0, 20)]),
};
