import { HttpStatus, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { AuditService, changedFields } from '../audit/audit.service.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { httpError } from '../http/http-error.js';
import type { StaffActor } from '../staff/staff.guard.js';

export interface SettingsChange {
  name?: string;
  timezone?: string;
  slotGridMin?: number;
  offerRecheckAfterNewPrescription?: boolean;
  outcomeEditWindowHours?: number;
}

export interface TypeChange {
  typicalMin?: number;
  prepInstructions?: string;
  active?: boolean;
  /** New lengths for some steps, by position. Later steps move to make room. */
  stepDurations?: { position: number; durationMin: number }[];
}

export interface Window {
  weekday: number;
  startMin: number;
  endMin: number;
}

/** A future booking that no longer fits someone's working hours. Bookings never move by themselves. */
export interface AffectedBooking {
  reference: string;
  start: string;
  patient: string | null;
  resource: string;
}

const MAX_VISIT_MIN = 180;

/**
 * Admin changes to how the clinic runs. None of them moves an existing booking: they
 * report the bookings affected, so reception can contact those patients.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  async updateSettings(admin: StaffActor, change: SettingsChange, now: Date) {
    const settings = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.clinicSetting.update({ where: { id: 1 }, data: change });
      await this.audit.record(
        { actor: admin, action: 'SETTINGS_UPDATED', entityType: 'ClinicSetting', details: { fields: changedFields(change) } },
        tx,
      );
      return updated;
    });
    // A new clinic time zone moves every working window to a different real moment.
    return { settings, bookingsOutsideHours: await this.bookingsOutsideHours(now) };
  }

  async updateType(admin: StaffActor, code: string, change: TypeChange) {
    const type = await this.prisma.appointmentType.findUnique({
      where: { code },
      include: { steps: { orderBy: { position: 'asc' } } },
    });
    if (!type) throw httpError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `There is no appointment type "${code}".`);

    const steps = change.stepDurations ? relayout(type.steps, change.stepDurations) : type.steps;
    const calendarMin = Math.max(...steps.map((s) => s.offsetMin + s.durationMin));
    if (calendarMin > MAX_VISIT_MIN) {
      throw httpError(HttpStatus.BAD_REQUEST, 'INVALID_INPUT', `A visit can't be longer than ${MAX_VISIT_MIN} minutes.`);
    }
    const typicalMin = change.typicalMin ?? type.typicalMin;
    if (typicalMin > calendarMin) {
      throw httpError(
        HttpStatus.BAD_REQUEST,
        'INVALID_INPUT',
        `The time told to patients (${typicalMin} min) can't be longer than the calendar time (${calendarMin} min).`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      for (const step of steps) {
        await tx.appointmentTypeStep.update({
          where: { id: step.id },
          data: { offsetMin: step.offsetMin, durationMin: step.durationMin },
        });
      }
      const updated = await tx.appointmentType.update({
        where: { id: type.id },
        data: { typicalMin: change.typicalMin, prepInstructions: change.prepInstructions, active: change.active },
        include: { steps: { orderBy: { position: 'asc' } } },
      });
      await this.audit.record(
        {
          actor: admin,
          action: 'APPOINTMENT_TYPE_UPDATED',
          entityType: 'AppointmentType',
          entityId: type.id,
          details: { fields: changedFields(change) },
        },
        tx,
      );
      return updated;
    });
  }

  async replaceWorkingHours(admin: StaffActor, resourceId: string, windows: Window[], now: Date) {
    await this.findResource(resourceId);
    for (const day of new Set(windows.map((w) => w.weekday))) {
      const sorted = windows.filter((w) => w.weekday === day).sort((a, b) => a.startMin - b.startMin);
      if (sorted.some((w, i) => i > 0 && w.startMin < sorted[i - 1].endMin)) {
        throw httpError(HttpStatus.BAD_REQUEST, 'INVALID_INPUT', `Windows on weekday ${day} overlap.`);
      }
    }

    const workingHours = await this.prisma.$transaction(async (tx) => {
      await tx.workingHours.deleteMany({ where: { resourceId } });
      await tx.workingHours.createMany({ data: windows.map((w) => ({ resourceId, ...w })) });
      await this.audit.record(
        {
          actor: admin,
          action: 'WORKING_HOURS_REPLACED',
          entityType: 'Resource',
          entityId: resourceId,
          details: { windows: windows.length },
        },
        tx,
      );
      return tx.workingHours.findMany({ where: { resourceId }, orderBy: [{ weekday: 'asc' }, { startMin: 'asc' }] });
    });
    return { workingHours, bookingsOutsideHours: await this.bookingsOutsideHours(now) };
  }

  /** Refused while any booking needs this resource in that time: move those patients first. */
  async addTimeOff(admin: StaffActor, resourceId: string, startsAt: Date, endsAt: Date, reason?: string) {
    await this.findResource(resourceId);
    if (endsAt <= startsAt) throw httpError(HttpStatus.BAD_REQUEST, 'INVALID_INPUT', 'Leave must end after it starts.');

    const inTheWay = await this.prisma.resourceAllocation.findMany({
      where: { resourceId, active: true, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
      include: { appointment: { include: { patient: { select: { fullName: true } } } }, resource: true },
      orderBy: { startsAt: 'asc' },
    });
    if (inTheWay.length > 0) {
      throw httpError(HttpStatus.CONFLICT, 'BOOKINGS_IN_THE_WAY', 'Move these appointments first.', {
        bookings: unique(inTheWay.map((a) => toAffected(a.appointment, a.resource.displayName))),
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const timeOff = await tx.timeOff.create({ data: { resourceId, startsAt, endsAt, reason } });
      await this.audit.record(
        { actor: admin, action: 'TIME_OFF_ADDED', entityType: 'Resource', entityId: resourceId },
        tx,
      );
      return timeOff;
    });
  }

  async setStaffActive(admin: StaffActor, staffUserId: string, active: boolean) {
    if (!active && staffUserId === admin.id) {
      throw httpError(HttpStatus.CONFLICT, 'CANNOT_DEACTIVATE_SELF', "You can't switch off your own account.");
    }
    const user = await this.prisma.staffUser.findUnique({ where: { id: staffUserId } });
    if (!user) throw httpError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Staff member not found.');

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.staffUser.update({ where: { id: staffUserId }, data: { active } });
      await this.audit.record(
        {
          actor: admin,
          action: 'STAFF_USER_UPDATED',
          entityType: 'StaffUser',
          entityId: staffUserId,
          details: { fields: ['active'], active },
        },
        tx,
      );
      return updated;
    });
  }

  /** Every future booking with a step outside its resource's working hours, in clinic time. */
  async bookingsOutsideHours(now: Date): Promise<AffectedBooking[]> {
    const { timezone } = await this.prisma.clinicSetting.findUniqueOrThrow({ where: { id: 1 } });
    const allocations = await this.prisma.resourceAllocation.findMany({
      where: { active: true, startsAt: { gt: now }, appointment: { status: 'BOOKED' } },
      include: {
        resource: { include: { workingHours: true } },
        appointment: { include: { patient: { select: { fullName: true } } } },
      },
      orderBy: { startsAt: 'asc' },
    });

    const outside = allocations.filter((a) => {
      const from = DateTime.fromJSDate(a.startsAt, { zone: timezone });
      const to = DateTime.fromJSDate(a.endsAt, { zone: timezone });
      const fromMin = from.hour * 60 + from.minute;
      const toMin = fromMin + to.diff(from, 'minutes').minutes;
      return !a.resource.workingHours.some((w) => w.weekday === from.weekday && w.startMin <= fromMin && toMin <= w.endMin);
    });
    return unique(outside.map((a) => toAffected(a.appointment, a.resource.displayName)));
  }

  private async findResource(id: string) {
    const resource = await this.prisma.resource.findUnique({ where: { id } });
    if (!resource) throw httpError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Resource not found.');
    return resource;
  }
}

