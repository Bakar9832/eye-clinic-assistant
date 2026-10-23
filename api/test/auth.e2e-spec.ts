// Login, sessions and profile, over HTTP.

import { createHash } from 'node:crypto';
import { createTestApp, login, type TestApp } from './harness.js';

let t: TestApp;
const DEMO = 'demo.patient@example.com';
const NEW_PERSON = 'new.person@example.com';

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await t.reset();
});
afterAll(async () => {
  await t.app.close();
});

/** The raw value of the session cookie a response set. */
function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const cookies = ([] as string[]).concat((res.headers['set-cookie'] as string[] | string | undefined) ?? []);
  const session = cookies.find((c) => c.startsWith('session='));
  if (!session) throw new Error('No session cookie was set');
  return session;
}

describe('requesting a code', () => {
  it('A1. known and unknown emails get exactly the same answer', async () => {
    const known = await t.http().post('/auth/request-code').send({ email: DEMO });
    const unknown = await t.http().post('/auth/request-code').send({ email: 'nobody@example.com' });

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
  });

  it('A2. the code is 6 digits; the database only has a keyed hash of it', async () => {
    await t.http().post('/auth/request-code').send({ email: DEMO }).expect(202);

    const code = t.inbox.lastCode(DEMO);
    expect(code).toMatch(/^\d{6}$/);

    const [row] = await t.prisma.loginCode.findMany({ where: { email: DEMO } });
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(code);
    // Not a plain hash either: that could be reversed by trying all million codes.
    expect(row.codeHash).not.toBe(createHash('sha256').update(`${DEMO}:${code}`).digest('hex'));
  });

  it('A8. a 4th code for the same email within 15 minutes is refused', async () => {
    for (let i = 0; i < 3; i++) await t.http().post('/auth/request-code').send({ email: DEMO }).expect(202);
    const fourth = await t.http().post('/auth/request-code').send({ email: DEMO }).expect(429);
    expect(fourth.body.error).toBe('RATE_LIMITED');

    t.clock.advanceMinutes(16);
    await t.http().post('/auth/request-code').send({ email: DEMO }).expect(202);
  });

  it('A9. an 11th code request from one IP within an hour is refused', async () => {
    for (let i = 0; i < 10; i++) {
      await t.http().post('/auth/request-code').send({ email: `person${i}@example.com` }).expect(202);
    }
    await t.http().post('/auth/request-code').send({ email: 'person10@example.com' }).expect(429);
  });
});

describe('verifying a code', () => {
  it('A3. the right code sets an HttpOnly, SameSite=Lax session cookie that works', async () => {
    const browser = t.browser();
    await browser.post('/auth/request-code').send({ email: DEMO }).expect(202);
    const res = await browser.post('/auth/verify').send({ email: DEMO, code: t.inbox.lastCode(DEMO) }).expect(200);

    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);

    const me = await browser.get('/me').expect(200);
    expect(me.body.email).toBe(DEMO);
  });

  it('A4. after 5 wrong guesses the code is dead, even the right one', async () => {
    await t.http().post('/auth/request-code').send({ email: DEMO });
    const right = t.inbox.lastCode(DEMO);
    const wrong = right === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i++) {
      await t.http().post('/auth/verify').send({ email: DEMO, code: wrong }).expect(401);
    }
    await t.http().post('/auth/verify').send({ email: DEMO, code: right }).expect(401);
  });

  it('A5. a code older than 10 minutes is refused', async () => {
    await t.http().post('/auth/request-code').send({ email: DEMO });
    t.clock.advanceMinutes(11);
    await t.http().post('/auth/verify').send({ email: DEMO, code: t.inbox.lastCode(DEMO) }).expect(401);
  });

  it('A6. a code works only once', async () => {
    await t.http().post('/auth/request-code').send({ email: DEMO });
    const code = t.inbox.lastCode(DEMO);
    await t.http().post('/auth/verify').send({ email: DEMO, code }).expect(200);
    await t.http().post('/auth/verify').send({ email: DEMO, code }).expect(401);
  });

  it('A7. asking for a new code retires the previous one', async () => {
    await t.http().post('/auth/request-code').send({ email: DEMO });
    const first = t.inbox.lastCode(DEMO);
    await t.http().post('/auth/request-code').send({ email: DEMO });
    const second = t.inbox.lastCode(DEMO);

    if (first !== second) await t.http().post('/auth/verify').send({ email: DEMO, code: first }).expect(401);
    await t.http().post('/auth/verify').send({ email: DEMO, code: second }).expect(200);
  });

  it('A13. email case and spaces don\'t matter: same person, same account', async () => {
    const browser = await login(t, '  Demo.Patient@Example.COM ');
    const me = await browser.get('/me').expect(200);
    expect(me.body).toMatchObject({ email: DEMO, fullName: 'Demo Patient' });
  });

  it('A14. a new email creates a patient whose profile still needs completing', async () => {
    const browser = await login(t, NEW_PERSON);
    const me = await browser.get('/me').expect(200);
    expect(me.body).toMatchObject({ email: NEW_PERSON, fullName: null, hasDateOfBirth: false, profileComplete: false });
  });
});

