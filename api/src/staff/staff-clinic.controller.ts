import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsString, Length } from 'class-validator';
import { DateTime } from 'luxon';
import { Clock } from '../clock.js';
import { OutcomeCode, PrismaClient } from '../generated/prisma/client.js';
import { httpError } from '../http/http-error.js';
import { OutcomesService } from '../outcomes/outcomes.service.js';
import { CurrentStaff, Roles, StaffGuard, type StaffActor } from './staff.guard.js';

class OutcomeDto {
  @IsIn(Object.values(OutcomeCode), { message: `code must be one of ${Object.values(OutcomeCode).join(', ')}` })
  code!: OutcomeCode;

  /** Passed to the patient word for word, so it is stored exactly as typed. */
  @IsString()
  @Length(1, 500)
  patientNote!: string;
}

/** The clinic's working day, for staff. */
@Controller('staff')
@UseGuards(StaffGuard)
export class StaffClinicController {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly outcomes: OutcomesService,
    private readonly clock: Clock,
  ) {}

  /** Every appointment on a clinic-local day. Patient names only: no emails, no dates of birth. */
  @Get('schedule')
  async schedule(@CurrentStaff() staff: StaffActor, @Query('day') day?: string) {
    const { timezone } = await this.prisma.clinicSetting.findUniqueOrThrow({ where: { id: 1 } });
    const start = DateTime.fromISO(day ?? '', { zone: timezone });
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !start.isValid) {
      throw httpError(HttpStatus.BAD_REQUEST, 'INVALID_DAY', 'Use a date like 2030-01-07.');
    }

    const appointments = await this.prisma.appointment.findMany({
      where: { startsAt: { gte: start.toJSDate(), lt: start.plus({ days: 1 }).toJSDate() } },
      orderBy: { startsAt: 'asc' },
      include: {
        patient: { select: { fullName: true } },
        appointmentType: { select: { code: true, name: true } },
        allocations: { include: { resource: { select: { id: true, kind: true, displayName: true } } } },
        outcome: { select: { id: true } },
      },
    });

    return {
      day,
      timezone,
      appointments: appointments.map((a) => ({
        id: a.id,
        reference: a.reference,
        start: a.startsAt.toISOString(),
        end: a.endsAt.toISOString(),
        status: a.status,
        type: a.appointmentType,
        patient: { fullName: a.patient.fullName },
        doctor: examOf(a)?.displayName ?? null,
        // For a doctor: is this one of their own exams (the only ones they may record)?
        examinedByMe: staff.resourceId !== null && examOf(a)?.id === staff.resourceId,
        hasOutcome: a.outcome !== null,
      })),
    };
  }

  /** What the agent passed to a person, newest first. Open ones by default. */
  @Get('handoffs')
  async handoffs(@Query('status') status?: string) {
    const requests = await this.prisma.handoffRequest.findMany({
      where: { status: status === 'CLOSED' ? 'CLOSED' : 'OPEN' },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { patient: { select: { fullName: true, email: true } } },
    });
    return requests.map((h) => ({
      id: h.id,
      reason: h.reason,
      status: h.status,
      createdAt: h.createdAt.toISOString(),
      conversationId: h.conversationId,
      // Anonymous visitors have no account; staff answer them via the conversation.
      patient: h.patient ? { fullName: h.patient.fullName, email: h.patient.email } : null,
    }));
  }

  @Post('handoffs/:id/close')
  @HttpCode(HttpStatus.OK)
  async closeHandoff(@Param('id') id: string) {
    const { count } = /^[0-9a-f-]{36}$/i.test(id)
      ? await this.prisma.handoffRequest.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'CLOSED' } })
      : { count: 0 };
    if (count === 0) throw httpError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'No open handoff with that id.');
    return { id, status: 'CLOSED' };
  }

  /** A doctor reads the outcome of their own exam, to correct it. */
  @Get('appointments/:id/outcome')
  @Roles(['DOCTOR'])
  async read(@CurrentStaff() doctor: StaffActor, @Param('id') id: string) {
    const { outcome, editableUntil } = await this.outcomes.forCorrection(doctor, id);
    return {
      ...toView(outcome),
      editableUntil: editableUntil.toISOString(),
      editable: this.clock.now() <= editableUntil,
    };
  }

  @Post('appointments/:id/outcome')
  @Roles(['DOCTOR'])
  @HttpCode(HttpStatus.CREATED)
  async record(@CurrentStaff() doctor: StaffActor, @Param('id') id: string, @Body() body: OutcomeDto) {
    return toView(await this.outcomes.record(doctor, id, body, this.clock.now()));
  }

  @Put('appointments/:id/outcome')
  @Roles(['DOCTOR'])
  async correct(@CurrentStaff() doctor: StaffActor, @Param('id') id: string, @Body() body: OutcomeDto) {
    return toView(await this.outcomes.correct(doctor, id, body, this.clock.now()));
  }
}

function toView(o: { code: OutcomeCode; patientNote: string; recordedAt: Date; correctedAt: Date | null }) {
  return {
    code: o.code,
    patientNote: o.patientNote,
    recordedAt: o.recordedAt.toISOString(),
    correctedAt: o.correctedAt?.toISOString() ?? null,
  };
}

/** The doctor for the appointment's current time (older holds remain from reschedules). */
function examOf(a: {
  startsAt: Date;
  endsAt: Date;
  allocations: { startsAt: Date; endsAt: Date; resource: { id: string; kind: string; displayName: string } }[];
}) {
  return a.allocations.find((x) => x.resource.kind === 'OPTOMETRIST' && x.startsAt >= a.startsAt && x.endsAt <= a.endsAt)
    ?.resource;
}
