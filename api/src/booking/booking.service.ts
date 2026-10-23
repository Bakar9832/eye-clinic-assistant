import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { PrismaClient } from '../generated/prisma/client.js';
import { AvailabilityService } from '../availability/availability.service.js';
import type { Slot } from '../availability/types.js';
import { isOverlapViolation, isUniqueViolation } from '../prisma/db-errors.js';
import { SchedulingError, type Reason } from '../scheduling-error.js';
import { generateReference } from './reference.js';

export interface BookingRequest {
  typeCode: string;
  /** The start time the patient chose. The end is never taken from the caller. */
  start: Date;
  doctorId?: string;
}

/** How many times to retry when another booking grabbed a resource at the same moment. */
const MAX_ATTEMPTS = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Books and cancels appointments.
 *
 * patientId always comes from the server side (the session, from Slice 2), never from
 * a request body. There is deliberately no HTTP endpoint for booking until then.
 */
@Injectable()
export class BookingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly availability: AvailabilityService,
  ) {}

  async book(patientId: string, request: BookingRequest, now = new Date()) {
    // The clinic-local day the requested start falls on.
    const { timezone } = await this.prisma.clinicSetting.findUniqueOrThrow({ where: { id: 1 } });
    const day = DateTime.fromJSDate(request.start, { zone: timezone }).toISODate()!;

    for (let attempt = 1; ; attempt++) {
      // Recalculate every attempt: the database is the truth, not what the patient saw earlier.
      const { settings, type, slots } = await this.availability.getSlots({
        typeCode: request.typeCode,
        day,
        doctorId: request.doctorId,
        now,
      });

      const slot = slots.find((s) => s.start.getTime() === request.start.getTime());
      if (!slot) {
        // First look: the request itself breaks a rule. Later look: it was fine a moment
        // ago, so someone else just took it.
        if (attempt === 1) {
          throw new SchedulingError('INVALID_SLOT', this.explain(request, settings, type.steps, now));
        }
        throw slotTaken();
      }

      try {
        return await this.createAppointment(patientId, type.id, slot);
      } catch (error) {
        // Another booking committed first and the exclusion constraint refused ours.
        // Try again: a different technician or doctor may still be free at that time.
        if (isOverlapViolation(error)) {
          if (attempt < MAX_ATTEMPTS) continue;
          throw slotTaken();
        }
        throw error;
      }
    }
  }

  /** A patient cancels one of their own future appointments. */
  async cancel(patientId: string, appointmentId: string, now = new Date()) {
    // Someone else's appointment looks exactly like a missing one, so ids can't be probed.
    const notFound = new SchedulingError('NOT_FOUND', [{ code: 'NOT_FOUND', message: 'Appointment not found.' }]);
    if (!UUID.test(appointmentId)) throw notFound;

    return this.prisma.$transaction(async (tx) => {
      const appointment = await tx.appointment.findFirst({ where: { id: appointmentId, patientId } });
      if (!appointment) throw notFound;

      // Conditional update: if two cancels race, only one changes the row.
      const { count } = await tx.appointment.updateMany({
        where: { id: appointmentId, patientId, status: 'BOOKED', startsAt: { gt: now } },
        data: { status: 'CANCELLED', cancelledAt: now },
      });
      if (count === 0) {
        throw new SchedulingError('NOT_CANCELLABLE', [
          { code: 'NOT_CANCELLABLE', message: 'Only upcoming, booked appointments can be cancelled.' },
        ]);
      }

      // Kept for history, but no longer blocks anyone's calendar.
      await tx.resourceAllocation.updateMany({ where: { appointmentId }, data: { active: false } });
      return tx.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    });
  }

  /** One statement: the appointment and all its allocations are saved together or not at all. */
  private async createAppointment(patientId: string, appointmentTypeId: string, slot: Slot) {
    for (let tries = 0; ; tries++) {
      try {
        return await this.prisma.appointment.create({
          data: {
            reference: generateReference(),
            patientId,
            appointmentTypeId,
            startsAt: slot.start,
            endsAt: slot.end,
            allocations: {
              create: slot.assignments.map((a) => ({ resourceId: a.resourceId, startsAt: a.start, endsAt: a.end })),
            },
          },
          include: { allocations: true },
        });
      } catch (error) {
        // 31^6 ≈ 887 million codes, so a clash is very rare; just draw another.
        if (isUniqueViolation(error) && tries < 5) continue;
        throw error;
      }
    }
  }

  /** Every rule the requested start breaks, for the patient, the agent and (later) staff overrides. */
  private explain(
    request: BookingRequest,
    settings: { timezone: string; slotGridMin: number },
    steps: { offsetMin: number; durationMin: number }[],
    now: Date,
  ): Reason[] {
    const reasons: Reason[] = [];
    const start = DateTime.fromJSDate(request.start, { zone: settings.timezone });
    const visitLength = Math.max(...steps.map((s) => s.offsetMin + s.durationMin));

    if (start.minute % settings.slotGridMin !== 0 || start.second !== 0 || start.millisecond !== 0) {
      reasons.push({
        code: 'NOT_ON_GRID',
        message: `Appointments start every ${settings.slotGridMin} minutes.`,
      });
    }
    if (request.start < now) {
      reasons.push({ code: 'IN_THE_PAST', message: 'That time has already passed.' });
    }
    // Ending exactly at midnight is fine; ending later is not.
    if (start.plus({ minutes: visitLength }) > start.startOf('day').plus({ days: 1 })) {
      reasons.push({ code: 'CROSSES_MIDNIGHT', message: 'The visit would run past midnight.' });
    }
    if (reasons.length === 0) {
      reasons.push({
        code: 'NOT_AVAILABLE',
        message: 'Not every part of this visit has a free, qualified person or machine at that time.',
      });
    }
    return reasons;
  }
}

function slotTaken() {
  return new SchedulingError('SLOT_TAKEN', [
    { code: 'SLOT_TAKEN', message: 'Someone else booked that time a moment ago. Please choose another.' },
  ]);
}
