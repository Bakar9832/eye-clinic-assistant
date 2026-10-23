import { DateTime } from 'luxon';
import { computeSlots } from './compute-slots.js';
import type { ComputeSlotsInput, SlotResource, SlotStep } from './types.js';
import {
  KARACHI,
  LONG_AGO,
  MON,
  SAT,
  SUN,
  TUE,
  TYPES,
  between,
  clinic,
  local,
  resource,
  slotAt,
  startTimes,
  whoDid,
} from './test-fixtures.js';

/** Defaults: Monday in Karachi, every seeded resource, 15-minute grid, any doctor. */
function slotsFor(
  steps: SlotStep[],
  options: Partial<Omit<ComputeSlotsInput, 'steps'>> & { resources?: SlotResource[] } = {},
) {
  return computeSlots({
    steps,
    resources: options.resources ?? Object.values(clinic()),
    day: MON,
    timezone: KARACHI,
    gridMin: 15,
    now: LONG_AGO,
    ...options,
  });
}

/** "09:00", "09:15", ... up to and including `last`. */
function every15(first: string, last: string): string[] {
  const out: string[] = [];
  let t = DateTime.fromFormat(first, 'HH:mm');
  const end = DateTime.fromFormat(last, 'HH:mm');
  while (t <= end) {
    out.push(t.toFormat('HH:mm'));
    t = t.plus({ minutes: 15 });
  }
  return out;
}

describe('computeSlots: working hours', () => {
  it('1. empty Monday, follow-up with Dr Ayesha: 09:00-12:45 and 14:00-16:45, nothing over lunch', () => {
    const slots = slotsFor(TYPES.FOLLOW_UP, { doctorId: 'dr-ayesha' });

    expect(startTimes(slots)).toEqual([...every15('09:00', '12:45'), ...every15('14:00', '16:45')]);
  });

  it('1b. a slot carries its end time and who does each step', () => {
    const [first] = slotsFor(TYPES.FOLLOW_UP, { doctorId: 'dr-ayesha' });

    expect(first).toEqual({
      start: local(MON, '09:00'),
      end: local(MON, '09:15'),
      assignments: [{ position: 1, resourceId: 'dr-ayesha', start: local(MON, '09:00'), end: local(MON, '09:15') }],
    });
  });

  it('2. no step runs past closing time or into lunch (routine with Dr Ayesha)', () => {
    const times = startTimes(slotsFor(TYPES.ROUTINE, { doctorId: 'dr-ayesha' }));

    // Exam is minutes 10-30: a 12:30 start finishes at 13:00; 12:45 would run into lunch.
    expect(times).toContain('12:30');
    expect(times).not.toContain('12:45');
    // A 13:45 start puts the exam at 13:55, before she is back.
    expect(times).not.toContain('13:45');
    expect(times).toContain('14:00');
    // Last of the day: 16:30 + 30 = 17:00.
    expect(times.at(-1)).toBe('16:30');
  });

  it('3. every slot starts and ends on the requested local day', () => {
    for (const steps of Object.values(TYPES)) {
      for (const slot of slotsFor(steps)) {
        const start = DateTime.fromJSDate(slot.start, { zone: KARACHI });
        const end = DateTime.fromJSDate(slot.end, { zone: KARACHI });
        expect(start.toISODate()).toBe(MON);
        // Ending exactly at midnight is fine; ending later is not.
        expect(end <= DateTime.fromISO(MON, { zone: KARACHI }).plus({ days: 1 })).toBe(true);
      }
    }
  });

  it('3b. hours that continue past midnight are two windows, never joined into one visit', () => {
    const night = resource('dr-night', 'OPTOMETRIST', ['CONTACT_LENS'], [
      { weekday: 1, startMin: 22 * 60, endMin: 24 * 60 },
      { weekday: 2, startMin: 0, endMin: 2 * 60 },
    ]);

    const times = startTimes(slotsFor(TYPES.CONTACT_LENS, { resources: [night] }));

    // 23:15 + 45 = 24:00 fits. 23:30 would end at 00:15 the next day: not offered.
    expect(times.at(-1)).toBe('23:15');
  });

  it('11. never offers a slot that starts in the past', () => {
    const slots = slotsFor(TYPES.FOLLOW_UP, { doctorId: 'dr-ayesha', now: local(MON, '11:07') });

    expect(startTimes(slots)[0]).toBe('11:15');
  });

  it('12. Sunday, nobody works: no slots for any type', () => {
    for (const steps of Object.values(TYPES)) {
      expect(slotsFor(steps, { day: SUN })).toEqual([]);
    }
  });
});

