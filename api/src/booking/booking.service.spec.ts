// Database tests: run against TEST_DATABASE_URL, which is wiped and re-seeded before each test.

import { seedClinic } from '../../prisma/clinic-data.js';
import { AuditService } from '../audit/audit.service.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { KARACHI, LONG_AGO, MON, local, startTimes } from '../availability/test-fixtures.js';
import { isOverlapViolation } from '../prisma/db-errors.js';
import { SchedulingError } from '../scheduling-error.js';
import { testPrisma } from '../testing-db.js';
import { SystemClock } from '../clock.js';
import { BookingService } from './booking.service.js';

const prisma = testPrisma();
const availability = new AvailabilityService(prisma);
const booking = new BookingService(prisma, availability, new AuditService(prisma, new SystemClock()));

let clinic: Awaited<ReturnType<typeof seedClinic>>;

beforeEach(async () => {
  clinic = await seedClinic(prisma, KARACHI);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Makes a race real. The first `count` availability checks each wait until all of them
 * have looked, so every request believes the slot is free and only the database can
 * decide who gets it. Without this, a fast request can finish before the next one even
 * looks, and the test would pass without the database constraint ever being involved.
 */
function everyoneLooksFirst(count: number) {
  const original = availability.getSlots.bind(availability);
  let arrived = 0;
  let release!: () => void;
  const allArrived = new Promise<void>((resolve) => (release = resolve));

  vi.spyOn(availability, 'getSlots').mockImplementation(async (query) => {
    const result = await original(query);
    if (arrived < count) {
      arrived += 1;
      if (arrived === count) release();
      await allArrived;
    }
    return result; // retries come later and pass straight through
  });
}

/** Asserts a SchedulingError with this code, and optionally exactly these reason codes. */
async function expectRefusal(promise: Promise<unknown>, code: string, reasonCodes?: string[]) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SchedulingError);
  expect((error as SchedulingError).code).toBe(code);
  if (reasonCodes) expect((error as SchedulingError).reasons.map((r) => r.code)).toEqual(reasonCodes);
}

const activeAllocations = (resourceId: string) => prisma.resourceAllocation.count({ where: { resourceId, active: true } });

describe('BookingService.book', () => {
  it('20. creates the appointment, one allocation per step and a reference code', async () => {
    const { ayesha, sara, scanner } = clinic.resources;

    const appointment = await booking.book(
      clinic.patients.demo.id,
      { typeCode: 'ROUTINE_EYE_TEST_WITH_SCAN', start: local(MON, '09:00'), doctorId: ayesha.id },
      LONG_AGO,
    );

    expect(appointment.reference).toMatch(/^EC-[2-9A-HJKMNP-Z]{6}$/);
    expect(appointment.status).toBe('BOOKED');
    expect(appointment.endsAt).toEqual(local(MON, '09:40'));

    const allocations = appointment.allocations
      .map((a) => ({ resourceId: a.resourceId, start: a.startsAt, end: a.endsAt }))
      .sort((a, b) => a.start.getTime() - b.start.getTime() || a.resourceId.localeCompare(b.resourceId));
    expect(allocations).toEqual(
      [
        { resourceId: sara.id, start: local(MON, '09:00'), end: local(MON, '09:10') },
        { resourceId: ayesha.id, start: local(MON, '09:10'), end: local(MON, '09:30') },
        { resourceId: scanner.id, start: local(MON, '09:30'), end: local(MON, '09:40') },
        { resourceId: sara.id, start: local(MON, '09:30'), end: local(MON, '09:40') },
      ].sort((a, b) => a.start.getTime() - b.start.getTime() || a.resourceId.localeCompare(b.resourceId)),
    );
  });

  describe('21. a start time that is never offered is refused, with the reasons', () => {
    const patient = () => clinic.patients.demo.id;

    it('off the 15-minute grid', async () => {
      await expectRefusal(
        booking.book(patient(), { typeCode: 'FOLLOW_UP', start: local(MON, '10:07') }, LONG_AGO),
        'INVALID_SLOT',
        ['NOT_ON_GRID'],
      );
    });

    it('in the past', async () => {
      await expectRefusal(
        booking.book(patient(), { typeCode: 'FOLLOW_UP', start: local(MON, '09:00') }, local(MON, '12:00')),
        'INVALID_SLOT',
        ['IN_THE_PAST'],
      );
    });

    it('running past midnight (the caller can only send a start; the end comes from the type)', async () => {
      await expectRefusal(
        booking.book(patient(), { typeCode: 'ROUTINE_EYE_TEST', start: local(MON, '23:45') }, LONG_AGO),
        'INVALID_SLOT',
        ['CROSSES_MIDNIGHT'],
      );
    });

    it('nobody available (18:00 Monday: the technicians have gone home)', async () => {
      await expectRefusal(
        booking.book(patient(), { typeCode: 'ROUTINE_EYE_TEST', start: local(MON, '18:00') }, LONG_AGO),
        'INVALID_SLOT',
        ['NOT_AVAILABLE'],
      );
    });

    it('unknown appointment type or doctor', async () => {
      await expectRefusal(booking.book(patient(), { typeCode: 'NOPE', start: local(MON, '09:00') }, LONG_AGO), 'UNKNOWN_TYPE');
      await expectRefusal(
        booking.book(patient(), { typeCode: 'FOLLOW_UP', start: local(MON, '09:00'), doctorId: 'dr-nobody' }, LONG_AGO),
        'UNKNOWN_DOCTOR',
      );
    });
  });
});

