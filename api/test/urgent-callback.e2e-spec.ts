// Urgent symptoms (found in code), urgency claims, "attention needed" bookings, staff
// call backs, and the suggest_callback signal.

import { DateTime } from 'luxon';
import { seedClinic } from '../prisma/clinic-data.js';
import { agentTokenFor, createTestApp, login, mcpClient, staffLogin, toolData, ZONE, type TestApp } from './harness.js';

let t: TestApp;
let clinic: Awaited<ReturnType<typeof seedClinic>>;
const DEMO = 'demo.patient@example.com';
const MON = '2030-01-07';

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  clinic = await t.reset();
});
afterAll(async () => {
  await t.app.close();
});

type Browser = Awaited<ReturnType<typeof login>>;
type Client = Awaited<ReturnType<typeof mcpClient>>;
const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

/** Sends one chat message and returns the conversation id. */
async function say(browser: Browser, message: string, conversationId?: string) {
  const res = await browser.post('/chat').send({ message, ...(conversationId ? { conversationId } : {}) }).expect(200);
  return res.body.conversationId as string;
}
const lastContext = () => t.agent.turns.at(-1)!.context;
const urgentAlerts = () => t.prisma.handoffRequest.findMany({ where: { kind: 'URGENT' } });

describe('urgent symptoms, found in code before the model', () => {
  it('UC1. one staff alert per conversation, the agent is told, and nothing of it reaches the audit log', async () => {
    const browser = await login(t, DEMO);
    const conversation = await say(browser, 'I just splashed bleach in my eye!');

    expect(lastContext().urgentSymptoms).toBe(true);
    const [alert] = await urgentAlerts();
    expect(alert).toMatchObject({ patientId: clinic.patients.demo.id, conversationId: conversation, status: 'OPEN' });
    expect(alert.reason).toContain('chemical in the eye');
    const event = await t.prisma.guardrailEvent.findFirstOrThrow({ where: { kind: 'URGENT_SYMPTOMS' } });
    expect(event).toMatchObject({ patientId: clinic.patients.demo.id, conversationId: conversation, action: 'CHAT' });

    // Still urgent later in the same chat, but staff aren't alerted twice.
    await say(browser, 'and now extreme pain', conversation);
    await say(browser, 'can I book something?', conversation);
    expect(lastContext().urgentSymptoms).toBe(true);
    expect(await urgentAlerts()).toHaveLength(1);
    expect(JSON.stringify(await t.prisma.auditEvent.findMany())).not.toContain('bleach');

    // A new conversation is a new alert.
    await say(browser, 'Sudden loss of vision in my left eye');
    expect(await urgentAlerts()).toHaveLength(2);
  });

  it('UC1b. guests get the alert too (no patient on it)', async () => {
    await say(t.browser(), 'My eye is bleeding after a fall');
    const [alert] = await urgentAlerts();
    expect(alert.patientId).toBeNull();
    expect(lastContext().urgentSymptoms).toBe(true);
  });

  it('UC2. "urgent" without symptoms: logged once per chat as a claim, no alert, nothing changes for the agent', async () => {
    const browser = await login(t, DEMO);
    const conversation = await say(browser, 'This is urgent, I need an appointment asap!');
    await say(browser, 'URGENT please, emergency', conversation);

    expect(lastContext().urgentSymptoms).toBe(false);
    expect(await urgentAlerts()).toHaveLength(0);
    const claims = await t.prisma.guardrailEvent.findMany({ where: { kind: 'URGENCY_CLAIM' } });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ patientId: clinic.patients.demo.id, conversationId: conversation, reasonCode: 'URGENCY_WORDS' });
  });

  it('UC2b. an ordinary message flags nothing', async () => {
    await say(await login(t, DEMO), 'I have a headache and the back of my head hurts when I read');
    expect(lastContext().urgentSymptoms).toBe(false);
    expect(await t.prisma.guardrailEvent.count()).toBe(0);
    expect(await t.prisma.handoffRequest.count()).toBe(0);
  });
});

describe('"attention needed" bookings', () => {
  it('UC3. a booking made in a chat with urgent symptoms is flagged for staff; a normal one is not; the slot is the same', async () => {
    const urgent = await login(t, DEMO);
    await say(urgent, 'My eye is swollen shut since this morning');
    const urgentClient = await mcpClient(t, t.agent.lastToken);
    const flagged = toolData(await call(urgentClient, 'book', { type: 'FOLLOW_UP', date: MON, time: '10:00' }));

    const normal = await login(t, 'test.two@example.com');
    const normalClient = await mcpClient(t, await agentTokenFor(t, normal));
    const plain = toolData(await call(normalClient, 'book', { type: 'FOLLOW_UP', date: MON, time: '11:00' }));

    const rows = await t.prisma.appointment.findMany({ where: { reference: { in: [flagged.reference as string, plain.reference as string] } } });
    const byRef = Object.fromEntries(rows.map((r) => [r.reference, r]));
    expect(byRef[flagged.reference as string].attentionReason).toMatch(/urgent eye symptoms/i);
    expect(byRef[plain.reference as string].attentionReason).toBeNull();

    // Staff see it on the schedule.
    const reception = await staffLogin(t, 'reception@clinic.example');
    const day = (await reception.get(`/staff/schedule?day=${MON}`).expect(200)).body.appointments as { reference: string; attentionReason: string | null }[];
    expect(day.find((a) => a.reference === flagged.reference)?.attentionReason).toMatch(/contact the patient/);
  });

  it('UC3b. the Confirm button flags it too', async () => {
    const browser = await login(t, DEMO);
    const conversation = await say(browser, 'There is a dark curtain over my vision');
    const start = DateTime.fromISO(`${MON}T10:00`, { zone: ZONE }).toUTC().toISO();
    const res = await browser.post(`/chat/${conversation}/book`).send({ typeCode: 'FOLLOW_UP', start }).expect(200);

    const saved = await t.prisma.appointment.findFirstOrThrow({ where: { reference: res.body.cards[0].reference } });
    expect(saved.attentionReason).not.toBeNull();
  });
});