describe('computeSlots: several resources per visit', () => {
  it('4. doctor busy 10:10-10:30 blocks routine starts at 09:45, 10:00 and 10:15 only', () => {
    const c = clinic();
    c.ayesha.busy.push(between(MON, '10:10', '10:30'));

    const times = startTimes(slotsFor(TYPES.ROUTINE, { doctorId: 'dr-ayesha', resources: Object.values(c) }));

    expect(times).toContain('09:30'); // exam 09:40-10:00
    expect(times).not.toContain('09:45');
    expect(times).not.toContain('10:00');
    expect(times).not.toContain('10:15');
    expect(times).toContain('10:30'); // exam 10:40-11:00
  });

  it('5. doctor free but technician busy: no routine at 09:00, but a follow-up is fine', () => {
    const c = clinic();
    c.sara.busy.push(between(MON, '09:00', '09:10')); // Usman doesn't work Mondays

    expect(startTimes(slotsFor(TYPES.ROUTINE, { resources: Object.values(c) }))).not.toContain('09:00');
    expect(startTimes(slotsFor(TYPES.FOLLOW_UP, { resources: Object.values(c) }))).toContain('09:00');
  });

  it("6. the doctor is free again while the previous patient is being scanned", () => {
    // Seeded booking: pre-test 10:00-10:10, Dr Ayesha 10:10-10:30, scan 10:30-10:40.
    const c = clinic();
    c.sara.busy.push(between(MON, '10:00', '10:10'), between(MON, '10:30', '10:40'));
    c.ayesha.busy.push(between(MON, '10:10', '10:30'));
    c.scanner.busy.push(between(MON, '10:30', '10:40'));

    const times = startTimes(slotsFor(TYPES.FOLLOW_UP, { doctorId: 'dr-ayesha', resources: Object.values(c) }));

    expect(times).not.toContain('10:15');
    expect(times).toContain('10:30');
  });

  it('6b. routine with scan: pre-test, exam, then scanner and a SCAN technician in parallel', () => {
    const slot = slotAt(slotsFor(TYPES.ROUTINE_WITH_SCAN), '09:00');

    expect(slot?.end).toEqual(local(MON, '09:40'));
    expect(slot?.assignments).toEqual([
      { position: 1, resourceId: 'tech-sara', start: local(MON, '09:00'), end: local(MON, '09:10') },
      { position: 2, resourceId: 'dr-ayesha', start: local(MON, '09:10'), end: local(MON, '09:30') },
      { position: 3, resourceId: 'scanner-oct', start: local(MON, '09:30'), end: local(MON, '09:40') },
      { position: 4, resourceId: 'tech-sara', start: local(MON, '09:30'), end: local(MON, '09:40') },
    ]);
  });

  it('7. Saturday: nobody has SCAN, so no scans; routine with Dr Bilal from 10:00 (Usman starts at 10)', () => {
    expect(slotsFor(TYPES.ROUTINE_WITH_SCAN, { day: SAT })).toEqual([]);
    expect(slotsFor(TYPES.SCAN_ONLY, { day: SAT })).toEqual([]);

    const times = startTimes(slotsFor(TYPES.ROUTINE, { day: SAT }));
    expect(times[0]).toBe('10:00');
    expect(times.at(-1)).toBe('13:30'); // Dr Bilal leaves at 14:00
  });

  it('8. when one technician is busy, the other takes the pre-test', () => {
    const c = clinic();
    c.usman.busy.push(between(TUE, '10:00', '12:00'));

    const slots = slotsFor(TYPES.ROUTINE, { day: TUE, doctorId: 'dr-ayesha', resources: Object.values(c) });

    expect(whoDid(slotAt(slots, '10:00'), 1)).toBe('tech-sara');
    // Both free at 14:00: the tie-break picks Usman (fewer skills).
    expect(whoDid(slotAt(slots, '14:00'), 1)).toBe('tech-usman');
  });

  it('9. the shared scanner is busy: no scans then, other visits unaffected', () => {
    const c = clinic();
    c.scanner.busy.push(between(MON, '10:00', '12:00'));

    const scans = startTimes(slotsFor(TYPES.SCAN_ONLY, { resources: Object.values(c) }));
    expect(scans).toContain('09:45');
    for (const t of every15('10:00', '11:45')) expect(scans).not.toContain(t);
    expect(scans).toContain('12:00');

    expect(startTimes(slotsFor(TYPES.FOLLOW_UP, { resources: Object.values(c) }))).toContain('10:00');
  });

  it('13. one resource never takes two overlapping steps of the same visit', () => {
    const twoPretests = [
      { position: 1, resourceKind: 'TECHNICIAN', requiredSkill: 'PRETEST', offsetMin: 0, durationMin: 10 },
      { position: 2, resourceKind: 'TECHNICIAN', requiredSkill: 'PRETEST', offsetMin: 0, durationMin: 10 },
    ] satisfies SlotStep[];

    // Monday: only Sara works, and she can't do both at once.
    expect(slotsFor(twoPretests)).toEqual([]);

    // Tuesday 10:00: Sara and Usman are both in, so each takes one.
    const slot = slotAt(slotsFor(twoPretests, { day: TUE }), '10:00');
    expect(new Set([whoDid(slot, 1), whoDid(slot, 2)])).toEqual(new Set(['tech-sara', 'tech-usman']));
  });
});

