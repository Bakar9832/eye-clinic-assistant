// Reception booking on a patient's behalf, and overrides: soft rules can be bent with
// a reason after seeing the warnings; hard rules never.

import { DateTime } from 'luxon';
import { seedClinic } from '../prisma/clinic-data.js';
import { createTestApp, login, staffLogin, ZONE, type TestApp } from './harness.js';

let t: TestApp;
let clinic: Awaited<ReturnType<typeof seedClinic>>;

const MON = '2030-01-07';
const SAT = '2030-01-12';
const at = (time: string, day = MON) => DateTime.fromISO(`${day}T${time}`, { zone: ZONE }).toUTC().toISO()!;
const REASON = 'Patient is travelling and can only come after work.';

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  clinic = await t.reset();
});
afterAll(async () => {
  await t.app.close();
});

const reception = () => staffLogin(t, 'reception@clinic.example');
const followUp = (time: string, extra: Record<string, unknown> = {}) => ({
  patientId: clinic.patients.two.id,
  typeCode: 'FOLLOW_UP',
  start: at(time),
  doctorId: clinic.resources.ayesha.id,
  ...extra,
});

describe('booking for a patient', () => {
  it('V1. reception books a normal slot; the audit names the staff member', async () => {
    const desk = await reception();
    const res = await desk.post('/staff/appointments').send(followUp('09:00')).expect(201);

    const saved = await t.prisma.appointment.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(saved.patientId).toBe(clinic.patients.two.id);
    const event = await t.prisma.auditEvent.findFirstOrThrow({ where: { entityId: res.body.id, action: 'APPOINTMENT_BOOKED' } });
    expect(event).toMatchObject({ actorType: 'STAFF', actorId: clinic.staff.reception.id });
  });

  it('V2. doctors and patients cannot use the staff booking route', async () => {
    const doctor = await staffLogin(t, 'dr.ayesha@clinic.example');
    await doctor.post('/staff/appointments').send(followUp('09:00')).expect(403);
    const patient = await login(t, 'test.two@example.com');
    await patient.post('/staff/appointments').send(followUp('09:00')).expect(401);
  });

  it('reception can find a patient by name or email, without seeing dates of birth', async () => {
    const desk = await reception();
    const res = await desk.get('/staff/patients').query({ query: 'demo' }).expect(200);
    expect(res.body).toEqual([{ id: clinic.patients.demo.id, fullName: 'Demo Patient', email: 'demo.patient@example.com' }]);
    await desk.get('/staff/patients').query({ query: 'd' }).expect(400);
  });
});

describe('overrides', () => {
  it('V3. outside working hours, no override: refused with the reasons spelled out', async () => {
    const desk = await reception();
    const res = await desk.post('/staff/appointments').send(followUp('17:00')).expect(409);

    expect(res.body.error).toBe('OVERRIDE_REQUIRED');
    expect(res.body.reasons).toEqual([
      { code: 'OUTSIDE_WORKING_HOURS', message: 'Dr Ayesha: 17:00-17:15 is outside their working hours.' },
    ]);
    expect(await t.prisma.appointment.count()).toBe(0);
  });

  it('V4. with a reason it is booked, and the reason and warnings are audited', async () => {
    const desk = await reception();
    const res = await desk.post('/staff/appointments').send(followUp('17:00', { override: { reason: REASON } })).expect(201);

    const event = await t.prisma.auditEvent.findFirstOrThrow({ where: { entityId: res.body.id, action: 'APPOINTMENT_BOOKED' } });
    expect(event.details).toEqual({
      override: true,
      reason: REASON,
      warnings: ['Dr Ayesha: 17:00-17:15 is outside their working hours.'],
    });
  });

  it('an off-grid time is a soft rule too', async () => {
    const desk = await reception();
    const refused = await desk.post('/staff/appointments').send(followUp('10:07')).expect(409);
    expect(refused.body.reasons.map((r: { code: string }) => r.code)).toEqual(['NOT_ON_GRID']);
    await desk.post('/staff/appointments').send(followUp('10:07', { override: { reason: REASON } })).expect(201);
  });

  it('V5. an override needs a real reason', async () => {
    const desk = await reception();
    await desk.post('/staff/appointments').send(followUp('17:00', { override: { reason: 'ok' } })).expect(400);
    await desk.post('/staff/appointments').send(followUp('17:00', { override: {} })).expect(400);
  });

  describe('V6. an override never bends the hard rules', () => {
    it('no double booking', async () => {
      const desk = await reception();
      await desk.post('/staff/appointments').send(followUp('17:00', { override: { reason: REASON } })).expect(201);
      const res = await desk
        .post('/staff/appointments')
        .send(followUp('17:05', { patientId: clinic.patients.demo.id, override: { reason: REASON } }))
        .expect(422);
      expect(res.body.reasons[0].code).toBe('NOT_AVAILABLE');
    });

    it('nobody on leave', async () => {
      await t.prisma.timeOff.create({
        data: {
          resourceId: clinic.resources.bilal.id,
          startsAt: new Date(at('00:00')),
          endsAt: new Date(at('00:00', '2030-01-08')),
          reason: 'Leave',
        },
      });
      const desk = await reception();
      await desk
        .post('/staff/appointments')
        .send(followUp('12:00', { doctorId: clinic.resources.bilal.id, override: { reason: REASON } }))
        .expect(422);
    });

    it('nobody unqualified: when Sara is busy, Usman (pre-tests only) is not given a scan', async () => {
      const desk = await reception();
      const TUE = '2030-01-08'; // both technicians work Tuesdays
      // Sara is taken 11:00-11:10 by another patient's scan.
      await desk
        .post('/staff/appointments')
        .send({ patientId: clinic.patients.demo.id, typeCode: 'SCAN_ONLY', start: at('11:00', TUE) })
        .expect(201);

      const res = await desk
        .post('/staff/appointments')
        .send({ patientId: clinic.patients.two.id, typeCode: 'SCAN_ONLY', start: at('11:00', TUE), override: { reason: REASON } })
        .expect(422);
      expect(res.body.reasons[0].code).toBe('NOT_AVAILABLE');
    });

    it("nobody on their day off: an override stretches someone's hours, it doesn't call them in", async () => {
      // Saturday: Sara (the only SCAN technician) doesn't work at all.
      const desk = await reception();
      await desk
        .post('/staff/appointments')
        .send({ patientId: clinic.patients.two.id, typeCode: 'SCAN_ONLY', start: at('11:00', SAT), override: { reason: REASON } })
        .expect(422);
    });

    it('nothing in the past', async () => {
      t.clock.set(new Date(at('18:00')));
      const desk = await reception();
      const res = await desk.post('/staff/appointments').send(followUp('17:00', { override: { reason: REASON } })).expect(422);
      expect(res.body.reasons[0].code).toBe('IN_THE_PAST');
    });
  });
});
