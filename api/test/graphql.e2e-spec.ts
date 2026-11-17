// The staff dashboard's GraphQL API at /staff/graphql: queries, the cancel mutation,
// and errors. It reads through StaffDashboardService and cancels through BookingService,
// the same service the REST API and the chat use.

import { DateTime } from 'luxon';
import { seedClinic } from '../prisma/clinic-data.js';
import { createTestApp, login, staffLogin, ZONE, type TestApp } from './harness.js';

let t: TestApp;
let clinic: Awaited<ReturnType<typeof seedClinic>>;

const MON = '2030-01-07';
const DEMO = 'demo.patient@example.com';
const TWO = 'test.two@example.com';
const RECEPTION = 'reception@clinic.example';

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  clinic = await t.reset();
});
afterAll(async () => {
  await t.app.close();
});

type Browser = ReturnType<TestApp['browser']>;
type GqlBody = { data?: Record<string, unknown> | null; errors?: { message: string; extensions: { code: string } }[] };

/** One GraphQL request from this browser; the body as the dashboard would get it. */
async function gql(browser: Browser, query: string, variables: Record<string, unknown> = {}) {
  const res = await browser.post('/staff/graphql').send({ query, variables });
  return res.body as GqlBody;
}

/** A patient books through the calendar's REST route, as in real use. */
async function book(email: string, time: string, doctorId = clinic.resources.ayesha.id, typeCode = 'FOLLOW_UP') {
  const browser = await login(t, email);
  const res = await browser
    .post('/me/appointments')
    .send({ typeCode, start: DateTime.fromISO(`${MON}T${time}`, { zone: ZONE }).toUTC().toISO(), doctorId })
    .expect(201);
  return res.body as { id: string; reference: string };
}

const DAY = `query Day($date: String!) {
  appointments(date: $date) { id reference start status typeName doctor { id name } patient { id fullName email } }
}`;

