// The MCP server, driven by a real MCP client exactly as the Python agent will use it.
// Agent tokens come from real chat turns, so identity always starts at the session cookie.

import { DateTime } from 'luxon';
import { seedClinic } from '../prisma/clinic-data.js';
import { agentTokenFor, createTestApp, login, mcpClient, staffLogin, toolData, ZONE, type TestApp } from './harness.js';

let t: TestApp;
let clinic: Awaited<ReturnType<typeof seedClinic>>;

const MON = '2030-01-07';
const DEMO = 'demo.patient@example.com';
const DEMO_DOB = '1990-01-15';
const NOTE = 'Line one.\nYour prescription changed slightly: “new glasses”, 100% fine 👓';

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  clinic = await t.reset();
});
afterAll(async () => {
  await t.app.close();
});

type Client = Awaited<ReturnType<typeof mcpClient>>;
const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
const cardsOf = (result: unknown) => ((result as { _meta?: { cards?: unknown[] } })._meta?.cards ?? []) as Record<string, unknown>[];

/** A logged-in patient's browser plus an MCP client acting for them. */
async function asPatient(email = DEMO, viewerTimezone?: string) {
  const browser = await login(t, email);
  const client = await mcpClient(t, await agentTokenFor(t, browser, viewerTimezone));
  return { browser, client };
}

/** Gives the demo patient a recorded outcome (booked, examined, recorded by Dr Ayesha). */
async function recordOutcome(code: string, note = NOTE, email = DEMO) {
  const browser = await login(t, email);
  const booked = await browser
    .post('/me/appointments')
    .send({
      typeCode: 'FOLLOW_UP',
      start: DateTime.fromISO(`${MON}T09:00`, { zone: ZONE }).toUTC().toISO(),
      doctorId: clinic.resources.ayesha.id,
    })
    .expect(201);
  t.clock.set(DateTime.fromISO(`${MON}T09:20`, { zone: ZONE }).toJSDate());
  const ayesha = await staffLogin(t, 'dr.ayesha@clinic.example');
  await ayesha.post(`/staff/appointments/${booked.body.id}/outcome`).send({ code, patientNote: note }).expect(201);
}

describe('T1. the agent token', () => {
  it('no token, a tampered token or an expired token: 401', async () => {
    const res = await t.http().post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);

    const token = await agentTokenFor(t, t.browser());
    const [body, signature] = token.split('.');
    const tampered = `${body.slice(0, -2)}${body.slice(-2) === 'AA' ? 'BB' : 'AA'}.${signature}`;
    await expect(mcpClient(t, tampered)).rejects.toThrow();

    const client = await mcpClient(t, token);
    expect((await client.listTools()).tools.length).toBe(9);

    t.clock.advanceMinutes(6);
    await expect(mcpClient(t, token)).rejects.toThrow();
  });

  it("a patient can't change whose token it is: editing the payload breaks the signature", async () => {
    await asPatient();
    const token = t.agent.lastToken;
    const [body, signature] = token.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    payload.patientId = clinic.patients.two.id;
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
    await expect(mcpClient(t, forged)).rejects.toThrow();
  });
});

describe('T3. no tool can be told whose data to use', () => {
  it('none of the 9 tools has an identity field, and none accepts unknown fields', async () => {
    const client = await mcpClient(t, await agentTokenFor(t, t.browser()));
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        'book',
        'cancel',
        'check_availability',
        'get_my_appointments',
        'get_my_outcome',
        'get_offers',
        'handoff_to_staff',
        'list_appointment_types',
        'reschedule',
      ].sort(),
    );
    for (const tool of tools) {
      const properties = Object.keys(tool.inputSchema.properties ?? {});
      for (const property of properties) {
        expect(property, `${tool.name}.${property}`).not.toMatch(/patient|user|account|email|session|token|^id$|_id$/i);
      }
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
  });
});

describe('T2. without login', () => {
  it('public tools work; patient tools say LOGIN_REQUIRED', async () => {
    const client = await mcpClient(t, await agentTokenFor(t, t.browser()));

    const types = toolData(await call(client, 'list_appointment_types'));
    expect((types.appointment_types as { code: string; doctors: string[] }[]).find((x) => x.code === 'CHILD_EYE_EXAM')?.doctors).toEqual([
      'Dr Ayesha',
    ]);
    expect((await call(client, 'check_availability', { type: 'FOLLOW_UP', date_from: MON })).isError).toBe(false);

    for (const [name, args] of [
      ['book', { type: 'FOLLOW_UP', date: MON, time: '09:00' }],
      ['get_my_appointments', {}],
      ['get_my_outcome', {}],
      ['get_offers', {}],
      ['cancel', { reference: 'EC-ABCDEF' }],
    ] as const) {
      const result = await call(client, name, args);
      expect(result.isError, name).toBe(true);
      expect(toolData(result).error, name).toBe('LOGIN_REQUIRED');
    }
  });
});

