import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { AuditService, SYSTEM, type Actor } from '../audit/audit.service.js';
import { AvailabilityService, type SlotQuery } from '../availability/availability.service.js';
import type { Slot } from '../availability/types.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { isOverlapViolation, isUniqueViolation } from '../prisma/db-errors.js';
import { SchedulingError, type Reason } from '../scheduling-error.js';
import { generateReference } from './reference.js';

export interface BookingRequest {
  typeCode: string;
  /** The start time the patient chose. The end is never taken from the caller. */
  start: Date;
  doctorId?: string;
}

export interface RescheduleRequest {
  start: Date;
  /** Omitted = keep the same doctor. */
  doctorId?: string;
}

/** How many times to retry when another booking grabbed a resource at the same moment. */
const MAX_ATTEMPTS = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Books, moves and cancels appointments.
 *
 * patientId always comes from the server side (the session), never from a request
 * body. Every change and its audit entry are written in one transaction.
 */
@Injectable()
export class BookingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly availability: AvailabilityService,
    private readonly audit: AuditService,
  ) {}

  async book(patientId: string, request: BookingRequest, now = new Date(), actor: Actor = SYSTEM) {
    const patient = await this.prisma.patient.findUniqueOrThrow({ where: { id: patientId } });
    if (patient.fullName === null || patient.dateOfBirth === null) {
      throw new SchedulingError('PROFILE_INCOMPLETE', [
        { code: 'PROFILE_INCOMPLETE', message: 'Please add your name and date of birth before booking.' },
      ]);
    }

    const query = { typeCode: request.typeCode, day: await this.clinicDay(request.start), doctorId: request.doctorId, now };
    return this.placeOnSlot(query, request.start, now, (slot, typeId) => this.createAppointment(patientId, typeId, slot, actor));
  }

  /**
   * Moves a patient's own upcoming appointment. The reference stays the same, so their
   * ticket stays valid. Old and new are swapped in one transaction: if the new time is
   * taken, nothing changes.
   */
  async reschedule(
    patientId: string,
    appointmentId: string,
    request: RescheduleRequest,
    now = new Date(),
    actor: Actor = SYSTEM,
  ) {
    if (!UUID.test(appointmentId)) throw notFound();
    const appointment = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, patientId },
      include: { appointmentType: true, allocations: { where: { active: true }, include: { resource: true } } },
    });
    if (!appointment) throw notFound();
    if (appointment.status !== 'BOOKED' || appointment.startsAt <= now) throw notChangeable();

    const doctorId =
      request.doctorId ?? appointment.allocations.find((a) => a.resource.kind === 'OPTOMETRIST')?.resourceId;
    const query: SlotQuery = {
      typeCode: appointment.appointmentType.code,
      day: await this.clinicDay(request.start),
      doctorId,
      now,
      ignoreAppointmentId: appointmentId,
    };

    return this.placeOnSlot(query, request.start, now, (slot) =>
      this.prisma.$transaction(async (tx) => {
        // Checked again inside the transaction: it may have been cancelled meanwhile.
        const { count } = await tx.appointment.updateMany({
          where: { id: appointmentId, patientId, status: 'BOOKED', startsAt: { gt: now } },
          data: { startsAt: slot.start, endsAt: slot.end },
        });
        if (count === 0) throw notChangeable();

        // Release the old holds first, so the new ones can overlap them (10:00 → 10:15).
        await tx.resourceAllocation.updateMany({ where: { appointmentId, active: true }, data: { active: false } });
        await tx.resourceAllocation.createMany({
          data: slot.assignments.map((a) => ({ appointmentId, resourceId: a.resourceId, startsAt: a.start, endsAt: a.end })),
        });
        await this.audit.record(
          {
            actor,
            action: 'APPOINTMENT_RESCHEDULED',
            entityType: 'Appointment',
            entityId: appointmentId,
            details: { from: appointment.startsAt.toISOString(), to: slot.start.toISOString() },
          },
          tx,
        );
        return tx.appointment.findUniqueOrThrow({
          where: { id: appointmentId },
          include: { allocations: { where: { active: true } } },
        });
      }),
    );
  }

  /** A patient cancels one of their own future appointments. */
  async cancel(patientId: string, appointmentId: string, now = new Date(), actor: Actor = SYSTEM) {
    if (!UUID.test(appointmentId)) throw notFound();

    return this.prisma.$transaction(async (tx) => {
      const appointment = await tx.appointment.findFirst({ where: { id: appointmentId, patientId } });
      if (!appointment) throw notFound();

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
      await this.audit.record(
        { actor, action: 'APPOINTMENT_CANCELLED', entityType: 'Appointment', entityId: appointmentId },
        tx,
      );
      return tx.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    });
  }

  /**
   * Finds the requested start among the real slots and saves it. If another booking
   * takes a resource at the same moment, the database refuses ours (exclusion
   * constraint) and we look again: a different technician or doctor may still be free.
   */
  private async placeOnSlot<T>(
    query: SlotQuery,
    start: Date,
    now: Date,
    save: (slot: Slot, typeId: string) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      // Recalculate every attempt: the database is the truth, not what the patient saw earlier.
      const { settings, type, slots } = await this.availability.getSlots(query);

      const slot = slots.find((s) => s.start.getTime() === start.getTime());
      if (!slot) {
        // First look: the request itself breaks a rule. Later look: it was fine a moment
        // ago, so someone else just took it.
        if (attempt === 1) throw new SchedulingError('INVALID_SLOT', this.explain(start, settings, type.steps, now));
        throw slotTaken();
      }

      try {
        return await save(slot, type.id);
      } catch (error) {
        if (isOverlapViolation(error)) {
          if (attempt < MAX_ATTEMPTS) continue;
          throw slotTaken();
        }
        throw error;
      }
    }
  }

  /** The clinic-local day a start time falls on. */
  private async clinicDay(start: Date) {
    const { timezone } = await this.prisma.clinicSetting.findUniqueOrThrow({ where: { id: 1 } });
    return DateTime.fromJSDate(start, { zone: timezone }).toISODate()!;
  }

  /** The appointment, all its allocations and the audit entry: saved together or not at all. */
  private async createAppointment(patientId: string, appointmentTypeId: string, slot: Slot, actor: Actor) {
    for (let tries = 0; ; tries++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const appointment = await tx.appointment.create({
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
          await this.audit.record(
            { actor, action: 'APPOINTMENT_BOOKED', entityType: 'Appointment', entityId: appointment.id },
            tx,
          );
          return appointment;
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
    requestedStart: Date,
    settings: { timezone: string; slotGridMin: number },
    steps: { offsetMin: number; durationMin: number }[],
    now: Date,
  ): Reason[] {
    const reasons: Reason[] = [];
    const start = DateTime.fromJSDate(requestedStart, { zone: settings.timezone });
    const visitLength = Math.max(...steps.map((s) => s.offsetMin + s.durationMin));

    if (start.minute % settings.slotGridMin !== 0 || start.second !== 0 || start.millisecond !== 0) {
      reasons.push({
        code: 'NOT_ON_GRID',
        message: `Appointments start every ${settings.slotGridMin} minutes.`,
      });
    }
    if (requestedStart < now) {
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

/** Someone else's appointment looks exactly like a missing one, so ids can't be probed. */
function notFound() {
  return new SchedulingError('NOT_FOUND', [{ code: 'NOT_FOUND', message: 'Appointment not found.' }]);
}

function notChangeable() {
  return new SchedulingError('NOT_CHANGEABLE', [
    { code: 'NOT_CHANGEABLE', message: 'Only upcoming, booked appointments can be moved.' },
  ]);
}

function slotTaken() {
  return new SchedulingError('SLOT_TAKEN', [
    { code: 'SLOT_TAKEN', message: 'Someone else booked that time a moment ago. Please choose another.' },
  ]);
}