describe('request_callback', () => {
  it('UC4. needs login; stores a CALLBACK with the preferred time; a second request is not duplicated', async () => {
    const guest = await mcpClient(t, await agentTokenFor(t, t.browser()));
    expect(toolData(await call(guest, 'request_callback', { reason: 'Wants a person.' })).error).toBe('LOGIN_REQUIRED');

    const client = await mcpClient(t, await agentTokenFor(t, await login(t, DEMO)));
    const first = toolData(await call(client, 'request_callback', { reason: 'Wants to talk about the results.', preferred_time: 'weekday afternoons' }));
    expect(first).toMatchObject({ status: 'CALLBACK_REQUESTED' });
    expect(first.message).toContain(DEMO);
    const again = toolData(await call(client, 'request_callback', { reason: 'Still waiting.' }));
    expect(again).toMatchObject({ status: 'ALREADY_REQUESTED' });

    const requests = await t.prisma.handoffRequest.findMany({ where: { kind: 'CALLBACK' } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ patientId: clinic.patients.demo.id, preferredTime: 'weekday afternoons' });
    expect(JSON.stringify(await t.prisma.auditEvent.findMany())).not.toContain('results');
  });

  it('UC6. staff see urgent alerts first, with each kind and the best time to call', async () => {
    const client = await mcpClient(t, await agentTokenFor(t, await login(t, DEMO)));
    await call(client, 'request_callback', { reason: 'Wants a person.', preferred_time: 'mornings' });
    t.clock.advanceMinutes(1);
    await call(client, 'handoff_to_staff', { reason: 'Complaint about parking.' });
    t.clock.advanceMinutes(-5); // the urgent alert is the OLDEST, and still comes first
    await say(await login(t, 'test.two@example.com'), 'I splashed acid in my eyes');

    const reception = await staffLogin(t, 'reception@clinic.example');
    const list = (await reception.get('/staff/handoffs').expect(200)).body as { kind: string; preferredTime: string | null }[];
    expect(list.map((h) => h.kind)).toEqual(['URGENT', 'CALLBACK', 'HANDOFF']);
    expect(list[1].preferredTime).toBe('mornings');
  });
});

describe('suggest_callback: decided in code', () => {
  it('UC5. the second refusal with the same reason in a chat says suggest_callback; the first does not', async () => {
    const client = await mcpClient(t, await agentTokenFor(t, await login(t, DEMO)));
    await call(client, 'book', { type: 'FOLLOW_UP', date: MON, time: '10:00' });

    const first = toolData(await call(client, 'book', { type: 'SCAN_ONLY', date: MON, time: '14:00' }));
    expect(first.error).toBe('ALREADY_BOOKED');
    expect(first.suggest_callback).toBeUndefined();

    const second = toolData(await call(client, 'book', { type: 'CONTACT_LENS_FITTING', date: MON, time: '15:00' }));
    expect(second.error).toBe('ALREADY_BOOKED');
    expect(second.suggest_callback).toBe(true);
  });

  it('UC5b. hitting the booking rate limit always suggests a call back', async () => {
    await t.prisma.clinicSetting.update({ where: { id: 1 }, data: { bookingActionLimit: 1 } });
    const client = await mcpClient(t, await agentTokenFor(t, await login(t, DEMO)));
    await call(client, 'book', { type: 'FOLLOW_UP', date: MON, time: '10:00' });

    const limited = toolData(await call(client, 'book', { type: 'FOLLOW_UP', date: '2030-01-08', time: '10:00' }));
    expect(limited).toMatchObject({ error: 'TOO_MANY_CHANGES', suggest_callback: true });
  });
});

describe('what the model is offered', () => {
  it('UC7. urgent visits are not offered as a bookable type', async () => {
    const client = await mcpClient(t, await agentTokenFor(t, t.browser()));
    const types = toolData(await call(client, 'list_appointment_types')).appointment_types as { code: string }[];
    expect(types.map((x) => x.code)).not.toContain('URGENT_VISIT');
    expect(types.map((x) => x.code)).toContain('FAMILY_CHECK_UP');

    const { tools } = await client.listTools();
    const book = tools.find((x) => x.name === 'book')!.inputSchema.properties!.type as { description: string };
    expect(book.description).not.toContain('URGENT_VISIT');
  });
});
