// POST /chat and GET /chat/:id: limits, who can read a conversation, what the agent is
// given, and the whole chain (chat → agent token → MCP tool → booking) with a scripted agent.

import { seedClinic } from '../prisma/clinic-data.js';
import type { Card } from '../src/mcp/clinic-tools.service.js';
import { createTestApp, login, mcpClient, toolData, type TestApp } from './harness.js';

let t: TestApp;
let clinic: Awaited<ReturnType<typeof seedClinic>>;
const DEMO = 'demo.patient@example.com';

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  clinic = await t.reset();
});
afterAll(async () => {
  await t.app.close();
});

describe('a chat turn', () => {
  it('stores both sides and gives the agent the history, the context and a token', async () => {
    t.agent.respond = async () => ({ reply: 'We are open Monday to Saturday.', cards: [] });
    const browser = await login(t, DEMO);

    const res = await browser.post('/chat').send({ message: 'When are you open?', viewerTimezone: 'Europe/London' }).expect(200);
    expect(res.body).toMatchObject({ reply: 'We are open Monday to Saturday.', cards: [] });

    const turn = t.agent.turns[0];
    expect(turn.messages).toEqual([{ role: 'user', text: 'When are you open?' }]);
    // The harness clock starts at 2030-01-01 05:00 UTC = 10:00 on a Tuesday in Karachi.
    expect(turn.context).toEqual({
      clinicName: 'Demo Eye Clinic',
      clinicTimezone: 'Asia/Karachi',
      today: '2030-01-01',
      weekday: 'Tuesday',
      viewerTimezone: 'Europe/London',
      loggedIn: true,
    });
    expect(turn.agentToken).toMatch(/^[\w-]+\.[\w-]+$/);
    // The agent gets the token separately: it is not part of the conversation text.
    expect(JSON.stringify(turn.messages)).not.toContain(turn.agentToken);

    const history = await browser.get(`/chat/${res.body.conversationId}`).expect(200);
    expect(history.body.map((m: { role: string; text: string }) => [m.role, m.text])).toEqual([
      ['user', 'When are you open?'],
      ['assistant', 'We are open Monday to Saturday.'],
    ]);
  });

  it('continues a conversation: the agent sees earlier messages', async () => {
    const browser = await login(t, DEMO);
    const first = await browser.post('/chat').send({ message: 'Hi' }).expect(200);
    await browser.post('/chat').send({ message: 'Book me in', conversationId: first.body.conversationId }).expect(200);

    expect(t.agent.turns[1].messages.map((m) => m.text)).toEqual(['Hi', 'OK', 'Book me in']);
  });

  it('cards are stored with the reply and returned to the page', async () => {
    const card: Card = { type: 'dob_prompt' };
    t.agent.respond = async () => ({ reply: 'Please confirm your date of birth in the box below.', cards: [card] });
    const browser = await login(t, DEMO);

    const res = await browser.post('/chat').send({ message: 'Are my results in?' }).expect(200);
    expect(res.body.cards).toEqual([card]);
    expect((await browser.get(`/chat/${res.body.conversationId}`)).body[1].cards).toEqual([card]);
  });

  it("the patient's own date of birth never comes back in a reply, even if the model repeats it", async () => {
    // The seeded demo patient was born on 1990-01-15.
    t.agent.respond = async () => ({ reply: 'Please confirm 1990-01-15 in the secure box on the page.', cards: [] });
    const browser = await login(t, DEMO);

    const res = await browser.post('/chat').send({ message: 'My date of birth is 1990-01-15, show my results.' }).expect(200);
    expect(res.body.reply).toBe('Please confirm [date of birth hidden] in the secure box on the page.');
    const stored = (await browser.get(`/chat/${res.body.conversationId}`)).body[1].text;
    expect(stored).not.toContain('1990-01-15');
  });

  it('if the agent service is down, the patient gets a clear 503', async () => {
    t.agent.respond = async () => {
      throw new Error('connection refused');
    };
    const res = await t.http().post('/chat').send({ message: 'Hello' }).expect(503);
    expect(res.body.error).toBe('AGENT_UNAVAILABLE');
  });
});

describe('T10. limits', () => {
  it('the 21st message within 10 minutes is refused', async () => {
    const browser = await login(t, DEMO);
    for (let i = 0; i < 20; i++) await browser.post('/chat').send({ message: `Message ${i}` }).expect(200);
    const res = await browser.post('/chat').send({ message: 'One too many' }).expect(429);
    expect(res.body.error).toBe('RATE_LIMITED');

    t.clock.advanceMinutes(11);
    await browser.post('/chat').send({ message: 'Later' }).expect(200);
  });

  it('a message over 1,000 characters is refused before it reaches the agent', async () => {
    await t.http().post('/chat').send({ message: 'x'.repeat(1001) }).expect(400);
    expect(t.agent.turns).toHaveLength(0);
  });
});

describe('T11. who can read a conversation', () => {
  it("only its owner: not another patient, not an anonymous visitor", async () => {
    const demo = await login(t, DEMO);
    const { conversationId } = (await demo.post('/chat').send({ message: 'My private question' }).expect(200)).body;

    const two = await login(t, 'test.two@example.com');
    await two.get(`/chat/${conversationId}`).expect(404);
    await two.post('/chat').send({ message: 'Hijack', conversationId }).expect(404);
    await t.browser().get(`/chat/${conversationId}`).expect(404);
    await demo.get(`/chat/${conversationId}`).expect(200);
  });

  it("an anonymous visitor's chat belongs to their browser only", async () => {
    const visitor = t.browser();
    const { conversationId } = (await visitor.post('/chat').send({ message: 'Do you see children?' }).expect(200)).body;

    await visitor.get(`/chat/${conversationId}`).expect(200);
    await t.browser().get(`/chat/${conversationId}`).expect(404);
    expect(t.agent.turns[0].context.loggedIn).toBe(false);
  });
});

