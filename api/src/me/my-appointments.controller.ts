import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentPatient, SessionGuard, type PatientActor } from '../auth/session.guard.js';
import { BookDto, SlotDto } from '../booking/booking.dto.js';
import { BookingService } from '../booking/booking.service.js';
import { Clock } from '../clock.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { doctorOf } from '../mcp/clinic-tools.service.js';

/**
 * The logged-in patient's appointments. No route takes a patient id: it always comes
 * from the session, and every query is filtered by it.
 */
@Controller('me/appointments')
@UseGuards(SessionGuard)
export class MyAppointmentsController {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly booking: BookingService,
    private readonly clock: Clock,
  ) {}

  @Get()
  async list(@CurrentPatient() me: PatientActor) {
    const appointments = await this.prisma.appointment.findMany({
      where: { patientId: me.id },
      orderBy: { startsAt: 'asc' },
      select: { id: true },
    });
    return Promise.all(appointments.map((a) => this.ticket(a.id)));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async book(@CurrentPatient() me: PatientActor, @Body() body: BookDto) {
    const appointment = await this.booking.book(
      me.id,
      { typeCode: body.typeCode, start: new Date(body.start), doctorId: body.doctorId },
      this.clock.now(),
      me,
    );
    return this.ticket(appointment.id);
  }

  @Post(':id/reschedule')
  @HttpCode(HttpStatus.OK)
  async reschedule(@CurrentPatient() me: PatientActor, @Param('id') id: string, @Body() body: SlotDto) {
    const appointment = await this.booking.reschedule(
      me.id,
      id,
      { start: new Date(body.start), doctorId: body.doctorId },
      this.clock.now(),
      me,
    );
    return this.ticket(appointment.id);
  }

  @Delete(':id')
  async cancel(@CurrentPatient() me: PatientActor, @Param('id') id: string) {
    const appointment = await this.booking.cancel(me.id, id, this.clock.now(), me);
    return this.ticket(appointment.id);
  }

  /** What the patient sees: their booking ticket. No staff ids, no other patients. */
  private async ticket(appointmentId: string) {
    const a = await this.prisma.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
      include: { appointmentType: true, allocations: { include: { resource: true } } },
    });
    const doctor = doctorOf(a);
    return {
      id: a.id,
      reference: a.reference,
      status: a.status,
      start: a.startsAt.toISOString(),
      end: a.endsAt.toISOString(),
      type: { code: a.appointmentType.code, name: a.appointmentType.name, typicalMin: a.appointmentType.typicalMin },
      doctor: doctor ? { displayName: doctor } : null,
      prepInstructions: a.appointmentType.prepInstructions,
    };
  }
}
