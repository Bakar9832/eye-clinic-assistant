import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { PrismaClient } from '../generated/prisma/client.js';
import { SchedulingError, type Reason } from '../scheduling-error.js';
import { computeSlots, slotIgnoringHours } from './compute-slots.js';
import type { ComputeSlotsInput, Slot, SlotResource } from './types.js';

export interface SlotQuery {
  typeCode: string;
  /** Clinic-local date, "2026-10-26". */
  day: string;
  doctorId?: string;
  now?: Date;
  /** When moving an appointment, its own current holds must not block its new time. */
  ignoreAppointmentId?: string;
}

/** Loads one day of the clinic from the database and hands it to the slot calculation. */
@Injectable()
export class AvailabilityService {
  constructor(private readonly prisma: PrismaClient) {}

  async getSlots(query: SlotQuery) {
    const { settings, type, input, names } = await this.loadDay(query);
    const slots: Slot[] = computeSlots(input);
    return { settings, type, slots, names };
  }

  /**
   * For a staff override: the slot at exactly `start` with working hours and the grid
   * ignored, plus the soft rules it breaks, in words. slot is null when a hard rule
   * (leave, another booking, skills, midnight) still stands in the way.
   */
  async overrideAt(query: SlotQuery, start: Date) {
    const { settings, type, input, names, resources } = await this.loadDay(query);
    const local = DateTime.fromJSDate(start, { zone: settings.timezone });
    const warnings: Reason[] = [];
    // Even an override books whole minutes.
    const slot =
      local.second === 0 && local.millisecond === 0 ? slotIgnoringHours(input, local.hour * 60 + local.minute) : null;
    if (!slot) return { settings, type, slot, warnings };

    if (local.minute % settings.slotGridMin !== 0) {
      warnings.push({ code: 'NOT_ON_GRID', message: `Starts off the ${settings.slotGridMin}-minute grid.` });
    }
    for (const a of slot.assignments) {
      const resource = resources.find((r) => r.id === a.resourceId)!;
      const from = DateTime.fromJSDate(a.start, { zone: settings.timezone });
      const to = DateTime.fromJSDate(a.end, { zone: settings.timezone });
      const fromMin = from.hour * 60 + from.minute;
      const toMin = fromMin + to.diff(from, 'minutes').minutes;
      const inHours = resource.workingHours.some(
        (w) => w.weekday === local.weekday && w.startMin <= fromMin && toMin <= w.endMin,
      );
      if (!inHours) {
        warnings.push({
          code: 'OUTSIDE_WORKING_HOURS',
          message: `${names.get(a.resourceId)!.displayName}: ${from.toFormat('HH:mm')}-${to.toFormat('HH:mm')} is outside their working hours.`,
        });
      }
    }
    return { settings, type, slot, warnings };
  }

  private async loadDay({ typeCode, day, doctorId, now = new Date(), ignoreAppointmentId }: SlotQuery) {
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

    const input: ComputeSlotsInput = {
      steps: type.steps,
      resources,
      day,
      timezone: settings.timezone,
      gridMin: settings.slotGridMin,
      doctorId,
      now,
    };
    const names = new Map(rows.map((r) => [r.id, { displayName: r.displayName, kind: r.kind }]));
    return { settings, type, input, names, resources };
  }
}