describe('the whole chain, with a scripted agent instead of an LLM', () => {
  it('chat → agent token → MCP book → a real booking for the logged-in patient', async () => {
    // What the Python agent will do, minus the LLM: take the token, call a tool, reply.
    t.agent.respond = async (turn) => {
      const client = await mcpClient(t, turn.agentToken);
      const result = await client.callTool({
        name: 'book',
        arguments: { type: 'FOLLOW_UP', date: '2030-01-07', time: '10:00', doctor: 'Dr Ayesha' },
      });
      const data = toolData(result);
      const cards = ((result as { _meta?: { cards?: Card[] } })._meta?.cards ?? []) as Card[];
      return { reply: `Booked: ${data.reference} on Monday at 10:00 with Dr Ayesha.`, cards };
    };

    const browser = await login(t, DEMO);
    const res = await browser.post('/chat').send({ message: 'Book a follow-up with Dr Ayesha next Monday at 10' }).expect(200);

    const reference = (res.body.reply as string).match(/EC-[A-Z0-9]{6}/)![0];
    const saved = await t.prisma.appointment.findUniqueOrThrow({ where: { reference } });
    expect(saved.patientId).toBe(clinic.patients.demo.id);
    expect(res.body.cards).toEqual([expect.objectContaining({ type: 'ticket', reference })]);
    expect(await t.prisma.auditEvent.count({ where: { entityId: saved.id, action: 'APPOINTMENT_BOOKED', actorId: clinic.patients.demo.id } })).toBe(1);
  });
});

describe('C. Confirm on a booking offer: the click books, not the model', () => {
  type Offer = Extract<Card, { type: 'booking_offer' }>;

  /** "Can I book…?" with a scripted agent calling propose_booking: the card the page shows. */
  async function offerFor(browser: Awaited<ReturnType<typeof login>>) {
    t.agent.respond = async (turn) => {
      const client = await mcpClient(t, turn.agentToken);
      const result = await client.callTool({
        name: 'propose_booking',
        arguments: { type: 'FOLLOW_UP', date: '2030-01-07', time: '10:00', doctor: 'Dr Ayesha' },
      });
      return { reply: '10:00 is free. Would you like to confirm it?', cards: ((result as { _meta?: { cards?: Card[] } })._meta?.cards ?? []) as Card[] };
    };
    const res = await browser.post('/chat').send({ message: 'Can I book a follow-up Monday at 10?' }).expect(200);
    const offer = (res.body.cards as Card[]).find((c): c is Offer => c.type === 'booking_offer')!;
    return { conversationId: res.body.conversationId as string, offer, confirm: { typeCode: offer.typeCode, start: offer.start, doctorId: offer.doctorId } };
  }

  it('C1. the offer books nothing; Confirm books exactly one, and the conversation records both sides', async () => {
    const browser = await login(t, DEMO);
    const { conversationId, offer, confirm } = await offerFor(browser);
    expect(offer).toMatchObject({ typeCode: 'FOLLOW_UP', typeName: expect.any(String), doctor: 'Dr Ayesha' });
    expect(await t.prisma.appointment.count()).toBe(0);

    const res = await browser.post(`/chat/${conversationId}/book`).send(confirm).expect(200);

    const saved = await t.prisma.appointment.findFirstOrThrow();
    expect(saved).toMatchObject({ patientId: clinic.patients.demo.id, startsAt: new Date(offer.start) });
    expect(res.body.reply).toContain(saved.reference);
    expect(res.body.cards).toEqual([expect.objectContaining({ type: 'ticket', reference: saved.reference })]);
    // No model call: the click is the consent.
    expect(t.agent.turns).toHaveLength(1);

    const history = (await browser.get(`/chat/${conversationId}`).expect(200)).body as { role: string; text: string }[];
    expect(history.slice(-2).map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history.at(-2)!.text).toBe('Yes, please book it.');
  });

  it('C2. pressing Confirm twice books once; the second gets the reason', async () => {
    const browser = await login(t, DEMO);
    const { conversationId, confirm } = await offerFor(browser);
    await browser.post(`/chat/${conversationId}/book`).send(confirm).expect(200);

    const again = await browser.post(`/chat/${conversationId}/book`).send(confirm);
    expect(again.status).toBe(409);
    expect(await t.prisma.appointment.count()).toBe(1);
  });

  it('C3. a time taken since the offer is refused with a clear reason', async () => {
    const browser = await login(t, DEMO);
    const { conversationId, confirm } = await offerFor(browser);
    const two = await login(t, 'test.two@example.com');
    await two.post('/me/appointments').send(confirm).expect(201);

    const res = await browser.post(`/chat/${conversationId}/book`).send(confirm);
    // The calendar's check: the time is no longer a free slot.
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INVALID_SLOT');
    expect(await t.prisma.appointment.count({ where: { patientId: clinic.patients.demo.id } })).toBe(0);
  });

  it("C4. only the conversation's own logged-in patient can confirm in it", async () => {
    const browser = await login(t, DEMO);
    const { conversationId, confirm } = await offerFor(browser);

    await t.browser().post(`/chat/${conversationId}/book`).send(confirm).expect(401);
    const two = await login(t, 'test.two@example.com');
    await two.post(`/chat/${conversationId}/book`).send(confirm).expect(404);
    expect(await t.prisma.appointment.count()).toBe(0);
  });
});