describe('booking through the agent', () => {
  it('T4. book creates the booking for the token\'s patient and returns a ticket card', async () => {
    const { client } = await asPatient();
    const result = await call(client, 'book', { type: 'FOLLOW_UP', date: MON, time: '10:00', doctor: 'ayesha' });

    expect(result.isError).toBe(false);
    const data = toolData(result);
    expect(data).toMatchObject({ status: 'BOOKED', date: MON, clinic_time: '10:00', doctor: 'Dr Ayesha' });
    const saved = await t.prisma.appointment.findUniqueOrThrow({ where: { reference: data.reference as string } });
    expect(saved.patientId).toBe(clinic.patients.demo.id);
    expect(cardsOf(result)[0]).toMatchObject({ type: 'ticket', reference: data.reference });
  });

  it('T4b. an extra patientId argument is refused and nothing is booked', async () => {
    const { client } = await asPatient();
    const result = await call(client, 'book', {
      type: 'FOLLOW_UP',
      date: MON,
      time: '10:00',
      patientId: clinic.patients.two.id,
    });
    expect(result.isError).toBe(true);
    expect(await t.prisma.appointment.count()).toBe(0);
  });

  it("T5. another patient's reference can't be cancelled or moved", async () => {
    const two = await asPatient('test.two@example.com');
    const theirs = toolData(await call(two.client, 'book', { type: 'FOLLOW_UP', date: MON, time: '10:00' }));

    const { client } = await asPatient();
    for (const [name, args] of [
      ['cancel', { reference: theirs.reference }],
      ['reschedule', { reference: theirs.reference, date: MON, time: '11:00' }],
    ] as const) {
      const result = await call(client, name, args);
      expect(toolData(result).error, name).toBe('NOT_FOUND');
    }
    const saved = await t.prisma.appointment.findUniqueOrThrow({ where: { reference: theirs.reference as string } });
    expect(saved).toMatchObject({ status: 'BOOKED', startsAt: DateTime.fromISO(`${MON}T10:00`, { zone: ZONE }).toJSDate() });
  });

  it('reschedule and cancel work on my own reference', async () => {
    const { client } = await asPatient();
    const booked = toolData(await call(client, 'book', { type: 'FOLLOW_UP', date: MON, time: '10:00' }));

    const moved = toolData(await call(client, 'reschedule', { reference: booked.reference, date: MON, time: '11:00' }));
    expect(moved).toMatchObject({ status: 'MOVED', reference: booked.reference, clinic_time: '11:00' });
    expect(toolData(await call(client, 'cancel', { reference: booked.reference }))).toMatchObject({ status: 'CANCELLED' });

    const mine = toolData(await call(client, 'get_my_appointments')).appointments as { reference: string; status: string }[];
    expect(mine.find((a) => a.reference === booked.reference)?.status).toBe('CANCELLED');
  });

  it("booking refusals come back as reasons the model can explain", async () => {
    const { client } = await asPatient();
    const result = await call(client, 'book', { type: 'FOLLOW_UP', date: MON, time: '10:07' });
    expect(result.isError).toBe(true);
    expect(toolData(result)).toMatchObject({ error: 'INVALID_SLOT', reasons: [{ code: 'NOT_ON_GRID' }] });
  });
});

describe('T8. availability in clinic time and the viewer\'s time', () => {
  it('takes clinic-local dates and times and returns both clocks', async () => {
    const client = await mcpClient(t, await agentTokenFor(t, t.browser(), 'Europe/London'));
    const data = toolData(
      await call(client, 'check_availability', {
        type: 'FOLLOW_UP',
        doctor: 'Dr Ayesha',
        date_from: MON,
        time_from: '09:00',
        time_to: '10:00',
      }),
    );

    expect(data).toMatchObject({ clinic_timezone: ZONE, viewer_timezone: 'Europe/London' });
    const [day] = data.days as { weekday: string; slots: { clinic_time: string; viewer_time?: string; doctor: string }[] }[];
    expect(day.weekday).toBe('Monday');
    expect(day.slots.map((s) => s.clinic_time)).toEqual(['09:00', '09:15', '09:30', '09:45']);
    expect(day.slots[0]).toEqual({ date: MON, clinic_time: '09:00', viewer_time: 'Mon 7 Jan 04:00', doctor: 'Dr Ayesha' });
  });

  it('refuses ranges over 7 days and unknown doctors, saying who the doctors are', async () => {
    const client = await mcpClient(t, await agentTokenFor(t, t.browser()));
    expect(
      toolData(await call(client, 'check_availability', { type: 'FOLLOW_UP', date_from: MON, date_to: '2030-01-20' })).error,
    ).toBe('RANGE_TOO_LONG');
    const unknown = toolData(await call(client, 'check_availability', { type: 'FOLLOW_UP', doctor: 'Dr Who', date_from: MON }));
    expect(unknown).toMatchObject({ error: 'UNKNOWN_DOCTOR' });
    expect(unknown.message).toContain('Dr Ayesha');
  });
});

