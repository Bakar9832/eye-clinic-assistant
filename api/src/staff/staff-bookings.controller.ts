import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsOptional, IsString, IsUUID, Length, ValidateNested } from 'class-validator';
import { BookDto } from '../booking/booking.dto.js';
import { BookingService } from '../booking/booking.service.js';
import { Clock } from '../clock.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { httpError } from '../http/http-error.js';
import { CurrentStaff, Roles, StaffGuard, type StaffActor } from './staff.guard.js';

class OverrideDto {
  /** Why the soft rules are being bent. Kept in the audit log. */
  @IsString()
  @Length(10, 300, { message: 'override reason must be 10-300 characters' })
  reason!: string;
}

class StaffBookDto extends BookDto {
  /**
   * Staff say who they're booking for. Patients can never send this field; staff can,
   * because their role allows it, and every such booking is audited with their id.
   */
  @IsUUID()
  patientId!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => OverrideDto)
  override?: OverrideDto;
}

/** Reception and admins booking on a patient's behalf (phone calls, the front desk). */
@Controller('staff')
@UseGuards(StaffGuard)
@Roles(['RECEPTION', 'ADMIN'])
export class StaffBookingsController {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly booking: BookingService,
    private readonly clock: Clock,
  ) {}

  /** Find a patient by name or email. Enough to identify them; no date of birth. */
  @Get('patients')
  async findPatients(@Query('query') query?: string) {
    const q = query?.trim() ?? '';
    if (q.length < 2) throw httpError(HttpStatus.BAD_REQUEST, 'INVALID_INPUT', 'Search for at least 2 characters.');
    const patients = await this.prisma.patient.findMany({
      where: {
        OR: [{ fullName: { contains: q, mode: 'insensitive' } }, { email: { contains: q.toLowerCase() } }],
      },
      select: { id: true, fullName: true, email: true },
      orderBy: { fullName: 'asc' },
      take: 20,
    });
    return patients;
  }

  @Post('appointments')
  @HttpCode(HttpStatus.CREATED)
  async book(@CurrentStaff() staff: StaffActor, @Body() body: StaffBookDto) {
    const appointment = await this.booking.bookByStaff(
      body.patientId,
      { typeCode: body.typeCode, start: new Date(body.start), doctorId: body.doctorId, override: body.override },
      this.clock.now(),
      staff,
    );
    return {
      id: appointment.id,
      reference: appointment.reference,
      start: appointment.startsAt.toISOString(),
      end: appointment.endsAt.toISOString(),
      status: appointment.status,
    };
  }
}
