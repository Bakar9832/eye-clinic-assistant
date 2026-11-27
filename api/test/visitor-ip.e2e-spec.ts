// The per-IP limits on live: the visitor address comes signed from the web app's edge
// middleware (PROXY_SHARED_SECRET). These tests set the secret for the running app.

import { createTestApp, type TestApp } from './harness.js';

let t: TestApp;
const SECRET = 'e2e-only-proxy-secret';
const signed = (ip: string, secret = SECRET) => ({ 'x-visitor-ip': ip, 'x-proxy-secret': secret });

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await t.reset();
  process.env.PROXY_SHARED_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.PROXY_SHARED_SECRET;
});
afterAll(async () => {
  await t.app.close();
});

const say = (headers: Record<string, string>) => t.browser().post('/chat').set(headers).send({ message: 'Hello' });
const storedIps = async () => (await t.prisma.chatMessage.findMany({ where: { role: 'USER' }, orderBy: { createdAt: 'asc' } })).map((m) => m.requestIp);

describe('the visitor address behind the live proxies', () => {
  it('VIP1. a signed address is what is stored and counted; a forged or missing one is "unverified"', async () => {
    await say(signed('203.0.113.7')).expect(200);
    await say(signed('203.0.113.7', 'guess')).expect(200);
    await say({ 'x-visitor-ip': '198.51.100.1' }).expect(200);
    expect(await storedIps()).toEqual(['203.0.113.7', 'unverified', 'unverified']);
  });

  it('VIP2. the chat limit counts each signed visitor apart, even when every request comes from the same proxy', async () => {
    // 20 messages per 10 minutes per address: each from a new browser, so only the IP links them.
    for (let i = 0; i < 20; i++) await say(signed('203.0.113.7')).expect(200);
    await say(signed('203.0.113.7')).expect(429);
    await say(signed('198.51.100.1')).expect(200); // another visitor is not blocked
  });

  it('VIP3. calling the API host directly cannot get round the limit by faking the header', async () => {
    for (let i = 0; i < 20; i++) await say({ 'x-visitor-ip': `198.51.100.${i}`, 'x-proxy-secret': 'guess' }).expect(200);
    await say({ 'x-visitor-ip': '198.51.100.99' }).expect(429); // all of them were one "unverified" address
  });

  it('VIP4. failed logins are recorded with the signed address', async () => {
    await t.http().post('/auth/login').set(signed('203.0.113.7')).send({ email: 'nobody@example.com', password: 'wrong-password-1' }).expect(401);
    const failures = await t.prisma.loginFailure.findMany();
    expect(failures.map((f) => f.ip)).toEqual(['203.0.113.7']);
  });

  it('VIP5. GET /health/ip says whether the address was signed, without echoing it', async () => {
    expect((await t.http().get('/health/ip').set(signed('203.0.113.7')).expect(200)).body).toEqual({ verified: true });
    expect((await t.http().get('/health/ip').expect(200)).body).toEqual({ verified: false });
  });
});
