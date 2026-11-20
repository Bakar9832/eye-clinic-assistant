// Keep-warm: GET /health/warm wakes both services and must cost nothing else.

import { createTestApp, type TestApp } from './harness.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await t.reset();
});
afterAll(async () => {
  await t.app.close();
});

/** Rows in every table a request could write to as a side effect. */
async function sideEffects() {
  const [audit, guardrails, messages, conversations, sessions] = await Promise.all([
    t.prisma.auditEvent.count(),
    t.prisma.guardrailEvent.count(),
    t.prisma.chatMessage.count(),
    t.prisma.conversation.count(),
    t.prisma.session.count(),
  ]);
  return { audit, guardrails, messages, conversations, sessions };
}

describe('GET /health/warm', () => {
  it('H1. the agent answered its health check: 200 { api: ok, agent: ok }, not cached, no login', async () => {
    const res = await t.http().get('/health/warm').expect(200);
    expect(res.body).toEqual({ api: 'ok', agent: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(t.agent.healthChecks).toBe(1);
  });

  it('H2. the agent did not answer in time (asleep): still 200, with agent "waking"', async () => {
    t.agent.healthy = false;
    const res = await t.http().get('/health/warm').expect(200);
    expect(res.body).toEqual({ api: 'ok', agent: 'waking' });
  });

  it('H3. never calls the model and writes nothing: no audit, guardrail, chat or session rows', async () => {
    const before = await sideEffects();
    for (let i = 0; i < 5; i++) await t.http().get('/health/warm').expect(200);
    expect(t.agent.turns).toHaveLength(0); // the only agent call is the health check
    expect(await sideEffects()).toEqual(before);
  });

  it('H4. does not count toward the chat rate limit or the daily cap', async () => {
    await t.prisma.clinicSetting.update({ where: { id: 1 }, data: { dailyChatMessageCap: 1 } });
    // Far more pings than the chat limit (20 per 10 minutes) or the cap (1 today).
    for (let i = 0; i < 25; i++) await t.http().get('/health/warm').expect(200);
    await t.http().post('/chat').send({ message: 'Hello' }).expect(200);
  });
});
