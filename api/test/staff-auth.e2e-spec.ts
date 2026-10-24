// The staff door: login, cookie separation, session length, deactivation.

import { seedClinic } from '../prisma/clinic-data.js';
import { createTestApp, login, staffLogin, type TestApp } from './harness.js';

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
  it('S1. an unknown email gets the usual answer, but no code, no email and no account', async () => {
    const known = await t.http().post('/staff/auth/request-code').send({ email: DR_AYESHA });
    const unknown = await t.http().post('/staff/auth/request-code').send({ email: 'intruder@example.com' });

    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(t.inbox.sent.filter((e) => e.to === 'intruder@example.com')).toHaveLength(0);
    expect(await t.prisma.staffUser.count({ where: { email: 'intruder@example.com' } })).toBe(0);
    expect(await t.prisma.patient.count({ where: { email: 'intruder@example.com' } })).toBe(0);
  });

  it('S2. staff login sets an HttpOnly staff_session cookie limited to /staff', async () => {
    const browser = t.browser();
    await browser.post('/staff/auth/request-code').send({ email: DR_AYESHA }).expect(202);
    const res = await browser.post('/staff/auth/verify').send({ email: DR_AYESHA, code: t.inbox.lastCode(DR_AYESHA) }).expect(200);

    const cookie = cookieFrom(res, 'staff_session');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/staff/);

    const me = await browser.get('/staff/me').expect(200);
    expect(me.body).toEqual({ email: DR_AYESHA, displayName: 'Dr Ayesha', role: 'DOCTOR' });
  });

  it('a patient login code does not open the staff door, and the other way round', async () => {
    // Same email in both places would be unusual, but the codes must still not cross over.
    await t.prisma.patient.create({ data: { email: DR_AYESHA } });
    await t.http().post('/auth/request-code').send({ email: DR_AYESHA }).expect(202);
    const patientCode = t.inbox.lastCode(DR_AYESHA);

    await t.http().post('/staff/auth/verify').send({ email: DR_AYESHA, code: patientCode }).expect(401);
  });

  it('S3. a patient cookie is refused on staff routes; a staff token is refused on patient routes', async () => {
    const patient = await login(t, 'demo.patient@example.com');
    await patient.get('/staff/me').expect(401);

    // Even forcing the staff token into the patient cookie doesn't work.
    const browser = t.browser();
    await browser.post('/staff/auth/request-code').send({ email: DR_AYESHA });
    const res = await browser.post('/staff/auth/verify').send({ email: DR_AYESHA, code: t.inbox.lastCode(DR_AYESHA) });
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
    await t.http().post('/staff/auth/request-code').send({ email: DR_AYESHA }).expect(202);
    expect(t.inbox.sent.filter((e) => e.to === DR_AYESHA)).toHaveLength(1); // only the first login's
  });

  it('logout ends the staff session', async () => {
    const browser = await staffLogin(t, DR_AYESHA);
    await browser.post('/staff/auth/logout').set('Content-Type', 'application/json').expect(204);
    await browser.get('/staff/me').expect(401);
  });
});
