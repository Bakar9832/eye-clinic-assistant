import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { Clock } from '../clock.js';
import { PrismaClient, type NotificationType } from '../generated/prisma/client.js';
import { doctorOf } from '../mcp/clinic-tools.service.js';
import { isUniqueViolation } from '../prisma/db-errors.js';
import { EmailSender, type Email } from './email-sender.js';

/** A claim older than this with no sentAt is from a run that crashed mid-send: try again. */
const STALE_CLAIM_MINUTES = 10;

interface Due {
  type: NotificationType;
  dedupeKey: string;
  patientId: string;
  appointmentId?: string;
  email: Email;
}

export interface RunResult {
  sent: number;
  failed: number;
}

/**
 * The emails the clinic sends on its own: a reminder before each appointment, and a
 * yearly check-up reminder. One run sends everything that is due; the worker calls it
 * every minute.
 *
 * Each email is claimed before it is sent, by inserting its Notification row: the
 * unique (type, dedupe_key) lets only one run (or one API instance) win. Exactly once
 * normally; at least once if the process dies between sending and recording it.
 * Emails state clinic time with the zone's name, and never carry clinical information.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('Notifications');

  constructor(
    private readonly prisma: PrismaClient,
    private readonly email: EmailSender,
    private readonly clock: Clock,
  ) {}

  async runOnce(now = this.clock.now()): Promise<RunResult> {
    await this.prisma.notification.deleteMany({
      where: { sentAt: null, claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MINUTES * 60_000) } },
    });
    const settings = await this.prisma.clinicSetting.findUniqueOrThrow({ where: { id: 1 } });
    const due = await this.notYetClaimed([
      ...(await this.dueReminders(settings, now)),
      ...(await this.dueCheckups(settings, now)),
      ...(await this.dueGlasses(settings)),
    ]);

    const result: RunResult = { sent: 0, failed: 0 };
    for (const item of due) {
      const outcome = await this.deliver(item, now);
      if (outcome === 'sent') result.sent++;
      if (outcome === 'failed') result.failed++;
    }
    return result;
  }

  /** Claim, send, record. A failed send gives the claim back, so the next run retries. */
  private async deliver(item: Due, now: Date): Promise<'sent' | 'taken' | 'failed'> {
    const key = { type: item.type, dedupeKey: item.dedupeKey };
    try {
      await this.prisma.notification.create({
        data: { ...key, patientId: item.patientId, appointmentId: item.appointmentId, claimedAt: now },
      });
    } catch (error) {
      if (isUniqueViolation(error)) return 'taken'; // another run got there first
      throw error;
    }

    try {
      await this.email.send(item.email);
    } catch (error) {
      await this.prisma.notification.deleteMany({ where: { ...key, sentAt: null } });
      // The address is personal data, so only the kind of email goes in the log.
      this.logger.warn(`Could not send ${item.type}: ${(error as Error).message}`);
      return 'failed';
    }
    await this.prisma.notification.update({ where: { type_dedupeKey: key }, data: { sentAt: this.clock.now() } });
    return 'sent';
  }

  /** Skips what an earlier run already claimed, so each run doesn't retry every claim. */
  private async notYetClaimed(due: Due[]): Promise<Due[]> {
    if (due.length === 0) return due;
    const claimed = await this.prisma.notification.findMany({
      where: { dedupeKey: { in: due.map((d) => d.dedupeKey) } },
      select: { type: true, dedupeKey: true },
    });
    const taken = new Set(claimed.map((c) => `${c.type}|${c.dedupeKey}`));
    return due.filter((d) => !taken.has(`${d.type}|${d.dedupeKey}`));
  }

  /** Booked appointments starting within the reminder window. */
  private async dueReminders(settings: Settings, now: Date): Promise<Due[]> {
    const appointments = await this.prisma.appointment.findMany({
      where: {
        status: 'BOOKED',
        startsAt: { gt: now, lte: new Date(now.getTime() + settings.reminderHoursBefore * 3_600_000) },
        // The demo patient's address is made up: never email it.
        patient: { isDemo: false },
      },
      include: { patient: true, appointmentType: true, allocations: { where: { active: true }, include: { resource: true } } },
    });
    return appointments.map((a) => {
      const when = DateTime.fromJSDate(a.startsAt, { zone: settings.timezone });
      const doctor = doctorOf(a);
      return {
        type: 'APPOINTMENT_REMINDER',
        // The start time is part of the key: a moved appointment gets a new reminder.
        dedupeKey: `${a.id}@${a.startsAt.toISOString()}`,
        patientId: a.patientId,
        appointmentId: a.id,
        email: {
          to: a.patient.email,
          subject: `Reminder: your ${a.appointmentType.name.toLowerCase()} on ${when.toFormat('cccc d LLLL')} at ${when.toFormat('HH:mm')}`,
          text: [
            `Hello ${a.patient.fullName ?? 'there'},`,
            '',
            `This is a reminder of your appointment at ${settings.name}.`,
            '',
            `What: ${a.appointmentType.name}${doctor ? ` with ${doctor}` : ''}`,
            `When: ${clinicTime(when, settings.timezone)}`,
            `Reference: ${a.reference}`,
            '',
            `Preparation: ${a.appointmentType.prepInstructions}`,
            '',
            'To move or cancel it, use the chat or "My appointments" on our website.',
          ].join('\n'),
        },
      };
    });
  }

  /**
   * Patients whose last yearly-type visit (routine test, child's exam) is old enough,
   * with no such visit booked. Keyed by that visit, so it is sent once per visit, so at
   * most once a year.
   */
  private async dueCheckups(settings: Settings, now: Date): Promise<Due[]> {
    const cutoff = DateTime.fromJSDate(now, { zone: settings.timezone }).minus({ months: settings.annualReminderMonths });
    const lastVisits = await this.prisma.appointment.findMany({
      where: { status: 'COMPLETED', appointmentType: { annualReminder: true }, patient: { isDemo: false } },
      orderBy: { startsAt: 'desc' },
      distinct: ['patientId'], // with the ordering: each patient's latest one
      include: { patient: true, appointmentType: true },
    });
    const old = lastVisits.filter((v) => v.startsAt <= cutoff.toJSDate());
    if (old.length === 0) return [];

    const alreadyBooked = new Set(
      (
        await this.prisma.appointment.findMany({
          where: {
            patientId: { in: old.map((v) => v.patientId) },
            status: 'BOOKED',
            startsAt: { gt: now },
            appointmentType: { annualReminder: true },
          },
          select: { patientId: true },
        })
      ).map((a) => a.patientId),
    );

    return old
      .filter((v) => !alreadyBooked.has(v.patientId))
      .map((v) => {
        const last = DateTime.fromJSDate(v.startsAt, { zone: settings.timezone });
        return {
          type: 'ANNUAL_CHECKUP',
          dedupeKey: v.id,
          patientId: v.patientId,
          email: {
            to: v.patient.email,
            subject: 'Time for your yearly eye check-up',
            text: [
              `Hello ${v.patient.fullName ?? 'there'},`,
              '',
              `Your last ${v.appointmentType.name.toLowerCase()} at ${settings.name} was on ${last.toFormat('d LLLL yyyy')}.`,
              'An eye check-up once a year helps catch changes early.',
              '',
              'You can book one in the chat or the calendar on our website.',
            ].join('\n'),
          },
        };
      });
  }

  /** Glasses staff marked as ready. Keyed by the outcome: one email per pair. */
  private async dueGlasses(settings: Settings): Promise<Due[]> {
    const ready = await this.prisma.outcome.findMany({
      where: {
        glassesReadyAt: { not: null },
        appointment: {
          patient: { isDemo: false },
          // Only ones not emailed yet, so this doesn't grow with every pair ever made.
          notifications: { none: { type: 'GLASSES_READY' } },
        },
      },
      include: { appointment: { include: { patient: true } } },
    });
    return ready.map((o) => ({
      type: 'GLASSES_READY',
      dedupeKey: o.id,
      patientId: o.appointment.patientId,
      appointmentId: o.appointmentId,
      email: {
        to: o.appointment.patient.email,
        subject: 'Your glasses are ready to collect',
        text: [
          `Hello ${o.appointment.patient.fullName ?? 'there'},`,
          '',
          `Your new glasses are ready to collect from ${settings.name}.`,
          `Please bring your booking reference (${o.appointment.reference}) when you come.`,
        ].join('\n'),
      },
    }));
  }
}

type Settings = { name: string; timezone: string; reminderHoursBefore: number; annualReminderMonths: number };

/** "Tuesday 15 January 2030, 10:00 clinic time (Asia/Karachi)": no browser to convert it. */
function clinicTime(when: DateTime, zone: string): string {
  return `${when.toFormat('cccc d LLLL yyyy, HH:mm')} clinic time (${zone})`;
}
