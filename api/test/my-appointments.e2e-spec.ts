// "My appointments" over HTTP: booking, moving and cancelling, privacy between
// patients (IDOR) and the audit trail.

import { DateTime } from 'luxon';
import { seedClinic } from '../prisma/clinic-data.js';
import { createTestApp, login, ZONE, type TestApp } from './harness.js';

let t: TestApp;
let clinic: Awaited<ReturnType<typeof seedClinic>>;

const DAY = '2030-01-07'; // a Monday after the harness clock's start
const at = (time: string) => DateTime.fromISO(`${DAY}T${time}`, { zone: ZONE }).toUTC().toISO()!;
const DEMO = 'demo.patient@example.com';
const TWO = 'test.two@example.com';

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  clinic = await t.reset();
});
afterAll(async () => {
  await t.app.close();
});

const followUp = (time: string) => ({ typeCode: 'FOLLOW_UP', start: at(time), doctorId: clinic.resources.ayesha.id });

describe('booking', () => {
  it('B7. books for the logged-in patient and returns the ticket', async () => {
    const browser = await login(t, DEMO);
    const res = await browser.post('/me/appointments').send(followUp('09:00')).expect(201);

    expect(res.body).toMatchObject({
      status: 'BOOKED',
      start: at('09:00'),
      type: { code: 'FOLLOW_UP' },
      doctor: { displayName: 'Dr Ayesha' },
    });
    expect(res.body.reference).toMatch(/^EC-/);
    const saved = await t.prisma.appointment.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(saved.patientId).toBe(clinic.patients.demo.id);
  });

  it('B4. a body that includes patientId is rejected, and nothing is booked', async () => {
    const browser = await login(t, DEMO);
    await browser
      .post('/me/appointments')
      .send({ ...followUp('09:00'), patientId: clinic.patients.two.id })
      .expect(400);
    expect(await t.prisma.appointment.count()).toBe(0);
  });

  it('A14. a new patient must complete their profile before booking', async () => {
    const browser = await login(t, 'new.person@example.com');
    const refused = await browser.post('/me/appointments').send(followUp('09:00')).expect(403);
    expect(refused.body.error).toBe('PROFILE_INCOMPLETE');

    await browser.patch('/me').send({ fullName: 'New Person', dateOfBirth: '1992-03-04' }).expect(200);
    await browser.post('/me/appointments').send(followUp('09:00')).expect(201);
  });

  it('a start time without a time zone is ambiguous and refused', async () => {
    const browser = await login(t, DEMO);
    await browser
      .post('/me/appointments')
      .send({ ...followUp('09:00'), start: `${DAY}T09:00:00` })
      .expect(400);
  });

  it('B5. every /me/appointments route needs a session', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    await t.http().get('/me/appointments').expect(401);
    await t.http().post('/me/appointments').send(followUp('09:00')).expect(401);
    await t.http().post(`/me/appointments/${id}/reschedule`).send({ start: at('10:00') }).expect(401);
    await t.http().delete(`/me/appointments/${id}`).set('Content-Type', 'application/json').expect(401);
  });
});

