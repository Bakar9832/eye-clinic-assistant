// Admin edits: settings (including the clinic's time zone), step lengths, working
// hours, leave and staff accounts. None of them moves an existing booking.

import { DateTime } from 'luxon';
import { seedClinic } from '../prisma/clinic-data.js';
import { createTestApp, login, staffLogin, ZONE, type TestApp } from './harness.js';

let t: TestApp;
let clinic: Awaited<ReturnType<typeof seedClinic>>;

const MON = '2030-01-07';
const TUE = '2030-01-08';
const at = (time: string, day = MON, zone = ZONE) => DateTime.fromISO(`${day}T${time}`, { zone }).toUTC().toISO()!;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  clinic = await t.reset();
});
afterAll(async () => {
  await t.app.close();
});

const admin = () => staffLogin(t, 'admin@clinic.example');

/** The demo patient books with Dr Ayesha on Monday; returns the ticket. */
async function booking(typeCode = 'FOLLOW_UP', time = '09:00') {
  const patient = await login(t, 'demo.patient@example.com');
  const res = await patient
    .post('/me/appointments')
    .send({ typeCode, start: at(time), doctorId: clinic.resources.ayesha.id })
    .expect(201);
  return res.body as { id: string; reference: string; start: string; end: string };
}

describe('who may edit', () => {
  it('only admins can change things; every staff role can read the resources', async () => {
    const reception = await staffLogin(t, 'reception@clinic.example');
    const doctor = await staffLogin(t, 'dr.ayesha@clinic.example');
    for (const staff of [reception, doctor]) {
      await staff.patch('/staff/settings').send({ name: 'X' }).expect(403);
      await staff.patch('/staff/appointment-types/FOLLOW_UP').send({ typicalMin: 12 }).expect(403);
    }

    const res = await reception.get('/staff/resources').expect(200);
    expect(res.body.find((r: { displayName: string }) => r.displayName === 'Dr Ayesha').workingHours).toContainEqual({
      weekday: 1,
      start: '09:00',
      end: '13:00',
    });
  });
});

describe('E1. clinic settings', () => {
  it("changing the clinic's time zone lists the bookings that now fall outside working hours", async () => {
    const booked = await booking(); // 09:00 Karachi = 04:00 UTC
    const res = await (await admin()).patch('/staff/settings').send({ timezone: 'Europe/London' }).expect(200);

    // 04:00 UTC is 04:00 in London: long before Dr Ayesha's 09:00 start there.
    expect(res.body.settings.timezone).toBe('Europe/London');
    expect(res.body.bookingsOutsideHours).toEqual([
      { reference: booked.reference, start: booked.start, patient: 'Demo Patient', resource: 'Dr Ayesha' },
    ]);
    // The booking itself didn't move.
    const saved = await t.prisma.appointment.findUniqueOrThrow({ where: { id: booked.id } });
    expect(saved.startsAt.toISOString()).toBe(booked.start);

    // New slots follow the new zone: 09:00 London in January is 09:00 UTC.
    const slots = await t.http().get('/availability').query({ type: 'FOLLOW_UP', day: MON }).expect(200);
    expect(slots.body.slots[0].start).toBe(at('09:00', MON, 'Europe/London'));
  });

  it('bad values are refused', async () => {
    const browser = await admin();
    await browser.patch('/staff/settings').send({ timezone: 'Mars/Olympus' }).expect(400);
    await browser.patch('/staff/settings').send({ slotGridMin: 7 }).expect(400);
    await browser.patch('/staff/settings').send({ outcomeEditWindowHours: 0 }).expect(400);
    await browser.patch('/staff/settings').send({ somethingElse: true }).expect(400);
    await browser.patch('/staff/settings').send({ outcomeEditWindowHours: 48, slotGridMin: 30 }).expect(200);
  });
});

describe('step lengths', () => {
  it('E2. a longer exam pushes the scan back; new slots use the new length', async () => {
    const res = await (await admin())
      .patch('/staff/appointment-types/ROUTINE_EYE_TEST_WITH_SCAN')
      .send({ stepDurations: [{ position: 2, durationMin: 25 }] })
      .expect(200);

    expect(res.body.calendarMin).toBe(45);
    expect(res.body.steps.map((s: { offsetMin: number; durationMin: number }) => [s.offsetMin, s.durationMin])).toEqual([
      [0, 10], // pre-test
      [10, 25], // exam, now 25
      [35, 10], // scanner, moved from 30 to 35
      [35, 10], // scan technician, still alongside the scanner
    ]);

    const slots = await t.http().get('/availability').query({ type: 'ROUTINE_EYE_TEST_WITH_SCAN', day: MON }).expect(200);
    const first = slots.body.slots[0];
    expect(new Date(first.end).getTime() - new Date(first.start).getTime()).toBe(45 * 60_000);
  });

  it('E3. existing bookings keep their times', async () => {
    const booked = await booking('ROUTINE_EYE_TEST_WITH_SCAN');
    await (await admin())
      .patch('/staff/appointment-types/ROUTINE_EYE_TEST_WITH_SCAN')
      .send({ stepDurations: [{ position: 2, durationMin: 25 }] })
      .expect(200);

    const saved = await t.prisma.appointment.findUniqueOrThrow({ where: { id: booked.id } });
    expect(saved.endsAt.toISOString()).toBe(booked.end);
  });

  it('refuses a step that does not exist, or a patient time longer than the calendar time', async () => {
    const browser = await admin();
    await browser
      .patch('/staff/appointment-types/FOLLOW_UP')
      .send({ stepDurations: [{ position: 9, durationMin: 10 }] })
      .expect(400);
    await browser.patch('/staff/appointment-types/FOLLOW_UP').send({ typicalMin: 20 }).expect(400); // calendar is 15
    await browser.patch('/staff/appointment-types/NOPE').send({ typicalMin: 5 }).expect(404);
  });
});

