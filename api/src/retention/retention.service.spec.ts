import { seedClinic } from '../../prisma/clinic-data.js';
import { AuditService } from '../audit/audit.service.js';
import { KARACHI } from '../availability/test-fixtures.js';
import { Clock } from '../clock.js';
import { testPrisma } from '../testing-db.js';
import { RetentionService } from './retention.service.js';

const NOW = new Date('2026-12-01T00:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 3_600_000);
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

class FixedClock extends Clock {
  now() {
    return new Date(NOW);
  }
}

const prisma = testPrisma();
const retention = new RetentionService(prisma, new AuditService(prisma, new FixedClock()), new FixedClock());
let clinic: Awaited<ReturnType<typeof seedClinic>>;

beforeEach(async () => {
  clinic = await seedClinic(prisma, KARACHI);
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** A chat with one message, last used `lastDaysAgo`, started `startedDaysAgo`. */
async function chat(lastDaysAgo: number, startedDaysAgo = lastDaysAgo) {
  return prisma.conversation.create({
    data: {
      patientId: clinic.patients.two.id,
      createdAt: daysAgo(startedDaysAgo),
      lastMessageAt: daysAgo(lastDaysAgo),
      messages: { create: { role: 'USER', text: 'My eye is a bit pink.', requestIp: '203.0.113.7', createdAt: daysAgo(lastDaysAgo) } },
    },
  });
}

const handoff = (status: 'OPEN' | 'CLOSED', createdDaysAgo: number, conversationId?: string) =>
  prisma.handoffRequest.create({
    data: { patientId: clinic.patients.two.id, conversationId, reason: 'Asks about eye drops.', status, createdAt: daysAgo(createdDaysAgo) },
  });

const exists = async (id: string) => (await prisma.conversation.findUnique({ where: { id } })) !== null;

describe('chats', () => {
  it('D1. deleted 30 days after the LAST message, with their messages; a chat still in use stays', async () => {
    const old = await chat(31);
    const recent = await chat(29);
    const longRunning = await chat(1, 40);

    expect(await retention.runOnce()).toMatchObject({ chats: 1 });

    expect(await exists(old.id)).toBe(false);
    expect(await prisma.chatMessage.count({ where: { conversationId: old.id } })).toBe(0);
    expect(await exists(recent.id)).toBe(true);
    expect(await exists(longRunning.id)).toBe(true);
  });

  it('D7. the period is a clinic setting', async () => {
    await prisma.clinicSetting.update({ where: { id: 1 }, data: { chatRetentionDays: 7 } });
    const eightDays = await chat(8);

    await retention.runOnce();

    expect(await exists(eightDays.id)).toBe(false);
  });
});

describe('handoffs', () => {
  it('D2. closed ones go after 30 days; open ones never, even when their chat is deleted', async () => {
    const oldChat = await chat(31);
    const openFromOldChat = await handoff('OPEN', 31, oldChat.id);
    const oldClosed = await handoff('CLOSED', 31);
    const recentClosed = await handoff('CLOSED', 29);

    expect(await retention.runOnce()).toMatchObject({ handoffs: 1 });

    const left = await prisma.handoffRequest.findMany({ orderBy: { createdAt: 'asc' } });
    expect(left.map((h) => h.id).sort()).toEqual([openFromOldChat.id, recentClosed.id].sort());
    expect(left.find((h) => h.id === openFromOldChat.id)).toMatchObject({ conversationId: null, reason: 'Asks about eye drops.' });
    expect(left.some((h) => h.id === oldClosed.id)).toBe(false);
  });
});

describe('login codes and sessions', () => {
  it('D3. login codes go after 24 hours; recent ones stay for the rate limits', async () => {
    const code = (createdAt: Date) =>
      prisma.loginCode.create({
        data: { email: 'test.two@example.com', codeHash: 'x', requestIp: '203.0.113.7', createdAt, expiresAt: new Date(createdAt.getTime() + 600_000) },
      });
    await code(hoursAgo(25));
    const recent = await code(hoursAgo(0.5));

    expect(await retention.runOnce()).toMatchObject({ loginCodes: 1 });
    expect((await prisma.loginCode.findMany()).map((c) => c.id)).toEqual([recent.id]);
  });

  it('D4. sessions go a day after they stopped working; nobody is logged out', async () => {
    const session = (tokenHash: string, expiresAt: Date, revokedAt?: Date) =>
      prisma.session.create({ data: { tokenHash, patientId: clinic.patients.two.id, createdAt: daysAgo(10), expiresAt, revokedAt } });
    await session('expired-two-days-ago', daysAgo(2));
    await session('logged-out-two-days-ago', daysAgo(-5), daysAgo(2));
    const justExpired = await session('expired-an-hour-ago', hoursAgo(1));
    const active = await session('active', daysAgo(-5));

    expect(await retention.runOnce()).toMatchObject({ sessions: 2 });
    expect((await prisma.session.findMany()).map((s) => s.id).sort()).toEqual([justExpired.id, active.id].sort());
  });
});

describe('what is kept, and the record of each run', () => {
  it('D5. patients, appointments, results, sent-email records and the audit log are untouched', async () => {
    const type = await prisma.appointmentType.findUniqueOrThrow({ where: { code: 'FOLLOW_UP' } });
    const visit = await prisma.appointment.create({
      data: {
        reference: 'EC-OLD234',
        patientId: clinic.patients.two.id,
        appointmentTypeId: type.id,
        startsAt: daysAgo(400),
        endsAt: new Date(daysAgo(400).getTime() + 15 * 60_000),
        status: 'COMPLETED',
      },
    });
    await prisma.outcome.create({
      data: { appointmentId: visit.id, code: 'NO_CHANGE', patientNote: 'All well.', recordedByStaffId: clinic.staff.drAyesha.id, recordedAt: daysAgo(400) },
    });
    await prisma.notification.create({
      data: { type: 'ANNUAL_CHECKUP', dedupeKey: visit.id, patientId: clinic.patients.two.id, claimedAt: daysAgo(60), sentAt: daysAgo(60) },
    });
    await prisma.auditEvent.create({ data: { at: daysAgo(400), actorType: 'SYSTEM', action: 'OLD_EVENT' } });
    const before = await counts();

    await retention.runOnce();

    expect(await counts()).toEqual({ ...before, audit: before.audit + 1 }); // + this run's own entry
  });

  it('D6. a second run deletes nothing more; each run is audited with counts only', async () => {
    await chat(31);
    // The audit log is append-only, so it still holds earlier tests' runs: count the difference.
    const runsBefore = await prisma.auditEvent.count({ where: { action: 'RETENTION_RUN' } });

    const first = await retention.runOnce();
    const second = await retention.runOnce();

    expect(first).toEqual({ chats: 1, handoffs: 0, loginCodes: 0, sessions: 0 });
    expect(second).toEqual({ chats: 0, handoffs: 0, loginCodes: 0, sessions: 0 });
    const runs = await prisma.auditEvent.findMany({ where: { action: 'RETENTION_RUN' } });
    expect(runs).toHaveLength(runsBefore + 2);
    for (const run of runs) {
      expect(Object.keys(run.details as object).sort()).toEqual(['chats', 'handoffs', 'loginCodes', 'sessions']);
    }
    expect(JSON.stringify(runs)).not.toContain('pink');
  });
});

async function counts() {
  const [patients, appointments, outcomes, notifications, audit] = await Promise.all([
    prisma.patient.count(),
    prisma.appointment.count(),
    prisma.outcome.count(),
    prisma.notification.count(),
    prisma.auditEvent.count(),
  ]);
  return { patients, appointments, outcomes, notifications, audit };
}
