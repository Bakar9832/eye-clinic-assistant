import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { PrismaClient } from '../generated/prisma/client.js';
import { SchedulingError } from '../scheduling-error.js';
import { computeSlots } from './compute-slots.js';
import type { Slot, SlotResource } from './types.js';

export interface SlotQuery {
  typeCode: string;
  /** Clinic-local date, "2026-10-26". */
  day: string;
  doctorId?: string;
  now?: Date;
  /** When moving an appointment, its own current holds must not block its new time. */
  ignoreAppointmentId?: string;
}

/** Loads one day of the clinic from the database and hands it to computeSlots. */
@Injectable()
export class AvailabilityService {
  constructor(private readonly prisma: PrismaClient) {}

  async getSlots({ typeCode, day, doctorId, now = new Date(), ignoreAppointmentId }: SlotQuery) {
    const settings = await this.prisma.clinicSetting.findUniqueOrThrow({ where: { id: 1 } });

    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !DateTime.fromISO(day, { zone: settings.timezone }).isValid) {
      throw new SchedulingError('INVALID_DAY', [{ code: 'INVALID_DAY', message: 'Use a date like 2026-10-26.' }]);
    }

    const type = await this.prisma.appointmentType.findFirst({
      where: { code: typeCode, active: true },
      include: { steps: { orderBy: { position: 'asc' } } },
    });
    if (!type) {
      throw new SchedulingError('UNKNOWN_TYPE', [
        { code: 'UNKNOWN_TYPE', message: `There is no appointment type "${typeCode}".` },
      ]);
    }

    // The whole local day, as a UTC range, for loading leave and existing bookings.
    const dayStart = DateTime.fromISO(day, { zone: settings.timezone });
    const range = { lt: dayStart.plus({ days: 1 }).toJSDate(), gt: dayStart.toJSDate() };

    const rows = await this.prisma.resource.findMany({
      where: { active: true },
      include: {
        workingHours: true,
        timeOff: { where: { startsAt: { lt: range.lt }, endsAt: { gt: range.gt } } },
        allocations: {
          where: {
            active: true,
            startsAt: { lt: range.lt },
            endsAt: { gt: range.gt },
            ...(ignoreAppointmentId ? { NOT: { appointmentId: ignoreAppointmentId } } : {}),
          },
        },
      },
    });

    if (doctorId !== undefined && !rows.some((r) => r.id === doctorId && r.kind === 'OPTOMETRIST')) {
      throw new SchedulingError('UNKNOWN_DOCTOR', [{ code: 'UNKNOWN_DOCTOR', message: 'There is no such doctor.' }]);
    }

    const resources: SlotResource[] = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      skills: r.skills ?? [],
      workingHours: r.workingHours,
      timeOff: r.timeOff.map((t) => ({ start: t.startsAt, end: t.endsAt })),
      busy: r.allocations.map((a) => ({ start: a.startsAt, end: a.endsAt })),
      // A routine-with-scan visit gives Sara two allocations; it's still one appointment.
      appointmentsToday: new Set(r.allocations.map((a) => a.appointmentId)).size,
    }));

    const slots: Slot[] = computeSlots({
      steps: type.steps,
      resources,
      day,
      timezone: settings.timezone,
      gridMin: settings.slotGridMin,
      doctorId,
      now,
    });

    const names = new Map(rows.map((r) => [r.id, { displayName: r.displayName, kind: r.kind }]));
    return { settings, type, slots, names };
  }
}
