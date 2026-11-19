// The guardrail log: every refused patient action is recorded, and staff can read it.

import { DateTime } from 'luxon';
import { seedClinic } from '../prisma/clinic-data.js';
import { agentTokenFor, createTestApp, login, mcpClient, staffLogin, ZONE, type TestApp } from './harness.js';

let t: TestApp;
let clinic: Awaited<ReturnType<typeof seedClinic>>;
const DEMO = 'demo.patient@example.com';
const MON = '2030-01-07';
const at = (time: string, day = MON) => DateTime.fromISO(`${day}T${time}`, { zone: ZONE }).toUTC().toISO()!;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  clinic = await t.reset();
});
afterAll(async () => {
  await t.app.close();
});

describe('what is logged', () => {
  it('GL1. a refused calendar booking is logged once: patient, action, reason code and message; a success is not', async () => {
    const browser = await login(t, DEMO);
    const booked = (await browser.post('/me/appointments').send({ typeCode: 'FOLLOW_UP', start: at('09:00') }).expect(201)).body;
    expect(await t.prisma.guardrailEvent.count()).toBe(0);

    await browser.post('/me/appointments').send({ typeCode: 'SCAN_ONLY', start: at('11:00') }).expect(409);

    const events = await t.prisma.guardrailEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'BLOCKED',
      patientId: clinic.patients.demo.id,
      action: 'BOOK',
      reasonCode: 'ALREADY_BOOKED',
      conversationId: null,
    });
    expect(events[0].message).toContain(booked.reference);
    expect(events[0].createdAt.toISOString()).toBe(t.clock.now().toISOString());
  });

  it('GL2. a refusal through the chat tools records the conversation it came from', async () => {
    const browser = await login(t, DEMO);
    const client = await mcpClient(t, await agentTokenFor(t, browser));
    await client.callTool({ name: 'book', arguments: { type: 'URGENT_VISIT', date: MON, time: '10:00' } });

    const [event] = await t.prisma.guardrailEvent.findMany();
    const conversation = await t.prisma.conversation.findFirstOrThrow({ where: { patientId: clinic.patients.demo.id } });
    expect(event).toMatchObject({ kind: 'BLOCKED', action: 'BOOK', reasonCode: 'STAFF_ONLY_TYPE', conversationId: conversation.id });
  });

  it('GL3. moves and cancels are logged too; staff actions are not', async () => {
    const browser = await login(t, DEMO);
    await browser.post('/me/appointments/00000000-0000-0000-0000-000000000000/reschedule').send({ start: at('11:00') }).expect(404);
    await browser.delete('/me/appointments/00000000-0000-0000-0000-000000000000').set('Content-Type', 'application/json').expect(404);

    // Reception books outside working hours without an override: refused, but not a patient action.
    const reception = await staffLogin(t, 'reception@clinic.example');
    await reception
      .post('/staff/appointments')
      .send({ patientId: clinic.patients.two.id, typeCode: 'FOLLOW_UP', start: at('17:00'), doctorId: clinic.resources.ayesha.id })
      .expect(409);

    const events = await t.prisma.guardrailEvent.findMany({ orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => [e.action, e.reasonCode])).toEqual([
      ['RESCHEDULE', 'NOT_FOUND'],
      ['CANCEL', 'NOT_FOUND'],
    ]);
  });
});

describe('the staff view', () => {
  it('GL4. staff see the log newest first, with the patient; patients and visitors cannot', async () => {
    const browser = await login(t, DEMO);
    await browser.post('/me/appointments').send({ typeCode: 'URGENT_VISIT', start: at('10:00') }).expect(403);
    t.clock.advanceMinutes(1);
    await browser.post('/me/appointments').send({ typeCode: 'DENTAL_CHECK', start: at('10:00') }).expect(400);

    const reception = await staffLogin(t, 'reception@clinic.example');
    const list = (await reception.get('/staff/guardrails').expect(200)).body;
    expect(list.map((e: { reasonCode: string }) => e.reasonCode)).toEqual(['UNKNOWN_TYPE', 'STAFF_ONLY_TYPE']);
    expect(list[0]).toMatchObject({ kind: 'BLOCKED', action: 'BOOK', patient: { fullName: 'Demo Patient', email: DEMO }, repeated: false });
    expect(JSON.stringify(list)).not.toContain('1990-01-15'); // never the date of birth

    await browser.get('/staff/guardrails').expect(401);
    await t.http().get('/staff/guardrails').expect(401);
  });

  it('GL5. filtering by kind, and urgency claims from the same patient are marked as repeated', async () => {
    const claim = (patientId: string, minutesAgo: number) =>
      t.prisma.guardrailEvent.create({
        data: {
          kind: 'URGENCY_CLAIM',
          patientId,
          action: 'CHAT',
          reasonCode: 'URGENCY_WORDS',
          message: 'Said "urgent" without urgent symptoms.',
          createdAt: new Date(t.clock.now().getTime() - minutesAgo * 60_000),
        },
      });
    await claim(clinic.patients.demo.id, 60);
    await claim(clinic.patients.demo.id, 5);
    await claim(clinic.patients.two.id, 5);
    await t.prisma.guardrailEvent.create({
      data: { kind: 'BLOCKED', patientId: clinic.patients.two.id, action: 'BOOK', reasonCode: 'SLOT_TAKEN', message: 'x', createdAt: t.clock.now() },
    });

    const reception = await staffLogin(t, 'reception@clinic.example');
    const claims = (await reception.get('/staff/guardrails?kind=URGENCY_CLAIM').expect(200)).body as { patient: { email: string }; repeated: boolean }[];
    expect(claims).toHaveLength(3);
    expect(claims.filter((c) => c.repeated).map((c) => c.patient.email)).toEqual([DEMO, DEMO]);

    const all = (await reception.get('/staff/guardrails').expect(200)).body;
    expect(all).toHaveLength(4);
  });
});