describe('E4. working hours', () => {
  it('replacing hours lists the bookings now outside them, and moves nothing', async () => {
    const booked = await booking(); // Monday 09:00
    const res = await (await admin())
      .put(`/staff/resources/${clinic.resources.ayesha.id}/working-hours`)
      .send({
        windows: [1, 2, 3, 4, 5].flatMap((weekday) => [
          { weekday, start: '10:00', end: '13:00' },
          { weekday, start: '14:00', end: '17:00' },
        ]),
      })
      .expect(200);

    expect(res.body.bookingsOutsideHours.map((b: { reference: string }) => b.reference)).toEqual([booked.reference]);
    expect((await t.prisma.appointment.findUniqueOrThrow({ where: { id: booked.id } })).status).toBe('BOOKED');
  });

  it('refuses overlapping windows and windows that end before they start', async () => {
    const browser = await admin();
    const url = `/staff/resources/${clinic.resources.ayesha.id}/working-hours`;
    await browser
      .put(url)
      .send({ windows: [{ weekday: 1, start: '09:00', end: '13:00' }, { weekday: 1, start: '12:00', end: '15:00' }] })
      .expect(400);
    await browser.put(url).send({ windows: [{ weekday: 1, start: '17:00', end: '09:00' }] }).expect(400);
  });
});

describe('E5. leave', () => {
  it('is refused over existing bookings, with the list of patients to move first', async () => {
    const booked = await booking();
    const res = await (await admin())
      .post(`/staff/resources/${clinic.resources.ayesha.id}/time-off`)
      .send({ start: at('00:00'), end: at('00:00', TUE), reason: 'Conference' })
      .expect(409);

    expect(res.body.error).toBe('BOOKINGS_IN_THE_WAY');
    expect(res.body.bookings.map((b: { reference: string }) => b.reference)).toEqual([booked.reference]);
    expect(await t.prisma.timeOff.count()).toBe(0);
  });

  it('on a free day it is saved, and her slots that day disappear', async () => {
    await (await admin())
      .post(`/staff/resources/${clinic.resources.ayesha.id}/time-off`)
      .send({ start: at('00:00', TUE), end: at('00:00', '2030-01-09'), reason: 'Conference' })
      .expect(201);

    const slots = await t.http()
      .get('/availability')
      .query({ type: 'FOLLOW_UP', day: TUE, doctorId: clinic.resources.ayesha.id })
      .expect(200);
    expect(slots.body.slots).toEqual([]);
  });
});

describe('E6. staff accounts', () => {
  it('switching an account off locks that person out', async () => {
    const reception = await staffLogin(t, 'reception@clinic.example');
    await (await admin()).patch(`/staff/users/${clinic.staff.reception.id}`).send({ active: false }).expect(200);
    await reception.get('/staff/me').expect(401);
  });

  it("an admin can't switch off their own account", async () => {
    const res = await (await admin()).patch(`/staff/users/${clinic.staff.admin.id}`).send({ active: false }).expect(409);
    expect(res.body.error).toBe('CANNOT_DEACTIVATE_SELF');
  });
});

describe('E7. audit', () => {
  it('every admin change is recorded with who made it and which fields changed', async () => {
    const browser = await admin();
    await browser.patch('/staff/settings').send({ timezone: 'Europe/London' }).expect(200);
    await browser.patch('/staff/appointment-types/FOLLOW_UP').send({ typicalMin: 12 }).expect(200);
    await browser
      .put(`/staff/resources/${clinic.resources.bilal.id}/working-hours`)
      .send({ windows: [{ weekday: 6, start: '09:00', end: '12:00' }] })
      .expect(200);
    await browser
      .post(`/staff/resources/${clinic.resources.bilal.id}/time-off`)
      .send({ start: at('00:00', TUE), end: at('00:00', '2030-01-09') })
      .expect(201);
    await browser.patch(`/staff/users/${clinic.staff.reception.id}`).send({ active: false }).expect(200);

    const events = await t.prisma.auditEvent.findMany({ where: { actorId: clinic.staff.admin.id, actorType: 'STAFF' } });
    const byAction = new Map(events.map((e) => [e.action, e]));
    expect(byAction.get('SETTINGS_UPDATED')?.details).toEqual({ fields: ['timezone'] });
    expect(byAction.get('APPOINTMENT_TYPE_UPDATED')?.details).toEqual({ fields: ['typicalMin'] });
    expect(byAction.has('WORKING_HOURS_REPLACED')).toBe(true);
    expect(byAction.has('TIME_OFF_ADDED')).toBe(true);
    expect(byAction.get('STAFF_USER_UPDATED')?.details).toEqual({ fields: ['active'], active: false });
  });
});
