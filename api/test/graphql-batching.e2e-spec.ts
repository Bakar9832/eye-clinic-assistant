// N+1: how many SQL queries one dashboard request sends, read from Prisma's own query
// log. A day's appointments each need a doctor and a patient; without batching that is
// two more queries per appointment, with DataLoader it is two in all.

import { DateTime } from 'luxon';
import { seedClinic } from '../prisma/clinic-data.js';
import { requireEnv } from '../src/config.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createPrismaClient } from '../src/prisma/create-client.js';
import { createTestApp, login, staffLogin, ZONE, type TestApp } from './harness.js';

let t: TestApp;
let clinic: Awaited<ReturnType<typeof seedClinic>>;
const sql: string[] = [];

const MON = '2030-01-07';
const DAY = `query Day($date: String!) {
  appointments(date: $date) { reference doctor { name } patient { fullName } }
}`;

beforeAll(async () => {
  const prisma = createPrismaClient(requireEnv('TEST_DATABASE_URL'), { log: [{ emit: 'event', level: 'query' }] });
  (prisma as unknown as { $on(event: 'query', cb: (e: { query: string }) => void): void }).$on('query', (e) => sql.push(e.query));
  t = await createTestApp(prisma as PrismaClient);
});
beforeEach(async () => {
  clinic = await t.reset();
});
afterAll(async () => {
  await t.app.close();
});

/** Books through the calendar's REST route: [patient email, type, clinic time, doctor]. */
async function bookAll(bookings: [string, string, string, 'ayesha' | 'bilal'][]) {
  for (const [email, typeCode, time, doctor] of bookings) {
    const browser = await login(t, email);
    await browser
      .post('/me/appointments')
      .send({ typeCode, start: DateTime.fromISO(`${MON}T${time}`, { zone: ZONE }).toUTC().toISO(), doctorId: clinic.resources[doctor].id })
      .expect(201);
  }
}

/** The SQL statements one dashboard request sent, and the appointments it returned. */
async function measure() {
  const reception = await staffLogin(t, 'reception@clinic.example');
  sql.length = 0;
  const res = await reception.post('/staff/graphql').send({ query: DAY, variables: { date: MON } }).expect(200);
  return { queries: [...sql], appointments: (res.body.data.appointments as unknown[]).length };
}

const DEMO = 'demo.patient@example.com';
const TWO = 'test.two@example.com';
const THREE = 'test.three@example.com';

it('B1. the query count does not grow with the number of appointments', async () => {
  // Each patient books twice on one day here, to fill the day: lift the per-day limit (test setup only).
  await t.prisma.clinicSetting.update({ where: { id: 1 }, data: { maxAppointmentsPerDay: 0 } });
  await bookAll([
    [DEMO, 'FOLLOW_UP', '09:00', 'ayesha'],
    [TWO, 'FOLLOW_UP', '12:00', 'bilal'],
  ]);
  const two = await measure();

  await bookAll([
    [THREE, 'FOLLOW_UP', '10:00', 'ayesha'],
    [DEMO, 'ROUTINE_EYE_TEST', '11:00', 'ayesha'],
    [TWO, 'ROUTINE_EYE_TEST', '15:00', 'bilal'],
    [THREE, 'ROUTINE_EYE_TEST', '16:00', 'bilal'],
  ]);
  const six = await measure();

  console.log(`[N+1] 2 appointments: ${two.queries.length} queries; 6 appointments: ${six.queries.length} queries`);
  console.log(six.queries.map((q, i) => `  ${i + 1}. ${q.replace(/\s+/g, ' ').slice(0, 110)}`).join('\n'));
  expect([two.appointments, six.appointments]).toEqual([2, 6]);
  expect(six.queries.length).toBe(two.queries.length);
  // All six patients in one query.
  expect(six.queries.filter((q) => q.includes('FROM "public"."patients"'))).toHaveLength(1);
});

it('B2. loaders live for one request: the next request sees a change made in between', async () => {
  await bookAll([[DEMO, 'FOLLOW_UP', '09:00', 'ayesha']]);
  const reception = await staffLogin(t, 'reception@clinic.example');
  const day = async () => (await reception.post('/staff/graphql').send({ query: DAY, variables: { date: MON } })).body.data.appointments;
  expect((await day())[0].patient.fullName).toBe('Demo Patient');

  const patient = await login(t, DEMO);
  await patient.patch('/me').send({ fullName: 'Renamed Patient' }).expect(200);

  expect((await day())[0].patient.fullName).toBe('Renamed Patient');
});
