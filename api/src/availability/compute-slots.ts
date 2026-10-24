import { DateTime } from 'luxon';
import { pickResource } from './pick-resource.js';
import type { Assignment, ComputeSlotsInput, Interval, Slot, SlotResource, SlotStep } from './types.js';

const MINUTES_PER_DAY = 24 * 60;

/** Half-open ranges [a, b) and [c, d) overlap when a < d && c < b. Back to back is fine. */
function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Every start time on `day` where each step of the visit has a free resource.
 *
 * Rules (each one has a test in compute-slots.spec.ts):
 * - Starts sit on the `gridMin` grid of the clinic's local clock (09:00, 09:15, ...).
 * - Each step must fit entirely inside one working window of its resource, on this
 *   local day. Windows are never joined across midnight or across a lunch break.
 * - A resource is unavailable while it is on time off or busy with another booking.
 * - Skills: a step with requiredSkill only goes to resources that have that skill.
 * - doctorId limits OPTOMETRIST steps to that doctor; undefined means any doctor.
 * - One resource can't take two overlapping steps of the same visit.
 * - All or nothing: if any step has no free resource, that start time is not offered.
 * - When several resources could take a step, pickResource chooses.
 * - Nothing that starts before `now`.
 * - One Slot per start time, in time order.
 */
export function computeSlots(input: ComputeSlotsInput): Slot[] {
  const day = dayContext(input);
  const slots: Slot[] = [];

  // Every grid start whose whole visit still ends by midnight.
  for (let startMin = 0; startMin + day.visitLength <= MINUTES_PER_DAY; startMin += input.gridMin) {
    if (day.toDate(startMin) < input.now) continue;
    const slot = fillSteps(input, day, startMin, false);
    if (slot) slots.push(slot);
  }

  return slots;
}

/**
 * Staff override: can a visit start at exactly this minute of the day if working hours
 * and the grid are stretched? Every hard rule still applies: days off, leave, other
 * bookings, skills, the chosen doctor, one resource not doing two things at once, and
 * the visit ending by midnight. Returns null when even that isn't possible.
 */
export function slotIgnoringHours(input: ComputeSlotsInput, startMin: number): Slot | null {
  const day = dayContext(input);
  if (!Number.isInteger(startMin) || startMin < 0 || startMin + day.visitLength > MINUTES_PER_DAY) return null;
  return fillSteps(input, day, startMin, true);
}

/** Things about the day that every start time shares. */
function dayContext({ steps, day, timezone }: ComputeSlotsInput) {
  // Local midnight at the clinic. Its weekday is what working hours are matched against.
  const midnight = DateTime.fromISO(day, { zone: timezone });
  if (!midnight.isValid) throw new Error(`Invalid day "${day}" or time zone "${timezone}"`);

  return {
    weekday: midnight.weekday,
    // "Minutes after local midnight" → UTC Date, built from the local clock so that
    // daylight-saving days still put 09:00 at 09:00 local. 24:00 is the next midnight.
    toDate: (minute: number): Date =>
      minute === MINUTES_PER_DAY
        ? midnight.plus({ days: 1 }).toJSDate()
        : midnight.set({ hour: Math.floor(minute / 60), minute: minute % 60 }).toJSDate(),
    ordered: [...steps].sort((a, b) => a.position - b.position),
    visitLength: Math.max(...steps.map((step) => step.offsetMin + step.durationMin)),
  };
}

/** Tries to give every step of a visit starting at `startMin` a free resource. All or nothing. */
function fillSteps(
  { resources, doctorId }: ComputeSlotsInput,
  day: ReturnType<typeof dayContext>,
  startMin: number,
  ignoreWorkingHours: boolean,
): Slot | null {
  // Can this resource take this step, from minute `from` to minute `to` of the day?
  // `alreadyUsed` holds what's been assigned earlier in the same visit.
  const canTake = (
    resource: SlotResource,
    step: SlotStep,
    from: number,
    to: number,
    range: Interval,
    alreadyUsed: Assignment[],
  ): boolean =>
    resource.kind === step.resourceKind &&
    (step.requiredSkill === null || resource.skills.includes(step.requiredSkill)) &&
    (resource.kind !== 'OPTOMETRIST' || doctorId === undefined || resource.id === doctorId) &&
    // One window must hold the whole step; this is what blocks lunch and overnight.
    // An override may stretch the hours, but only of someone who works that day:
    // a day off is as firm as leave.
    (ignoreWorkingHours
      ? resource.workingHours.some((w) => w.weekday === day.weekday)
      : resource.workingHours.some((w) => w.weekday === day.weekday && w.startMin <= from && to <= w.endMin)) &&
    !resource.timeOff.some((off) => overlaps(off, range)) &&
    !resource.busy.some((booked) => overlaps(booked, range)) &&
    !alreadyUsed.some((a) => a.resourceId === resource.id && overlaps(a, range));

  const assignments: Assignment[] = [];
  for (const step of day.ordered) {
    const from = startMin + step.offsetMin;
    const to = from + step.durationMin;
    const range = { start: day.toDate(from), end: day.toDate(to) };

    const candidates = resources.filter((r) => canTake(r, step, from, to, range, assignments));
    const chosen = pickResource(candidates);
    if (!chosen) return null; // all or nothing: one missing step rules out this start

    assignments.push({ position: step.position, resourceId: chosen.id, ...range });
  }

  return { start: day.toDate(startMin), end: day.toDate(startMin + day.visitLength), assignments };
}