describe('sessions', () => {
  it('A10. after logout the old cookie no longer works', async () => {
    const browser = t.browser();
    await browser.post('/auth/request-code').send({ email: DEMO });
    const res = await browser.post('/auth/verify').send({ email: DEMO, code: t.inbox.lastCode(DEMO) });
    const stolen = sessionCookie(res).split(';')[0];

    await browser.post('/auth/logout').set('Content-Type', 'application/json').expect(204);
    // Replaying the old cookie from somewhere else:
    await t.http().get('/me').set('Cookie', stolen).expect(401);
  });

  it('A11. sessions expire after 7 days', async () => {
    const browser = await login(t, DEMO);
    t.clock.advanceMinutes(7 * 24 * 60 - 1);
    await browser.get('/me').expect(200);
    t.clock.advanceMinutes(2);
    await browser.get('/me').expect(401);
  });

  it('A12. the database stores only a hash of the session token', async () => {
    const browser = t.browser();
    await browser.post('/auth/request-code').send({ email: DEMO });
    const res = await browser.post('/auth/verify').send({ email: DEMO, code: t.inbox.lastCode(DEMO) });
    const token = decodeURIComponent(sessionCookie(res).split(';')[0].slice('session='.length));

    const sessions = await t.prisma.session.findMany();
    expect(JSON.stringify(sessions)).not.toContain(token);
    expect(sessions.map((s) => s.tokenHash)).toContain(createHash('sha256').update(token).digest('hex'));
  });

  it('A15. the demo login works only when DEMO_MODE=true', async () => {
    const original = process.env.DEMO_MODE;
    try {
      process.env.DEMO_MODE = 'true';
      const browser = t.browser();
      await browser.post('/auth/demo').set('Content-Type', 'application/json').expect(200);
      expect((await browser.get('/me').expect(200)).body.email).toBe(DEMO);

      process.env.DEMO_MODE = 'false';
      await t.http().post('/auth/demo').set('Content-Type', 'application/json').expect(404);
    } finally {
      process.env.DEMO_MODE = original;
    }
  });

  it('B5. /me without a session cookie is 401', async () => {
    await t.http().get('/me').expect(401);
    await t.http().patch('/me').send({ fullName: 'X' }).expect(401);
  });
});

describe('profile', () => {
  it('completes the profile; the date of birth is never sent back', async () => {
    const browser = await login(t, NEW_PERSON);
    const res = await browser.patch('/me').send({ fullName: 'New Person', dateOfBirth: '1992-03-04' }).expect(200);

    expect(res.body).toMatchObject({ fullName: 'New Person', hasDateOfBirth: true, profileComplete: true });
    expect(res.body).not.toHaveProperty('dateOfBirth');
    expect(JSON.stringify(res.body)).not.toContain('1992');
  });

  it('the date of birth can be set once; a stolen session cannot change it', async () => {
    const browser = await login(t, DEMO); // already has one
    const res = await browser.patch('/me').send({ dateOfBirth: '2000-01-01' }).expect(409);
    expect(res.body.error).toBe('DOB_ALREADY_SET');
  });

  it('B4. unknown fields such as patientId are rejected, not ignored', async () => {
    const browser = await login(t, DEMO);
    const res = await browser.patch('/me').send({ fullName: 'X', patientId: 'someone-else' }).expect(400);
    expect(res.body.error).toBe('INVALID_INPUT');
  });

  it('rejects an invalid time zone and an impossible date of birth', async () => {
    const browser = await login(t, NEW_PERSON);
    await browser.patch('/me').send({ timezone: 'Mars/Olympus' }).expect(400);
    await browser.patch('/me').send({ dateOfBirth: '2999-01-01' }).expect(400);
    await browser.patch('/me').send({ timezone: 'Europe/London' }).expect(200);
  });
});

describe('CSRF', () => {
  it('B6. a request that changes something must be JSON, so an HTML form on another site cannot fake it', async () => {
    const res = await t.http().post('/auth/request-code').type('form').send({ email: DEMO }).expect(415);
    expect(res.body.error).toBe('JSON_REQUIRED');
  });
});