describe('privacy between patients (IDOR)', () => {
  it("B1. each patient sees only their own appointments", async () => {
    const demo = await login(t, DEMO);
    const two = await login(t, TWO);
    const mine = (await demo.post('/me/appointments').send(followUp('09:00')).expect(201)).body;
    const theirs = (await two.post('/me/appointments').send(followUp('10:00')).expect(201)).body;

    const list = await demo.get('/me/appointments').expect(200);
    expect(list.body.map((a: { id: string }) => a.id)).toEqual([mine.id]);
    expect(JSON.stringify(list.body)).not.toContain(theirs.reference);
  });

  it("B2. cancelling someone else's appointment is 404, and it stays booked", async () => {
    const demo = await login(t, DEMO);
    const two = await login(t, TWO);
    const mine = (await demo.post('/me/appointments').send(followUp('09:00')).expect(201)).body;

    await two.delete(`/me/appointments/${mine.id}`).set('Content-Type', 'application/json').expect(404);
    expect((await t.prisma.appointment.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe('BOOKED');
  });

  it("B3. moving someone else's appointment is 404, and it stays put", async () => {
    const demo = await login(t, DEMO);
    const two = await login(t, TWO);
    const mine = (await demo.post('/me/appointments').send(followUp('09:00')).expect(201)).body;

    await two.post(`/me/appointments/${mine.id}/reschedule`).send({ start: at('11:00') }).expect(404);
    expect((await t.prisma.appointment.findUniqueOrThrow({ where: { id: mine.id } })).startsAt.toISOString()).toBe(
      at('09:00'),
    );
  });
});

describe('moving and cancelling', () => {
  it('C1. moving to a free slot keeps the reference; the old holds are released', async () => {
    const browser = await login(t, DEMO);
    const booked = (await browser.post('/me/appointments').send(followUp('09:00')).expect(201)).body;

    const moved = await browser.post(`/me/appointments/${booked.id}/reschedule`).send({ start: at('11:00') }).expect(200);
    expect(moved.body).toMatchObject({ reference: booked.reference, start: at('11:00'), doctor: { displayName: 'Dr Ayesha' } });

    const allocations = await t.prisma.resourceAllocation.findMany({ where: { appointmentId: booked.id } });
    expect(allocations.filter((a) => a.active).map((a) => a.startsAt.toISOString())).toEqual([at('11:00')]);
    expect(allocations.filter((a) => !a.active).map((a) => a.startsAt.toISOString())).toEqual([at('09:00')]);

    // 09:00 is free again for someone else.
    const two = await login(t, TWO);
    await two.post('/me/appointments').send(followUp('09:00')).expect(201);
  });

  it('C2. moving into a taken slot is refused and the original is untouched', async () => {
    const demo = await login(t, DEMO);
    const two = await login(t, TWO);
    const mine = (await demo.post('/me/appointments').send(followUp('09:00')).expect(201)).body;
    await two.post('/me/appointments').send(followUp('11:00')).expect(201);

    const refused = await demo.post(`/me/appointments/${mine.id}/reschedule`).send({ start: at('11:00') }).expect(422);
    expect(refused.body.reasons.map((r: { code: string }) => r.code)).toEqual(['NOT_AVAILABLE']);

    const after = (await demo.get('/me/appointments').expect(200)).body[0];
    expect(after).toMatchObject({ start: at('09:00'), status: 'BOOKED' });
  });

  it('cancelling my own appointment', async () => {
    const browser = await login(t, DEMO);
    const booked = (await browser.post('/me/appointments').send(followUp('09:00')).expect(201)).body;

    const res = await browser.delete(`/me/appointments/${booked.id}`).set('Content-Type', 'application/json').expect(200);
    expect(res.body.status).toBe('CANCELLED');
  });
});

describe('audit log', () => {
  it('D1. login, failed login, book, move and cancel are recorded against the patient from the session', async () => {
    await t.http().post('/auth/request-code').send({ email: DEMO });
    const wrong = t.inbox.lastCode(DEMO) === '000000' ? '111111' : '000000';
    await t.http().post('/auth/verify').send({ email: DEMO, code: wrong }).expect(401);
    const browser = await login(t, DEMO);
    const booked = (await browser.post('/me/appointments').send(followUp('09:00')).expect(201)).body;
    await browser.post(`/me/appointments/${booked.id}/reschedule`).send({ start: at('11:00') }).expect(200);
    await browser.delete(`/me/appointments/${booked.id}`).set('Content-Type', 'application/json').expect(200);

    const events = await t.prisma.auditEvent.findMany({
      where: { actorId: clinic.patients.demo.id },
      orderBy: { at: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['LOGIN_SUCCEEDED', 'APPOINTMENT_BOOKED', 'APPOINTMENT_RESCHEDULED', 'APPOINTMENT_CANCELLED']),
    );
    for (const e of events.filter((e) => e.action.startsWith('APPOINTMENT_'))) {
      expect(e).toMatchObject({ actorType: 'PATIENT', entityType: 'Appointment', entityId: booked.id });
    }
    // A failed login has no patient yet (the code proved nothing), so it's recorded as SYSTEM with the IP.
    expect(await t.prisma.auditEvent.count({ where: { action: 'LOGIN_FAILED', at: { gte: t.clock.now() } } })).toBeGreaterThan(0);
  });

  it('D2. the audit log never contains codes, session tokens or dates of birth', async () => {
    const browser = t.browser();
    await browser.post('/auth/request-code').send({ email: DEMO });
    const code = t.inbox.lastCode(DEMO);
    const res = await browser.post('/auth/verify').send({ email: DEMO, code }).expect(200);
    const token = decodeURIComponent(([] as string[]).concat(res.headers['set-cookie'])[0].split(';')[0].slice('session='.length));
    await browser.post('/me/appointments').send(followUp('09:00')).expect(201);

    const everything = JSON.stringify(await t.prisma.auditEvent.findMany());
    expect(everything).not.toContain(code);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain('1990-01-15'); // the demo patient's date of birth
  });

  it('the audit log is append-only: rows cannot be changed or deleted', async () => {
    await login(t, DEMO);
    const [event] = await t.prisma.auditEvent.findMany({ take: 1 });

    await expect(t.prisma.auditEvent.update({ where: { id: event.id }, data: { action: 'NOTHING_HAPPENED' } })).rejects.toThrow();
    await expect(t.prisma.auditEvent.delete({ where: { id: event.id } })).rejects.toThrow();
  });
});