describe('BookingService: concurrency', () => {
  it('22. ten people book the same doctor at the same moment: exactly one wins', async () => {
    const { ayesha } = clinic.resources;
    const request = { typeCode: 'FOLLOW_UP', start: local(MON, '09:00'), doctorId: ayesha.id };
    everyoneLooksFirst(10);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => booking.book(clinic.patients.demo.id, request, LONG_AGO)),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // All ten saw the slot as free, so each loser was stopped by the database.
    const losers = results.filter((r) => r.status === 'rejected');
    expect(losers).toHaveLength(9);
    for (const r of losers) expect((r.reason as SchedulingError).code).toBe('SLOT_TAKEN');
    expect(await activeAllocations(ayesha.id)).toBe(1);
  });

  it('22b. "any doctor": losers retry with the other doctor, so exactly two win', async () => {
    // 12:00 Monday: both Dr Ayesha (until 13:00) and Dr Bilal (from 12:00) are in.
    const request = { typeCode: 'FOLLOW_UP', start: local(MON, '12:00') };
    everyoneLooksFirst(10);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => booking.book(clinic.patients.demo.id, request, LONG_AGO)),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(await activeAllocations(clinic.resources.ayesha.id)).toBe(1);
    expect(await activeAllocations(clinic.resources.bilal.id)).toBe(1);
  });

  it('23. two different visit types race for the only technician: exactly one wins', async () => {
    // Both need Sara 12:00-12:10 (Usman doesn't work Mondays); the doctors differ.
    const { ayesha, bilal, sara } = clinic.resources;
    everyoneLooksFirst(2);

    const results = await Promise.allSettled([
      booking.book(clinic.patients.demo.id, { typeCode: 'ROUTINE_EYE_TEST', start: local(MON, '12:00'), doctorId: bilal.id }, LONG_AGO),
      booking.book(clinic.patients.three.id, { typeCode: 'CHILD_EYE_EXAM', start: local(MON, '12:00'), doctorId: ayesha.id }, LONG_AGO),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await activeAllocations(sara.id)).toBe(1);
  });

  it('27. the database itself refuses an overlap, even when the service is bypassed', async () => {
    const { ayesha } = clinic.resources;
    const appointment = await booking.book(
      clinic.patients.demo.id,
      { typeCode: 'FOLLOW_UP', start: local(MON, '09:00'), doctorId: ayesha.id },
      LONG_AGO,
    );

    const error = await prisma.resourceAllocation
      .create({
        data: {
          appointmentId: appointment.id,
          resourceId: ayesha.id,
          startsAt: local(MON, '09:05'),
          endsAt: local(MON, '09:20'),
        },
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(isOverlapViolation(error)).toBe(true);
  });
});

describe('BookingService.reschedule', () => {
  it('C3. moving 10:00 → 10:15 with the same doctor works: the appointment does not block itself', async () => {
    const { ayesha } = clinic.resources;
    const original = await booking.book(
      clinic.patients.demo.id,
      { typeCode: 'ROUTINE_EYE_TEST', start: local(MON, '10:00'), doctorId: ayesha.id },
      LONG_AGO,
    );

    // Old exam 10:10-10:30 overlaps the new one 10:25-10:45.
    const moved = await booking.reschedule(clinic.patients.demo.id, original.id, { start: local(MON, '10:15') }, LONG_AGO);

    expect(moved.startsAt).toEqual(local(MON, '10:15'));
    expect(moved.reference).toBe(original.reference);
    expect(moved.allocations.find((a) => a.resourceId === ayesha.id)?.startsAt).toEqual(local(MON, '10:25'));
  });

  it('C4. two patients race to move into the same slot: exactly one wins, the other keeps their time', async () => {
    const { ayesha } = clinic.resources;
    const followUp = (patientId: string, time: string) =>
      booking.book(patientId, { typeCode: 'FOLLOW_UP', start: local(MON, time), doctorId: ayesha.id }, LONG_AGO);
    const mine = await followUp(clinic.patients.demo.id, '09:00');
    const theirs = await followUp(clinic.patients.two.id, '09:15');
    everyoneLooksFirst(2);

    const results = await Promise.allSettled([
      booking.reschedule(clinic.patients.demo.id, mine.id, { start: local(MON, '11:00') }, LONG_AGO),
      booking.reschedule(clinic.patients.two.id, theirs.id, { start: local(MON, '11:00') }, LONG_AGO),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.findIndex((r) => r.status === 'rejected') === 0 ? mine : theirs;
    const after = await prisma.appointment.findUniqueOrThrow({
      where: { id: loser.id },
      include: { allocations: { where: { active: true } } },
    });
    expect(after.startsAt).toEqual(loser.startsAt); // untouched
    expect(after.allocations).toHaveLength(1); // still holding its original time
  });
});

describe('BookingService.cancel', () => {
  const followUpAt9 = (patientId: string) =>
    booking.book(
      patientId,
      { typeCode: 'FOLLOW_UP', start: local(MON, '09:00'), doctorId: clinic.resources.ayesha.id },
      LONG_AGO,
    );

  it('24. cancelling frees the slot for someone else and keeps the history', async () => {
    const first = await followUpAt9(clinic.patients.demo.id);

    const cancelled = await booking.cancel(clinic.patients.demo.id, first.id, LONG_AGO);
    expect(cancelled.status).toBe('CANCELLED');
    expect(await prisma.resourceAllocation.count({ where: { appointmentId: first.id, active: false } })).toBe(1);

    const second = await followUpAt9(clinic.patients.two.id);
    expect(second.status).toBe('BOOKED');
  });

  it("24b. a patient can't cancel someone else's appointment, and can't tell it exists", async () => {
    const theirs = await followUpAt9(clinic.patients.demo.id);

    await expectRefusal(booking.cancel(clinic.patients.two.id, theirs.id, LONG_AGO), 'NOT_FOUND');
    await expectRefusal(booking.cancel(clinic.patients.two.id, 'not-a-real-id', LONG_AGO), 'NOT_FOUND');
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe('BOOKED');
  });

  it('24c. cancelling twice, or after the appointment started, is refused', async () => {
    const appointment = await followUpAt9(clinic.patients.demo.id);

    await expectRefusal(booking.cancel(clinic.patients.demo.id, appointment.id, local(MON, '09:05')), 'NOT_CANCELLABLE');
    await booking.cancel(clinic.patients.demo.id, appointment.id, LONG_AGO);
    await expectRefusal(booking.cancel(clinic.patients.demo.id, appointment.id, LONG_AGO), 'NOT_CANCELLABLE');
  });
});

describe('Stored data', () => {
  it('25. changing a step length changes future slots only; existing bookings keep their times', async () => {
    const { ayesha } = clinic.resources;
    const existing = await booking.book(
      clinic.patients.demo.id,
      { typeCode: 'FOLLOW_UP', start: local(MON, '09:00'), doctorId: ayesha.id },
      LONG_AGO,
    );

    // An admin makes follow-ups 30 minutes instead of 15.
    await prisma.appointmentTypeStep.updateMany({
      where: { appointmentType: { code: 'FOLLOW_UP' } },
      data: { durationMin: 30 },
    });

    const unchanged = await prisma.appointment.findUniqueOrThrow({ where: { id: existing.id }, include: { allocations: true } });
    expect(unchanged.endsAt).toEqual(local(MON, '09:15'));
    expect(unchanged.allocations[0].endsAt).toEqual(local(MON, '09:15'));

    const { slots } = await availability.getSlots({ typeCode: 'FOLLOW_UP', day: MON, doctorId: ayesha.id, now: LONG_AGO });
    const times = startTimes(slots);
    expect(times[0]).toBe('09:15'); // right after the existing 15-minute booking
    expect(times).toContain('12:30'); // 12:30 + 30 = 13:00
    expect(times).not.toContain('12:45'); // would now run into lunch
  });

  it('26. times survive the round trip to the database unchanged (the UTC bug stays fixed)', async () => {
    const appointment = await booking.book(
      clinic.patients.demo.id,
      { typeCode: 'FOLLOW_UP', start: local(MON, '09:00'), doctorId: clinic.resources.ayesha.id },
      LONG_AGO,
    );

    // 09:00 Karachi is 04:00 UTC. Read it back raw, without Prisma converting anything.
    const [row] = await prisma.$queryRaw<{ utc: string }[]>`
      SELECT to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS utc
      FROM appointments WHERE id = ${appointment.id}::uuid`;
    expect(row.utc).toBe('2026-10-26 04:00');

    const readBack = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(readBack.startsAt).toEqual(local(MON, '09:00'));
  });
});
