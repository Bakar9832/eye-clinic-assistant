// Chat protection: the site-wide daily cap, stalled conversations, and the call-back button.

import { seedClinic } from '../prisma/clinic-data.js';
import { createTestApp, login, mcpClient, type TestApp } from './harness.js';

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

type Browser = Awaited<ReturnType<typeof login>>;
const settings = (data: { dailyChatMessageCap?: number; stallMessageThreshold?: number }) =>
  t.prisma.clinicSetting.update({ where: { id: 1 }, data });

/** Sends one chat message; returns the request, so callers can .expect() its status. */
function say(browser: Browser, message: string, conversationId?: string) {
  return browser.post('/chat').send({ message, ...(conversationId ? { conversationId } : {}) });
}

describe('the site-wide daily chat cap', () => {
  it('CL1. after the cap everyone gets "busy" without the agent being called; logged once; a new day resets it', async () => {
    await settings({ dailyChatMessageCap: 2 });
    await say(t.browser(), 'Hello').expect(200);
    await say(await login(t, DEMO), 'When is Dr Ayesha free?').expect(200);
    const turns = t.agent.turns.length;

    const busy = await say(t.browser(), 'One more?').expect(503);
    expect(busy.body.error).toBe('CHAT_BUSY');
    expect(busy.body.reasons[0].message).toMatch(/busy today.*Book page/);
    await say(t.browser(), 'And another').expect(503);

    expect(t.agent.turns.length).toBe(turns); // the model was never asked
    expect(await t.prisma.chatMessage.count({ where: { role: 'USER' } })).toBe(2); // refused messages aren't stored
    expect(await t.prisma.guardrailEvent.count({ where: { kind: 'CHAT_CAP' } })).toBe(1);

    t.clock.advanceMinutes(24 * 60);
    await say(t.browser(), 'Good morning').expect(200);
  });

  it('CL2. a cap of 0 means no cap', async () => {
    await settings({ dailyChatMessageCap: 0 });
    for (let i = 0; i < 3; i++) await say(t.browser(), `Message ${i}`).expect(200);
  });
});

describe('stalled conversations', () => {
  it('CL3. at the threshold the agent is told, the call-back card is added in code, and it happens once', async () => {
    await settings({ stallMessageThreshold: 4 });
    const browser = await login(t, DEMO);
    const first = await say(browser, 'I need an appointment').expect(200);
    const id = first.body.conversationId as string;
    t.clock.advanceMinutes(1);
    await say(browser, 'Not that day', id).expect(200);
    expect(t.agent.turns.at(-1)!.context.stalled).toBe(false);

    t.clock.advanceMinutes(1);
    const third = await say(browser, 'No, none of those work', id).expect(200); // 5 messages: stalled
    expect(t.agent.turns.at(-1)!.context.stalled).toBe(true);
    expect(third.body.cards).toEqual([{ type: 'callback_offer', loggedIn: true }]);
    const [event] = await t.prisma.guardrailEvent.findMany({ where: { kind: 'STALLED' } });
    expect(event).toMatchObject({ patientId: clinic.patients.demo.id, conversationId: id, reasonCode: 'NO_PROGRESS' });

    t.clock.advanceMinutes(1);
    const fourth = await say(browser, 'still no', id).expect(200);
    expect(t.agent.turns.at(-1)!.context.stalled).toBe(false);
    expect(fourth.body.cards).toEqual([]);
    expect(await t.prisma.guardrailEvent.count({ where: { kind: 'STALLED' } })).toBe(1);
  });

  it('CL4. a booking is progress: the count starts again after it', async () => {
    await settings({ stallMessageThreshold: 4 });
    const browser = await login(t, DEMO);
    const id = (await say(browser, 'Book a follow-up').expect(200)).body.conversationId as string;
    t.clock.advanceMinutes(1);
    await say(browser, 'Monday at 10', id).expect(200);

    t.clock.advanceMinutes(1);
    const client = await mcpClient(t, t.agent.lastToken);
    await client.callTool({ name: 'book', arguments: { type: 'FOLLOW_UP', date: '2030-01-07', time: '10:00' } });

    t.clock.advanceMinutes(1);
    await say(browser, 'Thanks! One more question', id).expect(200);
    expect(t.agent.turns.at(-1)!.context.stalled).toBe(false);
  });

  it('CL4b. guests get the card too, telling them to log in', async () => {
    await settings({ stallMessageThreshold: 2 });
    const guest = t.browser();
    const id = (await say(guest, 'hi').expect(200)).body.conversationId as string;
    t.clock.advanceMinutes(1);
    const second = await say(guest, 'hello?', id).expect(200);
    expect(second.body.cards).toEqual([{ type: 'callback_offer', loggedIn: false }]);
  });

  it('CL4c. a threshold of 0 turns it off', async () => {
    await settings({ stallMessageThreshold: 0 });
    const browser = await login(t, DEMO);
    const id = (await say(browser, 'one').expect(200)).body.conversationId as string;
    for (const m of ['two', 'three', 'four', 'five']) await say(browser, m, id).expect(200);
    expect(await t.prisma.guardrailEvent.count({ where: { kind: 'STALLED' } })).toBe(0);
  });
});

describe('the "Request a call back" button', () => {
  it('CL5. creates one call back from the session, writes both sides into the chat, and only for your own chat', async () => {
    const browser = await login(t, DEMO);
    const id = (await say(browser, 'I want to talk to someone').expect(200)).body.conversationId as string;

    const res = await browser.post(`/chat/${id}/callback`).send({}).expect(200);
    expect(res.body.reply).toContain(DEMO);
    const again = await browser.post(`/chat/${id}/callback`).send({}).expect(200);
    expect(again.body.reply).toMatch(/already on the list/);

    const callbacks = await t.prisma.handoffRequest.findMany({ where: { kind: 'CALLBACK' } });
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]).toMatchObject({ patientId: clinic.patients.demo.id, conversationId: id, status: 'OPEN' });
    const texts = (await t.prisma.chatMessage.findMany({ where: { conversationId: id }, orderBy: { seq: 'asc' } })).map((m) => m.text);
    expect(texts).toContain('Please ask the clinic to call me back.');

    // Someone else's conversation looks like a missing one; guests can't use it.
    const two = await login(t, 'test.two@example.com');
    await two.post(`/chat/${id}/callback`).send({}).expect(404);
    await t.http().post(`/chat/${id}/callback`).send({}).expect(401);
  });
});
