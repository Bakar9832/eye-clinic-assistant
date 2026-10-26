// Staff: the day's schedule, recording and correcting outcomes, and who may do what.

import { DateTime } from 'luxon';
import { seedClinic } from '../prisma/clinic-data.js';
import { createTestApp, login, staffLogin, ZONE, type TestApp } from './harness.js';

let t: TestApp;
let clinic: Awaited<ReturnType<typeof seedClinic>>;

const DAY = '2030-01-07'; // Monday
const local = (time: string) => DateTime.fromISO(`${DAY}T${time}`, { zone: ZONE }).toJSDate();
const iso = (time: string) => local(time).toISOString();
const NOTE = 'Your eyes are healthy. No change to your glasses is needed.';

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  clinic = await t.reset();
});
afterAll(async () => {
  await t.app.close();
});

/** The demo patient books a follow-up with the given doctor at 09:00 on DAY; returns its id. */
// One patient can hold only one follow-up a day, so a second one goes to another patient.
async function bookFollowUp(doctor: 'ayesha' | 'bilal' = 'ayesha', time = '09:00', email = 'demo.patient@example.com') {
  const patient = await login(t, email);
  const res = await patient
    .post('/me/appointments')
    .send({ typeCode: 'FOLLOW_UP', start: iso(time), doctorId: clinic.resources[doctor].id })
    .expect(201);
  return res.body.id as string;
}

const outcome = (code = 'NO_CHANGE', patientNote = NOTE) => ({ code, patientNote });

