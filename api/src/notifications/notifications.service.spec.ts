import { seedClinic } from '../../prisma/clinic-data.js';
import { AuditService } from '../audit/audit.service.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { KARACHI, LONG_AGO, MON, local } from '../availability/test-fixtures.js';
import { BookingService } from '../booking/booking.service.js';
import { SystemClock } from '../clock.js';
import { testPrisma } from '../testing-db.js';
import { EmailSender, type Email } from './email-sender.js';
import { NotificationsService } from './notifications.service.js';

/** Captures emails; can be told to fail, like a mail server that is down. */
class Inbox extends EmailSender {
  sent: Email[] = [];
  down = false;
  async send(email: Email) {
    if (this.down) throw new Error('connection refused');
    this.sent.push(email);
  }
}

const prisma = testPrisma();
const clock = new SystemClock();
const booking = new BookingService(prisma, new AvailabilityService(prisma), new AuditService(prisma, clock));
let inbox: Inbox;
let notifications: NotificationsService;
let clinic: Awaited<ReturnType<typeof seedClinic>>;

beforeEach(async () => {
  clinic = await seedClinic(prisma, KARACHI);
  inbox = new Inbox();
  notifications = new NotificationsService(prisma, inbox, clock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** A follow-up for Test Patient Two (a real-looking patient, not the demo one). */
const followUp = (time = '10:00', patient: 'two' | 'demo' = 'two') =>
  booking.book(clinic.patients[patient].id, { typeCode: 'FOLLOW_UP', start: local(MON, time) }, LONG_AGO);

/** `hours` before MON 10:00, clinic time. */
const before = (hours: number) => new Date(local(MON, '10:00').getTime() - hours * 3_600_000);

describe('appointment reminders', () => {
  it('R1. one reminder inside the 24-hour window; a second run sends nothing more', async () => {
    await followUp();

    expect(await notifications.runOnce(before(25))).toEqual({ sent: 0, failed: 0 });
    expect(await notifications.runOnce(before(23))).toEqual({ sent: 1, failed: 0 });
    expect(await notifications.runOnce(before(22))).toEqual({ sent: 0, failed: 0 });

    expect(inbox.sent).toHaveLength(1);
    expect(inbox.sent[0].to).toBe('test.two@example.com');
  });

  it('R2. cancelled or completed appointments get no reminder', async () => {
    const cancelled = await followUp('10:00');
    await booking.cancel(clinic.patients.two.id, cancelled.id, LONG_AGO);
    const completed = await booking.book(
      clinic.patients.two.id,
      { typeCode: 'SCAN_ONLY', start: local(MON, '11:00') },
      LONG_AGO,
    );
    await prisma.appointment.update({ where: { id: completed.id }, data: { status: 'COMPLETED' } });

    await notifications.runOnce(before(23));

    expect(inbox.sent).toEqual([]);
  });

  it('R3. moved after its reminder: a new reminder for the new time', async () => {
    const appointment = await followUp('10:00');
    await notifications.runOnce(before(23));

    await booking.reschedule(clinic.patients.two.id, appointment.id, { start: local(MON, '11:00') }, LONG_AGO);
    await notifications.runOnce(before(22));

    expect(inbox.sent.map((e) => e.subject)).toEqual([
      'Reminder: your follow-up visit on Monday 26 October at 10:00',
      'Reminder: your follow-up visit on Monday 26 October at 11:00',
    ]);
  });

  it('R4. two runs at once still send one email: the unique claim decides, not the pre-check', async () => {
    await followUp();
    // Make both runs believe nothing was claimed yet, as if they started at the same instant.
    vi.spyOn(prisma.notification, 'findMany').mockResolvedValue([]);

    const results = await Promise.all([notifications.runOnce(before(23)), notifications.runOnce(before(23))]);

    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(1);
    expect(inbox.sent).toHaveLength(1);
  });

  it('R5. clinic time with the zone name, reference, doctor and preparation; nothing clinical', async () => {
    const appointment = await followUp();

    await notifications.runOnce(before(23));

    const { text } = inbox.sent[0];
    expect(text).toContain('When: Monday 26 October 2026, 10:00 clinic time (Asia/Karachi)');
    expect(text).toContain(`Reference: ${appointment.reference}`);
    expect(text).toContain('What: Follow-up visit with Dr ');
    expect(text).toContain('Preparation: Bring your current glasses or contact lenses.');
    expect(text).not.toMatch(/outcome|prescription|result|NO_CHANGE|REFERRAL/i);
  });

  it("R6. the demo patient is never emailed: its address isn't real", async () => {
    await followUp('10:00', 'demo');

    await notifications.runOnce(before(23));

    expect(inbox.sent).toEqual([]);
  });

  it('R7. mail server down: nothing is recorded as sent, and the next run delivers it', async () => {
    await followUp();
    inbox.down = true;

    expect(await notifications.runOnce(before(23))).toEqual({ sent: 0, failed: 1 });
    expect(await prisma.notification.count()).toBe(0);

    inbox.down = false;
    expect(await notifications.runOnce(before(22))).toEqual({ sent: 1, failed: 0 });
  });

  it('R8. a claim left by a run that crashed mid-send is retried after 10 minutes', async () => {
    const appointment = await followUp();
    await prisma.notification.create({
      data: {
        type: 'APPOINTMENT_REMINDER',
        dedupeKey: `${appointment.id}@${appointment.startsAt.toISOString()}`,
        patientId: clinic.patients.two.id,
        appointmentId: appointment.id,
        claimedAt: new Date(before(23).getTime() - 11 * 60_000),
      },
    });

    expect(await notifications.runOnce(before(23))).toEqual({ sent: 1, failed: 0 });
  });
});

describe('yearly check-up reminder', () => {
  /** A routine eye test on MON that was carried out (an outcome makes it COMPLETED). */
  async function completedRoutineTest(type = 'ROUTINE_EYE_TEST') {
    const visit = await booking.book(clinic.patients.two.id, { typeCode: type, start: local(MON, '09:00') }, LONG_AGO);
    await prisma.appointment.update({ where: { id: visit.id }, data: { status: 'COMPLETED' } });
    return visit;
  }

  it('A1. 11 months after the last routine test: one reminder, sent once', async () => {
    await completedRoutineTest();

    await notifications.runOnce(local('2027-08-27', '09:00')); // 10 months: too early
    await notifications.runOnce(local('2027-09-27', '09:00'));
    await notifications.runOnce(local('2027-10-27', '09:00'));

    expect(inbox.sent.map((e) => e.subject)).toEqual(['Time for your yearly eye check-up']);
    expect(inbox.sent[0].text).toContain('Your last routine eye test at Demo Eye Clinic was on 26 October 2026.');
  });

  it('A2. not when the next one is already booked, nor after a visit type that is not yearly', async () => {
    await completedRoutineTest();
    await booking.book(clinic.patients.two.id, { typeCode: 'ROUTINE_EYE_TEST', start: local('2027-10-04', '09:00') }, LONG_AGO);
    const scan = await booking.book(clinic.patients.three.id, { typeCode: 'SCAN_ONLY', start: local(MON, '11:00') }, LONG_AGO);
    await prisma.appointment.update({ where: { id: scan.id }, data: { status: 'COMPLETED' } });

    await notifications.runOnce(local('2027-09-27', '09:00'));

    expect(inbox.sent).toEqual([]);
  });
});

describe('glasses ready', () => {
  /** A completed exam for this patient with a NEW_PRESCRIPTION outcome, glasses marked ready. */
  async function glassesReady(patient: 'two' | 'demo' = 'two', time = '10:00') {
    const exam = await followUp(time, patient);
    await prisma.appointment.update({ where: { id: exam.id }, data: { status: 'COMPLETED' } });
    await prisma.outcome.create({
      data: {
        appointmentId: exam.id,
        code: 'NEW_PRESCRIPTION',
        patientNote: 'Your new glasses will make reading easier.',
        recordedByStaffId: clinic.staff.drAyesha.id,
        recordedAt: local(MON, '10:20'),
        glassesReadyAt: local('2026-11-02', '12:00'),
      },
    });
    return exam;
  }

  it('G3. one email once the glasses are marked; nothing clinical, no second email', async () => {
    const exam = await glassesReady();

    await notifications.runOnce(local('2026-11-02', '12:01'));
    await notifications.runOnce(local('2026-11-02', '12:02'));

    expect(inbox.sent.map((e) => e.subject)).toEqual(['Your glasses are ready to collect']);
    expect(inbox.sent[0].text).toContain('Your new glasses are ready to collect from Demo Eye Clinic.');
    expect(inbox.sent[0].text).toContain(exam.reference);
    expect(inbox.sent[0].text).not.toMatch(/prescription|reading easier|NEW_PRESCRIPTION/i);
  });

  it('G3b. never for the demo patient; and a failed send is retried', async () => {
    await glassesReady('demo');
    await notifications.runOnce(local('2026-11-02', '12:01'));
    expect(inbox.sent).toEqual([]);

    await glassesReady('two', '11:00');
    inbox.down = true;
    expect(await notifications.runOnce(local('2026-11-02', '12:01'))).toEqual({ sent: 0, failed: 1 });
    inbox.down = false;
    expect(await notifications.runOnce(local('2026-11-02', '12:02'))).toEqual({ sent: 1, failed: 0 });
  });
});