describe('computeSlots: doctors and their skills', () => {
  it('10a. Dr Bilal on leave: no contact lens fittings at all; routine tests all go to Dr Ayesha', () => {
    const c = clinic();
    c.bilal.timeOff.push({ start: local(MON, '00:00'), end: local(TUE, '00:00') });

    expect(slotsFor(TYPES.CONTACT_LENS, { resources: Object.values(c) })).toEqual([]);

    const routine = slotsFor(TYPES.ROUTINE, { resources: Object.values(c) });
    expect(routine.length).toBeGreaterThan(0);
    for (const slot of routine) expect(whoDid(slot, 2)).toBe('dr-ayesha');
    expect(startTimes(routine)).not.toContain('13:00'); // her lunch, and nobody covers it
  });

  it("10b. child's exam with Dr Bilal: none, he doesn't see children", () => {
    expect(slotsFor(TYPES.CHILD, { doctorId: 'dr-bilal' })).toEqual([]);
    expect(slotsFor(TYPES.CHILD, { doctorId: 'dr-ayesha' }).length).toBeGreaterThan(0);
  });

  it('10c. "any doctor" uses both doctors: Dr Bilal covers Dr Ayesha\'s lunch', () => {
    const slots = slotsFor(TYPES.ROUTINE);

    // Both free at 10:00 (Bilal starts at 12): Dr Ayesha.
    expect(whoDid(slotAt(slots, '10:00'), 2)).toBe('dr-ayesha');
    // 12:45 start = exam 12:55-13:15, during her lunch: Dr Bilal.
    expect(whoDid(slotAt(slots, '12:45'), 2)).toBe('dr-bilal');
    expect(whoDid(slotAt(slots, '13:30'), 2)).toBe('dr-bilal');
  });

  it('10d. "any doctor" offers one slot per start time, not one per doctor', () => {
    const times = startTimes(slotsFor(TYPES.FOLLOW_UP));
    expect(new Set(times).size).toBe(times.length);
  });
});

describe('computeSlots: time zones', () => {
  it('14. 09:00 in Karachi is 04:00 UTC', () => {
    const [first] = slotsFor(TYPES.FOLLOW_UP, { doctorId: 'dr-ayesha' });
    expect(first.start.toISOString()).toBe('2026-10-26T04:00:00.000Z');
  });

  it('15. daylight saving: 09:00 London is 09:00 UTC before the change and 08:00 UTC after', () => {
    // UK clocks go forward on Sunday 2026-03-29.
    const london = { timezone: 'Europe/London' };

    const saturday = slotsFor(TYPES.FOLLOW_UP, { ...london, day: '2026-03-28' }); // Dr Bilal, 09:00-14:00
    expect(saturday[0].start.toISOString()).toBe('2026-03-28T09:00:00.000Z');

    const monday = slotsFor(TYPES.FOLLOW_UP, { ...london, day: '2026-03-30' }); // Dr Ayesha, 09:00
    expect(monday[0].start.toISOString()).toBe('2026-03-30T08:00:00.000Z');
  });

  it('16. day boundary: in Auckland, Monday 09:00 is still Sunday in UTC', () => {
    const auckland = 'Pacific/Auckland'; // UTC+13 in October
    const c = clinic();
    // A booking stored in UTC on Sunday 25th, which is Monday 09:00-09:30 in Auckland.
    c.ayesha.busy.push({ start: new Date('2026-10-25T20:00:00Z'), end: new Date('2026-10-25T20:30:00Z') });

    const slots = slotsFor(TYPES.FOLLOW_UP, {
      timezone: auckland,
      doctorId: 'dr-ayesha',
      resources: Object.values(c),
    });

    expect(slots[0].start.toISOString()).toBe('2026-10-25T20:30:00.000Z');
    expect(startTimes(slots, auckland)[0]).toBe('09:30');
  });
});
