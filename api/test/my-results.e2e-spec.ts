// A patient reading their result: date-of-birth step-up, the doctor's note word for
// word, the "edited" tag, and never anyone else's result.

import { DateTime } from 'luxon';
import { seedClinic } from '../prisma/clinic-data.js';
import { createTestApp, login, staffLogin, ZONE, type TestApp } from './harness.js';

let t: TestApp;
let clinic: Awaited<ReturnType<typeof seedClinic>>;

const DAY = '2030-01-07';
const local = (time: string) => DateTime.fromISO(`${DAY}T${time}`, { zone: ZONE }).toJSDate();
const DEMO = 'demo.patient@example.com';
const DEMO_DOB = '1990-01-15';
// Punctuation, line breaks, symbols, HTML-looking text and an emoji: must all come back exactly.
const TRICKY_NOTE = 'Line one.\nLine two: “quoted”, 50% & <b>not html</b>, -1.25 is fine 👓';

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  clinic = await t.reset();
});
afterAll(async () => {
  await t.app.close();
});

/** Books a follow-up for this patient at 09:00 and has Dr Ayesha record an outcome at 09:20. */
async function resultFor(email: string, note = TRICKY_NOTE) {
  t.clock.set(new Date('2030-01-01T05:00:00Z'));
  const patient = await login(t, email);
  const booked = await patient
    .post('/me/appointments')
    .send({ typeCode: 'FOLLOW_UP', start: local('09:00').toISOString(), doctorId: clinic.resources.ayesha.id })
    .expect(201);
  t.clock.set(local('09:20'));
  const ayesha = await staffLogin(t, 'dr.ayesha@clinic.example');
  await ayesha.post(`/staff/appointments/${booked.body.id}/outcome`).send({ code: 'NO_CHANGE', patientNote: note }).expect(201);
  return { appointmentId: booked.body.id as string, ayesha };
}

describe('date-of-birth check', () => {
  it('P1. results need the date-of-birth check, even just to hear "not yet"', async () => {
    const patient = await login(t, DEMO);
    const res = await patient.get('/me/outcome').expect(403);
    expect(res.body.error).toBe('DOB_REQUIRED');
  });

  it('P2. a wrong date is refused; the 5th wrong one ends the session', async () => {
    const patient = await login(t, DEMO);
    for (let i = 1; i <= 4; i++) {
      const res = await patient.post('/me/verify-dob').send({ dateOfBirth: '1991-01-01' }).expect(401);
      expect(res.body.error).toBe('DOB_MISMATCH');
    }
    const fifth = await patient.post('/me/verify-dob').send({ dateOfBirth: '1991-01-01' }).expect(401);
    expect(fifth.body.error).toBe('DOB_LOCKED');

    await patient.get('/me').expect(401); // logged out
  });

  it('P4. the unlock lasts 15 minutes', async () => {
    const patient = await login(t, DEMO);
    await patient.post('/me/verify-dob').send({ dateOfBirth: DEMO_DOB }).expect(200);
    t.clock.advanceMinutes(14);
    await patient.get('/me/outcome').expect(200);
    t.clock.advanceMinutes(2);
    await patient.get('/me/outcome').expect(403);
  });

  it('P7. passing the check in one session does not unlock another', async () => {
    const laptop = await login(t, DEMO);
    const phone = await login(t, DEMO);
    await laptop.post('/me/verify-dob').send({ dateOfBirth: DEMO_DOB }).expect(200);

    await laptop.get('/me/outcome').expect(200);
    await phone.get('/me/outcome').expect(403);
  });
});

describe('reading the result', () => {
  it('P5. no outcome yet: NOT_READY', async () => {
    const patient = await login(t, DEMO);
    await patient.post('/me/verify-dob').send({ dateOfBirth: DEMO_DOB }).expect(200);
    expect((await patient.get('/me/outcome').expect(200)).body).toEqual({ status: 'NOT_READY' });
  });

  it("P3. the doctor's note comes back character for character", async () => {
    await resultFor(DEMO);
    const patient = await login(t, DEMO);
    await patient.post('/me/verify-dob').send({ dateOfBirth: DEMO_DOB }).expect(200);

    const res = await patient.get('/me/outcome').expect(200);
    expect(res.body.doctorNote).toBe(TRICKY_NOTE);
  });

  it('P8. only the outcome, the note, the date, the type, the doctor and whether glasses are ready', async () => {
    await resultFor(DEMO);
    const patient = await login(t, DEMO);
    await patient.post('/me/verify-dob').send({ dateOfBirth: DEMO_DOB }).expect(200);

    const res = await patient.get('/me/outcome').expect(200);
    expect(res.body).toEqual({
      status: 'READY',
      outcome: 'NO_CHANGE',
      doctorNote: TRICKY_NOTE,
      doctorName: 'Dr Ayesha',
      appointment: { date: local('09:00').toISOString(), type: 'Follow-up visit' },
      recordedAt: local('09:20').toISOString(),
      edited: false,
      editedAt: null,
      glassesReadyAt: null,
    });
  });

  it('shows an "edited" tag once the doctor has corrected the result', async () => {
    const { appointmentId, ayesha } = await resultFor(DEMO);
    t.clock.advanceMinutes(30);
    await ayesha
      .put(`/staff/appointments/${appointmentId}/outcome`)
      .send({ code: 'NEW_PRESCRIPTION', patientNote: 'Updated: new reading glasses will help.' })
      .expect(200);

    const patient = await login(t, DEMO);
    await patient.post('/me/verify-dob').send({ dateOfBirth: DEMO_DOB }).expect(200);
    const res = await patient.get('/me/outcome').expect(200);
    expect(res.body).toMatchObject({
      outcome: 'NEW_PRESCRIPTION',
      doctorNote: 'Updated: new reading glasses will help.',
      edited: true,
      editedAt: t.clock.now().toISOString(),
    });
  });

  it("P6. a patient never gets another patient's result", async () => {
    await resultFor('test.two@example.com', 'Private note for patient two.');

    const demo = await login(t, DEMO);
    await demo.post('/me/verify-dob').send({ dateOfBirth: DEMO_DOB }).expect(200);
    const res = await demo.get('/me/outcome').expect(200);

    expect(res.body).toEqual({ status: 'NOT_READY' });
    expect(JSON.stringify(res.body)).not.toContain('Private note');
  });

  it('the audit log records that results were viewed, never the dates of birth tried', async () => {
    await resultFor(DEMO);
    const patient = await login(t, DEMO);
    await patient.post('/me/verify-dob').send({ dateOfBirth: '1999-09-09' }).expect(401);
    await patient.post('/me/verify-dob').send({ dateOfBirth: DEMO_DOB }).expect(200);
    await patient.get('/me/outcome').expect(200);

    const actions = (await t.prisma.auditEvent.findMany({ where: { actorId: clinic.patients.demo.id } })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['DOB_CHECK_FAILED', 'DOB_CHECK_PASSED', 'RESULTS_VIEWED']));
    const everything = JSON.stringify(await t.prisma.auditEvent.findMany());
    expect(everything).not.toContain('1999-09-09');
    expect(everything).not.toContain(DEMO_DOB);
  });
});