/**
 * Applies new step lengths and moves later steps so the visit stays back to back.
 * Steps that started together (scanner + technician) stay together; a group takes as
 * long as its longest step.
 */
function relayout<T extends { id: string; position: number; offsetMin: number; durationMin: number }>(
  steps: T[],
  changes: { position: number; durationMin: number }[],
): T[] {
  const byPosition = new Map(changes.map((c) => [c.position, c.durationMin]));
  for (const position of byPosition.keys()) {
    if (!steps.some((s) => s.position === position)) {
      throw httpError(HttpStatus.BAD_REQUEST, 'INVALID_INPUT', `This type has no step ${position}.`);
    }
  }

  const updated = steps.map((s) => ({ ...s, durationMin: byPosition.get(s.position) ?? s.durationMin }));
  const groupOffsets = [...new Set(steps.map((s) => s.offsetMin))].sort((a, b) => a - b);

  let offset = 0;
  for (const original of groupOffsets) {
    const group = updated.filter((s) => steps.find((o) => o.id === s.id)!.offsetMin === original);
    for (const step of group) step.offsetMin = offset;
    offset += Math.max(...group.map((s) => s.durationMin));
  }
  return updated;
}

function toAffected(
  appointment: { reference: string; startsAt: Date; patient: { fullName: string | null } },
  resource: string,
): AffectedBooking {
  return {
    reference: appointment.reference,
    start: appointment.startsAt.toISOString(),
    patient: appointment.patient.fullName,
    resource,
  };
}

/** One entry per booking and resource (a visit can use the same resource twice). */
function unique(list: AffectedBooking[]) {
  const seen = new Set<string>();
  return list.filter((b) => {
    const key = `${b.reference}|${b.resource}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