describe('T6. results through the agent', () => {
  it('before the date-of-birth check: DOB_REQUIRED and a prompt card, never a request to type it in chat', async () => {
    await recordOutcome('NO_CHANGE');
    const { client } = await asPatient();

    const result = await call(client, 'get_my_outcome');
    expect(toolData(result)).toMatchObject({ status: 'DOB_REQUIRED' });
    expect(String(toolData(result).instruction)).toMatch(/never ask them to type it in the chat/i);
    expect(cardsOf(result)).toEqual([{ type: 'dob_prompt' }]);
  });

  it("after the check: the note reaches the page word for word, and the model never sees it", async () => {
    await recordOutcome('NO_CHANGE');
    const { browser, client } = await asPatient();
    await browser.post('/me/verify-dob').send({ dateOfBirth: DEMO_DOB }).expect(200);

    const result = await call(client, 'get_my_outcome');
    const forModel = (result.content as { text: string }[])[0].text;
    expect(toolData(result)).toMatchObject({ status: 'READY', outcome: 'NO_CHANGE', doctor: 'Dr Ayesha' });
    expect(forModel).not.toContain('Line one');
    expect(forModel).not.toContain('prescription changed');
    expect(cardsOf(result)).toEqual([expect.objectContaining({ type: 'doctor_note', note: NOTE, doctorName: 'Dr Ayesha' })]);
  });
});

describe('T7. offers', () => {
  it('a new prescription gets its offers once; asking again gets none', async () => {
    await recordOutcome('NEW_PRESCRIPTION');
    const { browser, client } = await asPatient();
    await browser.post('/me/verify-dob').send({ dateOfBirth: DEMO_DOB }).expect(200);

    const first = toolData(await call(client, 'get_offers')).offers as { title: string }[];
    expect(first.map((o) => o.title).sort()).toEqual(['Free contact lens trial', 'Two pairs for $90']);
    expect(toolData(await call(client, 'get_offers')).offers).toEqual([]);
  });

  it('no_change gets no offer, and offers need the date-of-birth check too', async () => {
    await recordOutcome('NO_CHANGE');
    const { browser, client } = await asPatient();
    expect(toolData(await call(client, 'get_offers'))).toMatchObject({ status: 'DOB_REQUIRED' });

    await browser.post('/me/verify-dob').send({ dateOfBirth: DEMO_DOB }).expect(200);
    expect(toolData(await call(client, 'get_offers')).offers).toEqual([]);
  });
});

describe('T9. handoff to staff', () => {
  it('lands in the staff inbox; the reason stays out of the audit log', async () => {
    const { client } = await asPatient();
    const reason = 'Asks which eye drops to use for itchy eyes.';
    expect(toolData(await call(client, 'handoff_to_staff', { reason }))).toMatchObject({ status: 'PASSED_TO_STAFF' });

    const reception = await staffLogin(t, 'reception@clinic.example');
    const inbox = await reception.get('/staff/handoffs').expect(200);
    expect(inbox.body).toEqual([
      expect.objectContaining({ reason, status: 'OPEN', patient: { fullName: 'Demo Patient', email: DEMO } }),
    ]);
    expect(JSON.stringify(await t.prisma.auditEvent.findMany())).not.toContain('eye drops');

    await reception.post(`/staff/handoffs/${inbox.body[0].id}/close`).send({}).expect(200);
    expect((await reception.get('/staff/handoffs').expect(200)).body).toEqual([]);
  });

  it('works without login too', async () => {
    const client = await mcpClient(t, await agentTokenFor(t, t.browser()));
    expect(toolData(await call(client, 'handoff_to_staff', { reason: 'Wants to complain about parking.' }))).toMatchObject({
      status: 'PASSED_TO_STAFF',
    });
    expect(await t.prisma.handoffRequest.count({ where: { patientId: null } })).toBe(1);
  });
});
