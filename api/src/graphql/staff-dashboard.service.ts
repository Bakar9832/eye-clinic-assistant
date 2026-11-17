import { HttpStatus, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { clinicSettings } from '../clinic-settings.js';
import { PrismaClient, type Prisma } from '../generated/prisma/client.js';
import { httpError } from '../http/http-error.js';
import { examinerOf } from '../mcp/clinic-tools.service.js';
import type { Appointment, Doctor, Patient } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The REST API's error shape; formatError turns it into a GraphQL error with this code.
// (An HttpException, unlike a bare GraphQLError, isn't logged as a server error.)
const badInput = (message: string) => httpError(HttpStatus.BAD_REQUEST, 'BAD_USER_INPUT', message);
export const notFound = (what: string) => httpError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} not found.`);

type AppointmentRow = Prisma.AppointmentGetPayload<{ include: { appointmentType: { select: { name: true } } } }>;

const toAppointment = (a: AppointmentRow): Appointment => ({
  id: a.id,
  reference: a.reference,
  start: a.startsAt,
  end: a.endsAt,
  status: a.status,
  typeName: a.appointmentType.name,
  patientId: a.patientId,
});

/**
 * The staff dashboard's reads. The writes (cancelling) stay in BookingService, so the
 * dashboard follows exactly the rules the REST API and the chat do.
 */
@Injectable()
export class StaffDashboardService {
  constructor(private readonly prisma: PrismaClient) {}

  async doctors(): Promise<Doctor[]> {
    const rows = await this.prisma.resource.findMany({ where: { kind: 'OPTOMETRIST', active: true }, orderBy: { displayName: 'asc' } });
    return rows.map((r) => ({ id: r.id, name: r.displayName }));
  }

  async doctor(id: string): Promise<Doctor> {
    const row = UUID.test(id) ? await this.prisma.resource.findFirst({ where: { id, kind: 'OPTOMETRIST' } }) : null;
    if (!row) throw notFound('Doctor');
    return { id: row.id, name: row.displayName };
  }

  /** Every appointment (any status) starting on a clinic-local day; only one doctor's if given. */
  async appointmentsOn(date: string, doctorId?: string): Promise<Appointment[]> {
    const { from, to } = await this.clinicDay(date);
    const onDay = { startsAt: { gte: from, lt: to } };
    const appointmentType = { select: { name: true } };
    if (!doctorId) {
      const rows = await this.prisma.appointment.findMany({ where: onDay, orderBy: { startsAt: 'asc' }, include: { appointmentType } });
      return rows.map(toAppointment);
    }

    const rows = await this.prisma.appointment.findMany({
      where: { ...onDay, allocations: { some: { resourceId: doctorId } } },
      orderBy: { startsAt: 'asc' },
      include: { appointmentType, allocations: { include: { resource: { select: { id: true, kind: true } } } } },
    });
    // Their current exams only, not a time they held before the appointment was moved.
    return rows.filter((a) => examinerOf(a)?.id === doctorId).map(toAppointment);
  }

  async appointment(id: string): Promise<Appointment> {
    const row = UUID.test(id) ? await this.prisma.appointment.findUnique({ where: { id }, include: { appointmentType: { select: { name: true } } } }) : null;
    if (!row) throw notFound('Appointment');
    return toAppointment(row);
  }

  /** Each appointment's doctor, by appointment id (null for visits without an exam, e.g. a scan). */
  async doctorsOf(appointmentIds: readonly string[]): Promise<Map<string, Doctor | null>> {
    const rows = await this.prisma.appointment.findMany({
      where: { id: { in: [...appointmentIds] } },
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        allocations: { select: { startsAt: true, endsAt: true, resource: { select: { id: true, kind: true, displayName: true } } } },
      },
    });
    return new Map(
      rows.map((a) => {
        const doctor = examinerOf(a);
        return [a.id, doctor ? { id: doctor.id, name: doctor.displayName } : null];
      }),
    );
  }

  async patients(ids: readonly string[]): Promise<Map<string, Patient>> {
    const rows = await this.prisma.patient.findMany({
      where: { id: { in: [...ids] } },
      // Selected field by field, so a date of birth can't be read here by accident.
      select: { id: true, fullName: true, email: true },
    });
    return new Map(rows.map((p) => [p.id, p]));
  }

  /** "2030-01-07" → that day's start and end in the clinic's own time zone, as UTC moments. */
  private async clinicDay(date: string) {
    const { timezone } = await clinicSettings(this.prisma);
    const day = DateTime.fromISO(date, { zone: timezone });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !day.isValid) throw badInput('date must look like 2030-01-07.');
    return { from: day.toJSDate(), to: day.plus({ days: 1 }).toJSDate() };
  }
}
