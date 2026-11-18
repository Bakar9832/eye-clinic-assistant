// Sign-up, login, password reset, sessions and profile, over HTTP.

import { createHash } from 'node:crypto';
import { createTestApp, login, signUp, TEST_PASSWORD, type TestApp } from './harness.js';

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

  it('A8. a 6th code for the same email within 15 minutes is refused', async () => {
    for (let i = 0; i < 5; i++) await t.http().post('/auth/request-code').send({ email: DEMO }).expect(202);
    const sixth = await t.http().post('/auth/request-code').send({ email: DEMO }).expect(429);
    expect(sixth.body.error).toBe('RATE_LIMITED');

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

describe('sign-up and password reset (emailed code, then a password)', { timeout: 60_000 }, () => {
  /** Requests a code for `email` and returns it. */
  async function codeFor(email: string) {
    await t.http().post('/auth/request-code').send({ email }).expect(202);
    return t.inbox.lastCode(email);
  }
  const setPassword = (email: string, code: string, password = TEST_PASSWORD) =>
    t.http().post('/auth/set-password').send({ email, code, password });
  const setPasswordWith = (email: string, code: string, profile: { fullName?: string; dateOfBirth?: string }) =>
    t.http().post('/auth/set-password').send({ email, code, password: TEST_PASSWORD, ...profile });

  it('A3. sign-up: the right code and a password set an HttpOnly, SameSite=Lax session cookie that works', async () => {
    const browser = t.browser();
    const res = await signUp(t, browser, NEW_PERSON);

    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);

    const me = await browser.get('/me').expect(200);
    expect(me.body.email).toBe(NEW_PERSON);
    expect(t.inbox.sent.at(-1)!.subject).toBe('Your sign-up code');
  });

  it('PW5. the database keeps an scrypt hash, never the password; equal passwords hash differently', async () => {
    await signUp(t, t.browser(), NEW_PERSON, 'same-password-1');
    await signUp(t, t.browser(), 'other.person@example.com', 'same-password-1');

    const rows = await t.prisma.patient.findMany({ where: { email: { in: [NEW_PERSON, 'other.person@example.com'] } } });
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.passwordHash).toMatch(/^scrypt\$/);
    expect(rows[0].passwordHash).not.toBe(rows[1].passwordHash);
    expect(JSON.stringify(rows)).not.toContain('same-password-1');
    // Nor in the audit log.
    expect(JSON.stringify(await t.prisma.auditEvent.findMany())).not.toContain('same-password-1');
  });

  it('PW6. a password under 8 characters is refused, and the code still works afterwards', async () => {
    const code = await codeFor(NEW_PERSON);
    const res = await setPassword(NEW_PERSON, code, 'short').expect(400);
    expect(res.body.error).toBe('INVALID_INPUT');
    expect(await t.prisma.patient.count({ where: { email: NEW_PERSON } })).toBe(0);

    await setPassword(NEW_PERSON, code).expect(200);
  });

  it('PW7. a wrong or expired code sets no password', async () => {
    const code = await codeFor(DEMO);
    await setPassword(DEMO, code === '000000' ? '111111' : '000000').expect(401);
    t.clock.advanceMinutes(11);
    await setPassword(DEMO, code).expect(401);

    const demo = await t.prisma.patient.findUniqueOrThrow({ where: { email: DEMO } });
    expect(demo.passwordHash).toBeNull();
  });

  it('A4. after 5 wrong guesses the code is dead, even the right one', async () => {
    const right = await codeFor(DEMO);
    const wrong = right === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i++) await setPassword(DEMO, wrong).expect(401);
    await setPassword(DEMO, right).expect(401);
  });

  it('A6. a code works only once', async () => {
    const code = await codeFor(DEMO);
    await setPassword(DEMO, code).expect(200);
    await setPassword(DEMO, code, 'another-password').expect(401);
  });

  it('A7. asking for a new code retires the previous one', async () => {
    const first = await codeFor(DEMO);
    const second = await codeFor(DEMO);

    if (first !== second) await setPassword(DEMO, first).expect(401);
    await setPassword(DEMO, second).expect(200);
  });

  it('PW8. forgot password: the new password works, the old one does not, and old sessions are logged out', async () => {
    const laptop = await login(t, DEMO); // signs up with TEST_PASSWORD
    await laptop.get('/me').expect(200);
    expect((await t.http().post('/auth/request-code').send({ email: DEMO })).status).toBe(202);
    expect(t.inbox.sent.at(-1)!.subject).toBe('Your password reset code');

    const phone = t.browser();
    await phone.post('/auth/set-password').send({ email: DEMO, code: t.inbox.lastCode(DEMO), password: 'brand-new-password' }).expect(200);

    await phone.get('/me').expect(200);
    await laptop.get('/me').expect(401);
    await t.http().post('/auth/login').send({ email: DEMO, password: TEST_PASSWORD }).expect(401);
    await t.http().post('/auth/login').send({ email: DEMO, password: 'brand-new-password' }).expect(200);
  });

  it('PW16. sign-up can include name and date of birth, so the profile is complete at once', async () => {
    const code = await codeFor(NEW_PERSON);
    const browser = t.browser();
    await browser
      .post('/auth/set-password')
      .send({ email: NEW_PERSON, code, password: TEST_PASSWORD, fullName: '  New Person ', dateOfBirth: '1992-03-04' })
      .expect(200);

    const me = (await browser.get('/me').expect(200)).body;
    expect(me).toMatchObject({ fullName: 'New Person', hasDateOfBirth: true, profileComplete: true });
    expect(JSON.stringify(me)).not.toContain('1992');
  });

  it('PW17. a reset never replaces an existing name or date of birth (they guard results)', async () => {
    const code = await codeFor(DEMO); // the seeded demo patient: name and date of birth already set
    await setPasswordWith(DEMO, code, { fullName: 'Someone Else', dateOfBirth: '2001-01-01' }).expect(200);

    const demo = await t.prisma.patient.findUniqueOrThrow({ where: { email: DEMO } });
    expect(demo.fullName).toBe('Demo Patient');
    expect(demo.dateOfBirth?.toISOString().slice(0, 10)).toBe('1990-01-15');
  });

  it('PW18. an impossible date of birth is refused, and the code still works afterwards', async () => {
    const code = await codeFor(NEW_PERSON);
    const res = await setPasswordWith(NEW_PERSON, code, { fullName: 'New Person', dateOfBirth: '2999-01-01' }).expect(400);
    expect(res.body.error).toBe('INVALID_INPUT');
    expect(await t.prisma.patient.count({ where: { email: NEW_PERSON } })).toBe(0);

    await setPasswordWith(NEW_PERSON, code, { fullName: 'New Person', dateOfBirth: '1992-03-04' }).expect(200);
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

// Each login runs scrypt on purpose (slow by design); CI machines are slower than a desktop.
describe('logging in with a password', { timeout: 60_000 }, () => {
  const loginWith = (email: string, password: string) => t.http().post('/auth/login').send({ email, password });

  beforeEach(async () => {
    await signUp(t, t.browser(), DEMO); // DEMO now has TEST_PASSWORD
  });

  it('PW9. the right password logs in; the session works', async () => {
    const browser = t.browser();
    const res = await browser.post('/auth/login').send({ email: ' Demo.Patient@example.com', password: TEST_PASSWORD }).expect(200);
    expect(sessionCookie(res)).toMatch(/HttpOnly/i);
    expect((await browser.get('/me').expect(200)).body.email).toBe(DEMO);
  });

  it('PW10. a wrong password, an unknown email and an account with no password all get the same 401', async () => {
    const wrongPassword = await loginWith(DEMO, 'not-the-password');
    const unknownEmail = await loginWith('nobody@example.com', TEST_PASSWORD);
    const noPassword = await loginWith('test.two@example.com', TEST_PASSWORD); // seeded, never signed up

    for (const res of [wrongPassword, unknownEmail, noPassword]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual(wrongPassword.body);
    }
    expect(wrongPassword.body).toEqual({ error: 'INVALID_LOGIN', reasons: [{ code: 'INVALID_LOGIN', message: 'Email or password is incorrect.' }] });
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
  });

  it('PW11. after 5 wrong passwords for an email, even the right one is refused for 15 minutes', async () => {
    for (let i = 0; i < 5; i++) await loginWith(DEMO, `wrong-${i}-password`).expect(401);
    const locked = await loginWith(DEMO, TEST_PASSWORD).expect(429);
    expect(locked.body.error).toBe('RATE_LIMITED');

    t.clock.advanceMinutes(16);
    await loginWith(DEMO, TEST_PASSWORD).expect(200);
  });

  it('PW12. an unknown email is limited exactly like a real one, so the limit reveals nothing', async () => {
    for (let i = 0; i < 5; i++) await loginWith('nobody@example.com', `wrong-${i}-password`).expect(401);
    await loginWith('nobody@example.com', TEST_PASSWORD).expect(429);
  });

  it('PW13. 20 failures from one IP block that IP, whatever email it tries next', async () => {
    for (let i = 0; i < 20; i++) await loginWith(`person${i}@example.com`, 'some-password').expect(401);
    await loginWith(DEMO, TEST_PASSWORD).expect(429);
  });

  it('PW14. failures are recorded without the password', async () => {
    await loginWith(DEMO, 'secret-guess-123').expect(401);
    const failures = await t.prisma.loginFailure.findMany();
    expect(failures).toHaveLength(1);
    expect(failures[0].email).toBe(DEMO);
    const everything = JSON.stringify([failures, await t.prisma.auditEvent.findMany()]);
    expect(everything).not.toContain('secret-guess-123');
  });

  it('PW15. the old code-only login is gone', async () => {
    await t.http().post('/auth/verify').send({ email: DEMO, code: '123456' }).expect(404);
  });
});

describe('sessions', () => {
  it('A10. after logout the old cookie no longer works', async () => {
    const browser = t.browser();
    const res = await signUp(t, browser, DEMO);
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
    const res = await signUp(t, t.browser(), DEMO);
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

    // The audit names exactly the fields that were sent, never their values.
    // (The audit log is never wiped, so look for this patient's event only.)
    const { id } = await t.prisma.patient.findUniqueOrThrow({ where: { email: NEW_PERSON } });
    const event = await t.prisma.auditEvent.findFirstOrThrow({ where: { action: 'PROFILE_UPDATED', actorId: id } });
    expect(event.details).toEqual({ fields: ['fullName', 'dateOfBirth'] });
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
