import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { PrismaClient, type OutcomeCode } from '../generated/prisma/client.js';
import { httpError } from '../http/http-error.js';
import type { StaffActor } from '../staff/staff.guard.js';

export interface OutcomeInput {
  code: OutcomeCode;
  patientNote: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The doctor decides: only the doctor who did the exam records its outcome, and only
 * they may correct it, within the clinic's edit window. Audit entries say that an
 * outcome was recorded or corrected, never what it says.
 */
@Injectable()
export class OutcomesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  async record(doctor: StaffActor, appointmentId: string, input: OutcomeInput, now: Date) {
    const appointment = await this.ownExam(doctor, appointmentId);
    if (appointment.status === 'CANCELLED') {
      throw httpError(HttpStatus.CONFLICT, 'NOT_RECORDABLE', 'This appointment was cancelled.');
    }
    if (appointment.outcome || appointment.status === 'COMPLETED') {
      throw httpError(HttpStatus.CONFLICT, 'ALREADY_RECORDED', 'An outcome is already recorded. Correct it instead.');
    }
    if (appointment.startsAt > now) {
      throw httpError(HttpStatus.CONFLICT, 'TOO_EARLY', "The appointment hasn't started yet.");
    }

    return this.prisma.$transaction(async (tx) => {
      // Conditional: if two saves race, only one moves the appointment to COMPLETED.
      const { count } = await tx.appointment.updateMany({
        where: { id: appointmentId, status: 'BOOKED' },
        data: { status: 'COMPLETED' },
      });
      if (count === 0) throw httpError(HttpStatus.CONFLICT, 'ALREADY_RECORDED', 'An outcome is already recorded.');

      const outcome = await tx.outcome.create({
        data: { appointmentId, ...input, recordedByStaffId: doctor.id, recordedAt: now },
      });
      await this.audit.record(
        { actor: doctor, action: 'OUTCOME_RECORDED', entityType: 'Appointment', entityId: appointmentId },
        tx,
      );
      return outcome;
    });
  }

  /** The outcome of this doctor's own exam, and until when they may still correct it. */
  async forCorrection(doctor: StaffActor, appointmentId: string) {
    await this.ownExam(doctor, appointmentId);
    const outcome = await this.prisma.outcome.findUnique({ where: { appointmentId } });
    if (!outcome) throw httpError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'No outcome has been recorded yet.');
    if (outcome.recordedByStaffId !== doctor.id) {
      throw httpError(HttpStatus.FORBIDDEN, 'NOT_YOUR_OUTCOME', 'Only the doctor who recorded it can correct it.');
    }
    // Measured from the first recording, so corrections can't keep the window open.
    const { outcomeEditWindowHours } = await this.prisma.clinicSetting.findUniqueOrThrow({ where: { id: 1 } });
    return { outcome, outcomeEditWindowHours, editableUntil: new Date(outcome.recordedAt.getTime() + outcomeEditWindowHours * 3_600_000) };
  }

  async correct(doctor: StaffActor, appointmentId: string, input: OutcomeInput, now: Date) {
    const { outcomeEditWindowHours, editableUntil } = await this.forCorrection(doctor, appointmentId);
    if (now > editableUntil) {
      throw httpError(
        HttpStatus.CONFLICT,
        'EDIT_WINDOW_CLOSED',
        `Outcomes can only be corrected within ${outcomeEditWindowHours} hours of being recorded.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.outcome.update({ where: { appointmentId }, data: { ...input, correctedAt: now } });
      await this.audit.record(
        { actor: doctor, action: 'OUTCOME_CORRECTED', entityType: 'Appointment', entityId: appointmentId },
        tx,
      );
      return updated;
    });
  }

  /** The patient's most recent outcome, by appointment date. */
  latestFor(patientId: string) {
    return this.prisma.outcome.findFirst({
      where: { appointment: { patientId } },
      orderBy: { appointment: { startsAt: 'desc' } },
      include: { appointment: { include: { appointmentType: true } }, recordedBy: true },
    });
  }

  /** The appointment, if this doctor did its exam. */
  private async ownExam(doctor: StaffActor, appointmentId: string) {
    const notFound = httpError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Appointment not found.');
    if (!UUID.test(appointmentId)) throw notFound;

    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { allocations: true, outcome: true },
    });
    if (!appointment) throw notFound;

    // Holds of a cancelled appointment are inactive, so look at the ones for its current time.
    const examinedByMe = appointment.allocations.some(
      (a) => a.resourceId === doctor.resourceId && a.startsAt >= appointment.startsAt && a.endsAt <= appointment.endsAt,
    );
    if (!examinedByMe) {
      throw httpError(HttpStatus.FORBIDDEN, 'NOT_YOUR_PATIENT', 'Only the doctor who did this exam can record its outcome.');
    }
    return appointment;
  }
}