describe('staff only', () => {
  const EVERY_OPERATION = [
    '{ doctors { id } }',
    `{ doctor(id: "00000000-0000-0000-0000-000000000000") { id } }`,
    `{ appointments(date: "${MON}") { id patient { email } } }`,
    'mutation { cancelAppointment(id: "00000000-0000-0000-0000-000000000000") { id } }',
  ];

  it('S1. without a staff login every query and the mutation are refused, with no data', async () => {
    await book(DEMO, '10:00');
    for (const query of EVERY_OPERATION) {
      const body = (await t.http().post('/staff/graphql').send({ query })).body as GqlBody;
      expect(body.errors![0].extensions.code, query).toBe('UNAUTHENTICATED');
      expect(body.data ?? null, query).toBeNull();
    }
  });

  it("S2. a logged-in patient can't use it to read anyone's data, their own included", async () => {
    await book(TWO, '12:00', clinic.resources.bilal.id);
    const patient = await login(t, DEMO);
    for (const query of EVERY_OPERATION) {
      const res = await patient.post('/staff/graphql').send({ query });
      expect((res.body as GqlBody).errors![0].extensions.code, query).toBe('UNAUTHENTICATED');
      expect(res.text, query).not.toContain(TWO);
    }
  });

  it("S3. a patient's session token in the staff cookie is still refused", async () => {
    await t.http().post('/auth/request-code').send({ email: DEMO }).expect(202);
    const verified = await t
      .http()
      .post('/auth/verify')
      .send({ email: DEMO, code: t.inbox.lastCode(DEMO) })
      .expect(200);
    const token = /session=([^;]+)/.exec(String(verified.headers['set-cookie']))![1];

    const body = (await t.http().post('/staff/graphql').set('Cookie', `staff_session=${token}`).send({ query: '{ doctors { id } }' })).body as GqlBody;
    expect(body.errors![0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it('S4. in development, the schema can be explored: introspection and the GraphiQL page', async () => {
    const reception = await staffLogin(t, RECEPTION);
    const body = await gql(reception, '{ __schema { queryType { name } } }');
    expect(body.data).toEqual({ __schema: { queryType: { name: 'Query' } } });

    const page = await t.http().get('/staff/graphql').set('Accept', 'text/html');
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/graphiql/i);
  });
});

describe('queries', () => {
  it('Q1. doctors: every active doctor, by name', async () => {
    const reception = await staffLogin(t, RECEPTION);
    const body = await gql(reception, '{ doctors { id name } }');

    expect(body.errors).toBeUndefined();
    expect(body.data!.doctors).toEqual([
      { id: clinic.resources.ayesha.id, name: 'Dr Ayesha' },
      { id: clinic.resources.bilal.id, name: 'Dr Bilal' },
    ]);
  });

  it("Q2. doctor(id) with that doctor's appointments on one day only", async () => {
    const ayeshas = await book(DEMO, '10:00');
    await book(TWO, '12:00', clinic.resources.bilal.id);

    const reception = await staffLogin(t, RECEPTION);
    const body = await gql(reception, 'query($id: ID!, $date: String!) { doctor(id: $id) { name appointments(date: $date) { reference } } }', {
      id: clinic.resources.ayesha.id,
      date: MON,
    });

    expect(body.data!.doctor).toEqual({ name: 'Dr Ayesha', appointments: [{ reference: ayeshas.reference }] });
  });

  it('Q3. appointments(date) with each one\'s doctor and patient, and no date of birth anywhere', async () => {
    const first = await book(DEMO, '10:00');
    const second = await book(TWO, '12:00', clinic.resources.bilal.id);

    const reception = await staffLogin(t, RECEPTION);
    const res = await reception.post('/staff/graphql').send({ query: DAY, variables: { date: MON } });
    const body = res.body as GqlBody;

    expect(body.data!.appointments).toEqual([
      {
        id: first.id,
        reference: first.reference,
        start: DateTime.fromISO(`${MON}T10:00`, { zone: ZONE }).toUTC().toISO(),
        status: 'BOOKED',
        typeName: expect.any(String),
        doctor: { id: clinic.resources.ayesha.id, name: 'Dr Ayesha' },
        patient: { id: clinic.patients.demo.id, fullName: 'Demo Patient', email: DEMO },
      },
      expect.objectContaining({ id: second.id, doctor: { id: clinic.resources.bilal.id, name: 'Dr Bilal' }, patient: expect.objectContaining({ email: TWO }) }),
    ]);
    expect(res.text).not.toMatch(/1990-01-15|dateOfBirth/);
  });

  it('Q4. a day with no appointments is an empty list', async () => {
    const reception = await staffLogin(t, RECEPTION);
    expect((await gql(reception, DAY, { date: '2030-01-08' })).data!.appointments).toEqual([]);
  });
});

describe('errors: a code and a message, never a stack trace', () => {
  it('E1. an unknown or malformed doctor id: NOT_FOUND', async () => {
    const reception = await staffLogin(t, RECEPTION);
    for (const id of ['not-a-uuid', clinic.patients.demo.id]) {
      const res = await reception.post('/staff/graphql').send({ query: 'query($id: ID!) { doctor(id: $id) { name } }', variables: { id } });
      const body = res.body as GqlBody;
      expect(body.errors![0]).toMatchObject({ message: 'Doctor not found.', extensions: { code: 'NOT_FOUND' } });
      expect(res.text).not.toMatch(/stacktrace|at .*\.ts:\d+/);
    }
  });

  it('E2. a malformed date: BAD_USER_INPUT', async () => {
    const reception = await staffLogin(t, RECEPTION);
    const body = await gql(reception, DAY, { date: '07/01/2030' });
    expect(body.errors![0].extensions.code).toBe('BAD_USER_INPUT');
  });
});

describe('cancelAppointment: the same cancel as REST', () => {
  const CANCEL = 'mutation($id: ID!) { cancelAppointment(id: $id) { id status } }';

  it('C1. reception cancels an upcoming booking: CANCELLED, the time is free again, audited as reception', async () => {
    const booked = await book(DEMO, '10:00');
    const reception = await staffLogin(t, RECEPTION);

    const body = await gql(reception, CANCEL, { id: booked.id });

    expect(body.data!.cancelAppointment).toEqual({ id: booked.id, status: 'CANCELLED' });
    expect(await t.prisma.resourceAllocation.count({ where: { appointmentId: booked.id, active: true } })).toBe(0);
    const audit = await t.prisma.auditEvent.findFirstOrThrow({ where: { entityId: booked.id, action: 'APPOINTMENT_CANCELLED' } });
    expect(audit).toMatchObject({ actorType: 'STAFF', actorId: clinic.staff.reception.id });
    // Freed: another patient can now book that exact time.
    await book(TWO, '10:00');
  });

  it('C2. same rules as the patient\'s REST cancel: a second cancel and a past appointment are refused', async () => {
    const booked = await book(DEMO, '10:00');
    const reception = await staffLogin(t, RECEPTION);
    await gql(reception, CANCEL, { id: booked.id });

    const again = await gql(reception, CANCEL, { id: booked.id });
    expect(again.errors![0].extensions.code).toBe('NOT_CANCELLABLE');

    const later = await book(TWO, '11:00');
    t.clock.set(DateTime.fromISO(`${MON}T12:00`, { zone: ZONE }).toJSDate());
    // A new login: moving the clock six days on has expired the earlier staff session.
    const past = await gql(await staffLogin(t, RECEPTION), CANCEL, { id: later.id });
    expect(past.errors![0].extensions.code).toBe('NOT_CANCELLABLE');
    // The REST route gives the patient the very same answer.
    const patient = await login(t, TWO);
    expect((await patient.delete(`/me/appointments/${later.id}`).send({})).body.error).toBe('NOT_CANCELLABLE');
  });

  it('C3. an unknown appointment: NOT_FOUND, nothing changed', async () => {
    const booked = await book(DEMO, '10:00');
    const reception = await staffLogin(t, RECEPTION);
    for (const id of ['nope', clinic.patients.demo.id]) {
      expect((await gql(reception, CANCEL, { id })).errors![0].extensions.code).toBe('NOT_FOUND');
    }
    expect((await t.prisma.appointment.findUniqueOrThrow({ where: { id: booked.id } })).status).toBe('BOOKED');
  });

  it('C4. a doctor may read the day but not cancel: FORBIDDEN', async () => {
    const booked = await book(DEMO, '10:00');
    const doctor = await staffLogin(t, 'dr.ayesha@clinic.example');

    expect((await gql(doctor, DAY, { date: MON })).data!.appointments).toHaveLength(1);
    expect((await gql(doctor, CANCEL, { id: booked.id })).errors![0].extensions.code).toBe('FORBIDDEN');
    expect((await t.prisma.appointment.findUniqueOrThrow({ where: { id: booked.id } })).status).toBe('BOOKED');
  });
});
