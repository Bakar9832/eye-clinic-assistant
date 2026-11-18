// The staff door: login, cookie separation, session length, deactivation.

import { seedClinic } from '../prisma/clinic-data.js';
import { hashPassword } from '../src/auth/password.js';
import { createTestApp, login, staffLogin, TEST_PASSWORD, type TestApp } from './harness.js';

let t: TestApp;
let clinic: Awaited<ReturnType<typeof seedClinic>>;
const DR_AYESHA = 'dr.ayesha@clinic.example';

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  clinic = await t.reset();
});
afterAll(async () => {
  await t.app.close();
});

function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string {
  const all = ([] as string[]).concat((res.headers['set-cookie'] as string[] | string | undefined) ?? []);
  const found = all.find((c) => c.startsWith(`${name}=`));
  if (!found) throw new Error(`No ${name} cookie`);
  return found;
}

describe('staff login', () => {
  /** Gives Dr Ayesha TEST_PASSWORD (seeded staff have none) and returns the login response. */
  async function ayeshaLogin(browser = t.browser()) {
    await t.prisma.staffUser.update({ where: { email: DR_AYESHA }, data: { passwordHash: await hashPassword(TEST_PASSWORD) } });
    return browser.post('/staff/auth/login').send({ email: DR_AYESHA, password: TEST_PASSWORD }).expect(200);
  }

  it('S1. an unknown email and a wrong password get the same 401; nothing is created', async () => {
    await ayeshaLogin();
    const wrong = await t.http().post('/staff/auth/login').send({ email: DR_AYESHA, password: 'not-it-at-all' });
    const unknown = await t.http().post('/staff/auth/login').send({ email: 'intruder@example.com', password: TEST_PASSWORD });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
    expect(await t.prisma.staffUser.count({ where: { email: 'intruder@example.com' } })).toBe(0);
    expect(await t.prisma.patient.count({ where: { email: 'intruder@example.com' } })).toBe(0);
  });

  it('S1b. staff cannot sign up or reset: there is no staff code endpoint any more', async () => {
    await t.http().post('/staff/auth/request-code').send({ email: DR_AYESHA }).expect(404);
    await t.http().post('/staff/auth/verify').send({ email: DR_AYESHA, code: '123456' }).expect(404);
  });

  it('S2. staff login sets an HttpOnly staff_session cookie limited to /staff', async () => {
    const browser = t.browser();
    const res = await ayeshaLogin(browser);

    const cookie = cookieFrom(res, 'staff_session');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/staff/);

    const me = await browser.get('/staff/me').expect(200);
    expect(me.body).toEqual({ id: clinic.staff.drAyesha.id, email: DR_AYESHA, displayName: 'Dr Ayesha', role: 'DOCTOR' });
  });

  it("a patient's password does not open the staff door, and the other way round", async () => {
    // Same email in both places would be unusual, but the passwords must still not cross over.
    await t.prisma.patient.create({ data: { email: DR_AYESHA, passwordHash: await hashPassword('patient-password') } });
    await t.prisma.staffUser.update({ where: { email: DR_AYESHA }, data: { passwordHash: await hashPassword('staff-password') } });

    await t.http().post('/staff/auth/login').send({ email: DR_AYESHA, password: 'patient-password' }).expect(401);
    await t.http().post('/auth/login').send({ email: DR_AYESHA, password: 'staff-password' }).expect(401);
  });

  it('S3. a patient cookie is refused on staff routes; a staff token is refused on patient routes', async () => {
    const patient = await login(t, 'demo.patient@example.com');
    await patient.get('/staff/me').expect(401);

    // Even forcing the staff token into the patient cookie doesn't work.
    const res = await ayeshaLogin();
    const staffToken = cookieFrom(res, 'staff_session').split(';')[0].slice('staff_session='.length);
    await t.http().get('/me').set('Cookie', `session=${staffToken}`).expect(401);
  });

  it('S4. staff sessions last 12 hours', async () => {
    const browser = await staffLogin(t, DR_AYESHA);
    t.clock.advanceMinutes(12 * 60 - 1);
    await browser.get('/staff/me').expect(200);
    t.clock.advanceMinutes(2);
    await browser.get('/staff/me').expect(401);
  });

  it('S5. switching an account off locks it out at once, open sessions included', async () => {
    const browser = await staffLogin(t, DR_AYESHA);
    await t.prisma.staffUser.update({ where: { id: clinic.staff.drAyesha.id }, data: { active: false } });

    await browser.get('/staff/me').expect(401);
    const again = await t.http().post('/staff/auth/login').send({ email: DR_AYESHA, password: TEST_PASSWORD }).expect(401);
    expect(again.body.error).toBe('INVALID_LOGIN'); // the same answer as a wrong password
  });

  it('logout ends the staff session', async () => {
    const browser = await staffLogin(t, DR_AYESHA);
    await browser.post('/staff/auth/logout').set('Content-Type', 'application/json').expect(204);
    await browser.get('/staff/me').expect(401);
  });
});