describe('who may do what', () => {
  it('R4. every staff role can see the schedule; nobody else can', async () => {
    for (const email of ['dr.ayesha@clinic.example', 'reception@clinic.example', 'admin@clinic.example']) {
      const staff = await staffLogin(t, email);
      await staff.get('/staff/schedule').query({ day: DAY }).expect(200);
    }
    await t.http().get('/staff/schedule').query({ day: DAY }).expect(401);
    const patient = await login(t, 'test.two@example.com');
    await patient.get('/staff/schedule').query({ day: DAY }).expect(401);
  });

  it('R1. reception cannot record an outcome', async () => {
    const id = await bookFollowUp();
    t.clock.set(local('09:20'));
    const reception = await staffLogin(t, 'reception@clinic.example');
    const res = await reception.post(`/staff/appointments/${id}/outcome`).send(outcome()).expect(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('R2. an admin cannot record an outcome either: the doctor decides', async () => {
    const id = await bookFollowUp();
    t.clock.set(local('09:20'));
    const admin = await staffLogin(t, 'admin@clinic.example');
    await admin.post(`/staff/appointments/${id}/outcome`).send(outcome()).expect(403);
  });

  it("R3. Dr Bilal cannot record the outcome of Dr Ayesha's exam", async () => {
    const id = await bookFollowUp('ayesha');
    t.clock.set(local('09:20'));
    const bilal = await staffLogin(t, 'dr.bilal@clinic.example');
    const res = await bilal.post(`/staff/appointments/${id}/outcome`).send(outcome()).expect(403);
    expect(res.body.error).toBe('NOT_YOUR_PATIENT');
  });
});

describe('the schedule', () => {
  it('SC1. lists the day with patient names, and never emails or dates of birth', async () => {
    const id = await bookFollowUp();
    const reception = await staffLogin(t, 'reception@clinic.example');

    const res = await reception.get('/staff/schedule').query({ day: DAY }).expect(200);
    expect(res.body.appointments).toEqual([
      expect.objectContaining({
        id,
        start: iso('09:00'),
        status: 'BOOKED',
        patient: { fullName: 'Demo Patient' },
        doctor: 'Dr Ayesha',
        hasOutcome: false,
      }),
    ]);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('demo.patient@example.com');
    expect(body).not.toContain('1990-01-15');
  });

  it("marks a doctor's own exams, so the page only offers outcomes there", async () => {
    await bookFollowUp('ayesha', '09:00');
    await bookFollowUp('bilal', '12:00', 'test.two@example.com');

    const ayesha = await staffLogin(t, 'dr.ayesha@clinic.example');
    const mine = (await ayesha.get('/staff/schedule').query({ day: DAY }).expect(200)).body.appointments;
    expect(mine.map((a: { doctor: string; examinedByMe: boolean }) => [a.doctor, a.examinedByMe])).toEqual([
      ['Dr Ayesha', true],
      ['Dr Bilal', false],
    ]);

    const reception = await staffLogin(t, 'reception@clinic.example');
    const theirs = (await reception.get('/staff/schedule').query({ day: DAY }).expect(200)).body.appointments;
    expect(theirs.every((a: { examinedByMe: boolean }) => a.examinedByMe === false)).toBe(true);
  });

  it('rejects a missing or malformed day', async () => {
    const reception = await staffLogin(t, 'reception@clinic.example');
    await reception.get('/staff/schedule').expect(400);
    await reception.get('/staff/schedule').query({ day: '07/01/2030' }).expect(400);
  });
});

describe('recording an outcome', () => {
  it('O1. the examining doctor records it after the start; the appointment is COMPLETED', async () => {
    const id = await bookFollowUp();
    t.clock.set(local('09:20'));
    const ayesha = await staffLogin(t, 'dr.ayesha@clinic.example');

    const res = await ayesha.post(`/staff/appointments/${id}/outcome`).send(outcome('NEW_PRESCRIPTION')).expect(201);
    expect(res.body).toMatchObject({ code: 'NEW_PRESCRIPTION', patientNote: NOTE, correctedAt: null });
    expect((await t.prisma.appointment.findUniqueOrThrow({ where: { id } })).status).toBe('COMPLETED');
  });

  it('O2. not before the appointment has started', async () => {
    const id = await bookFollowUp();
    t.clock.set(local('08:59'));
    const ayesha = await staffLogin(t, 'dr.ayesha@clinic.example');
    const res = await ayesha.post(`/staff/appointments/${id}/outcome`).send(outcome()).expect(409);
    expect(res.body.error).toBe('TOO_EARLY');
  });

  it('O3. not for a cancelled appointment', async () => {
    const patient = await login(t, 'demo.patient@example.com');
    const booked = await patient
      .post('/me/appointments')
      .send({ typeCode: 'FOLLOW_UP', start: iso('09:00'), doctorId: clinic.resources.ayesha.id })
      .expect(201);
    await patient.delete(`/me/appointments/${booked.body.id}`).set('Content-Type', 'application/json').expect(200);

    t.clock.set(local('09:20'));
    const ayesha = await staffLogin(t, 'dr.ayesha@clinic.example');
    const res = await ayesha.post(`/staff/appointments/${booked.body.id}/outcome`).send(outcome()).expect(409);
    expect(res.body.error).toBe('NOT_RECORDABLE');
  });

  it('O4. only the four codes, and a note of 1-500 characters', async () => {
    const id = await bookFollowUp();
    t.clock.set(local('09:20'));
    const ayesha = await staffLogin(t, 'dr.ayesha@clinic.example');

    await ayesha.post(`/staff/appointments/${id}/outcome`).send(outcome('WORSE')).expect(400);
    await ayesha.post(`/staff/appointments/${id}/outcome`).send(outcome('NO_CHANGE', '')).expect(400);
    await ayesha.post(`/staff/appointments/${id}/outcome`).send(outcome('NO_CHANGE', 'x'.repeat(501))).expect(400);
    // Measurements aren't part of an outcome, so a body carrying them is refused.
    await ayesha
      .post(`/staff/appointments/${id}/outcome`)
      .send({ ...outcome(), measurements: { leftEye: '-1.25' } })
      .expect(400);
    await ayesha.post(`/staff/appointments/${id}/outcome`).send(outcome('NO_CHANGE', 'x'.repeat(500))).expect(201);
  });

  it('O5. recording a second time is refused: corrections go through PUT', async () => {
    const id = await bookFollowUp();
    t.clock.set(local('09:20'));
    const ayesha = await staffLogin(t, 'dr.ayesha@clinic.example');
    await ayesha.post(`/staff/appointments/${id}/outcome`).send(outcome()).expect(201);

    const res = await ayesha.post(`/staff/appointments/${id}/outcome`).send(outcome('NEW_PRESCRIPTION')).expect(409);
    expect(res.body.error).toBe('ALREADY_RECORDED');
  });

  it('O7. the audit log says an outcome was recorded, never what it says', async () => {
    const id = await bookFollowUp();
    t.clock.set(local('09:20'));
    const ayesha = await staffLogin(t, 'dr.ayesha@clinic.example');
    await ayesha.post(`/staff/appointments/${id}/outcome`).send(outcome()).expect(201);

    const events = await t.prisma.auditEvent.findMany({ where: { entityId: id } });
    expect(events.map((e) => e.action)).toContain('OUTCOME_RECORDED');
    expect(events.find((e) => e.action === 'OUTCOME_RECORDED')).toMatchObject({
      actorType: 'STAFF',
      actorId: clinic.staff.drAyesha.id,
    });
    expect(JSON.stringify(await t.prisma.auditEvent.findMany())).not.toContain(NOTE);
  });
});

describe('correcting an outcome', () => {
  async function recorded() {
    const id = await bookFollowUp();
    t.clock.set(local('09:20'));
    const ayesha = await staffLogin(t, 'dr.ayesha@clinic.example');
    await ayesha.post(`/staff/appointments/${id}/outcome`).send(outcome()).expect(201);
    return { id, ayesha };
  }

  it('O6. the recording doctor can correct it; it is marked as corrected and audited', async () => {
    const { id, ayesha } = await recorded();
    t.clock.advanceMinutes(60);

    const res = await ayesha
      .put(`/staff/appointments/${id}/outcome`)
      .send(outcome('NEW_PRESCRIPTION', 'Correction: you need new reading glasses.'))
      .expect(200);
    expect(res.body).toMatchObject({ code: 'NEW_PRESCRIPTION', correctedAt: t.clock.now().toISOString() });
    expect(await t.prisma.auditEvent.count({ where: { entityId: id, action: 'OUTCOME_CORRECTED' } })).toBe(1);
  });

  it('R5. reception cannot correct an outcome either, and the note stays as the doctor wrote it', async () => {
    const { id } = await recorded();
    const reception = await staffLogin(t, 'reception@clinic.example');

    const res = await reception
      .put(`/staff/appointments/${id}/outcome`)
      .send(outcome('NEW_PRESCRIPTION', 'Changed by the front desk.'))
      .expect(403);
    expect(res.body.error).toBe('FORBIDDEN');

    const saved = await t.prisma.outcome.findUniqueOrThrow({ where: { appointmentId: id } });
    expect(saved).toMatchObject({ code: 'NO_CHANGE', patientNote: NOTE, correctedAt: null });
  });

  it('O6b. another doctor cannot correct it', async () => {
    const { id } = await recorded();
    // Dr Bilal didn't do the exam, so he's refused before he even gets to the outcome.
    const bilal = await staffLogin(t, 'dr.bilal@clinic.example');
    await bilal.put(`/staff/appointments/${id}/outcome`).send(outcome()).expect(403);
  });

  it('O6c. after the edit window (72 hours from first recording) nobody can change it', async () => {
    const { id } = await recorded();

    // Days later: her 12-hour session from the recording has long ended, so she logs in again.
    t.clock.advanceMinutes(70 * 60); // 70 h: still allowed
    const ayesha = await staffLogin(t, 'dr.ayesha@clinic.example');
    await ayesha.put(`/staff/appointments/${id}/outcome`).send(outcome('NO_CHANGE', 'First fix.')).expect(200);

    // The correction at 70 h doesn't restart the clock: 73 h after the first recording is too late.
    t.clock.advanceMinutes(3 * 60);
    const res = await ayesha.put(`/staff/appointments/${id}/outcome`).send(outcome('NO_CHANGE', 'Second fix.')).expect(409);
    expect(res.body.error).toBe('EDIT_WINDOW_CLOSED');
  });

  it('the recording doctor can read it back to correct it, with the deadline; nobody else can', async () => {
    const { id, ayesha } = await recorded();

    const res = await ayesha.get(`/staff/appointments/${id}/outcome`).expect(200);
    expect(res.body).toMatchObject({
      code: 'NO_CHANGE',
      patientNote: NOTE,
      correctedAt: null,
      editable: true,
      editableUntil: new Date(local('09:20').getTime() + 72 * 3_600_000).toISOString(),
    });

    t.clock.advanceMinutes(73 * 60);
    const later = await staffLogin(t, 'dr.ayesha@clinic.example');
    expect((await later.get(`/staff/appointments/${id}/outcome`).expect(200)).body.editable).toBe(false);

    const bilal = await staffLogin(t, 'dr.bilal@clinic.example');
    await bilal.get(`/staff/appointments/${id}/outcome`).expect(403);
    const reception = await staffLogin(t, 'reception@clinic.example');
    await reception.get(`/staff/appointments/${id}/outcome`).expect(403);
  });

  it('the edit window is a clinic setting', async () => {
    const { id, ayesha } = await recorded();
    await t.prisma.clinicSetting.update({ where: { id: 1 }, data: { outcomeEditWindowHours: 1 } });

    t.clock.advanceMinutes(61);
    await ayesha.put(`/staff/appointments/${id}/outcome`).send(outcome()).expect(409);
  });
});

describe('glasses ready', () => {
  /** Dr Ayesha examines the demo patient at 09:00 and records this outcome; returns the appointment id. */
  async function examWith(code: string) {
    const id = await bookFollowUp();
    t.clock.set(local('09:20'));
    const ayesha = await staffLogin(t, 'dr.ayesha@clinic.example');
    await ayesha.post(`/staff/appointments/${id}/outcome`).send(outcome(code)).expect(201);
    return id;
  }

  it('G1. reception marks a new prescription ready; the time is saved and audited', async () => {
    const id = await examWith('NEW_PRESCRIPTION');
    const reception = await staffLogin(t, 'reception@clinic.example');

    const res = await reception.post(`/staff/appointments/${id}/glasses-ready`).send({}).expect(200);

    expect(res.body).toEqual({ appointmentId: id, glassesReadyAt: local('09:20').toISOString() });
    const audit = await t.prisma.auditEvent.findFirst({ where: { action: 'GLASSES_READY', entityId: id } });
    expect(audit).not.toBeNull();
  });

  it('G2. refused for another outcome, no outcome, twice, or a patient', async () => {
    const noChange = await examWith('NO_CHANGE');
    const reception = await staffLogin(t, 'reception@clinic.example');
    expect((await reception.post(`/staff/appointments/${noChange}/glasses-ready`).send({}).expect(409)).body.error).toBe('NO_NEW_GLASSES');

    const notExamined = await bookFollowUp('bilal', '12:00', 'test.two@example.com');
    await reception.post(`/staff/appointments/${notExamined}/glasses-ready`).send({}).expect(404);
    await reception.post('/staff/appointments/not-a-uuid/glasses-ready').send({}).expect(404);

    await t.prisma.outcome.update({ where: { appointmentId: noChange }, data: { code: 'NEW_PRESCRIPTION' } });
    await reception.post(`/staff/appointments/${noChange}/glasses-ready`).send({}).expect(200);
    expect((await reception.post(`/staff/appointments/${noChange}/glasses-ready`).send({}).expect(409)).body.error).toBe('ALREADY_MARKED');

    const patient = await login(t, 'demo.patient@example.com');
    await patient.post(`/staff/appointments/${noChange}/glasses-ready`).send({}).expect(401);
  });

  it('G4. the patient sees when the glasses are ready, after the date-of-birth check', async () => {
    const id = await examWith('NEW_PRESCRIPTION');
    const patient = await login(t, 'demo.patient@example.com');
    await patient.post('/me/verify-dob').send({ dateOfBirth: '1990-01-15' }).expect(200);
    expect((await patient.get('/me/outcome').expect(200)).body.glassesReadyAt).toBeNull();

    const reception = await staffLogin(t, 'reception@clinic.example');
    await reception.post(`/staff/appointments/${id}/glasses-ready`).send({}).expect(200);

    expect((await patient.get('/me/outcome').expect(200)).body.glassesReadyAt).toBe(local('09:20').toISOString());
  });

  it('G5. the Glasses list shows only new prescriptions still waiting', async () => {
    const waiting = await examWith('NEW_PRESCRIPTION');
    const reception = await staffLogin(t, 'reception@clinic.example');

    const list = (await reception.get('/staff/glasses').expect(200)).body;
    expect(list).toEqual([
      { appointmentId: waiting, reference: expect.any(String), patient: { fullName: 'Demo Patient' }, examDate: iso('09:00'), doctor: 'Dr Ayesha' },
    ]);

    await reception.post(`/staff/appointments/${waiting}/glasses-ready`).send({}).expect(200);
    expect((await reception.get('/staff/glasses').expect(200)).body).toEqual([]);
  });
});
