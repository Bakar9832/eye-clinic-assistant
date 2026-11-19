import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsString, Length } from 'class-validator';
import { DateTime } from 'luxon';
import { clinicSettings } from '../clinic-settings.js';
import { Clock } from '../clock.js';
import { GuardrailKind, OutcomeCode, PrismaClient } from '../generated/prisma/client.js';
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
    const { timezone } = await clinicSettings(this.prisma);
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
        // Booked in a chat that mentioned urgent symptoms: staff should contact the patient.
        attentionReason: a.attentionReason,
      })),
    };
  }

  /** What needs a person: urgent alerts first, then callbacks and handoffs, newest first. Open ones by default. */
  @Get('handoffs')
  async handoffs(@Query('status') status?: string) {
    const requests = await this.prisma.handoffRequest.findMany({
      where: { status: status === 'CLOSED' ? 'CLOSED' : 'OPEN' },
      // The enum's order is HANDOFF, CALLBACK, URGENT: descending puts URGENT first.
      orderBy: [{ kind: 'desc' }, { createdAt: 'desc' }],
      take: 100,
      include: { patient: { select: { fullName: true, email: true } } },
    });
    return requests.map((h) => ({
      id: h.id,
      reason: h.reason,
      kind: h.kind,
      preferredTime: h.preferredTime,
      status: h.status,
      createdAt: h.createdAt.toISOString(),
      conversationId: h.conversationId,
      // Anonymous visitors have no account; staff answer them via the conversation.
      patient: h.patient ? { fullName: h.patient.fullName, email: h.patient.email } : null,
    }));
  }

  /**
   * The guardrail log, newest first: refused patient actions and other flags. `repeated`
   * marks an urgency claim from a patient who made 2+ of them in the last 30 days, so
   * staff can spot a pattern. Names and emails only; nothing clinical.
   */
  @Get('guardrails')
  async guardrails(@Query('kind') kind?: string) {
    const kinds = Object.values(GuardrailKind) as string[];
    const events = await this.prisma.guardrailEvent.findMany({
      where: kind && kinds.includes(kind) ? { kind: kind as GuardrailKind } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { patient: { select: { fullName: true, email: true } } },
    });
    const claims = await this.prisma.guardrailEvent.groupBy({
      by: ['patientId'],
      where: { kind: 'URGENCY_CLAIM', patientId: { not: null }, createdAt: { gt: new Date(this.clock.now().getTime() - 30 * 24 * 3600_000) } },
      _count: true,
    });
    const repeatedClaimers = new Set(claims.filter((c) => c._count >= 2).map((c) => c.patientId));

    return events.map((e) => ({
      id: e.id,
      kind: e.kind,
      action: e.action,
      reasonCode: e.reasonCode,
      message: e.message,
      createdAt: e.createdAt.toISOString(),
      conversationId: e.conversationId,
      patient: e.patient ? { fullName: e.patient.fullName, email: e.patient.email } : null,
      repeated: e.kind === 'URGENCY_CLAIM' && repeatedClaimers.has(e.patientId),
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

  /** New-prescription results still waiting for glasses. Names only, nothing clinical beyond "new glasses". */
  @Get('glasses')
  async glassesWaiting() {
    const waiting = await this.outcomes.waitingForGlasses();
    return waiting.map((o) => ({
      appointmentId: o.appointmentId,
      reference: o.appointment.reference,
      patient: { fullName: o.appointment.patient.fullName },
      examDate: o.appointment.startsAt.toISOString(),
      doctor: o.recordedBy.displayName,
    }));
  }

  /** Any staff role: reception usually unpacks the glasses. */
  @Post('appointments/:id/glasses-ready')
  @HttpCode(HttpStatus.OK)
  async glassesReady(@CurrentStaff() staff: StaffActor, @Param('id') id: string) {
    const outcome = await this.outcomes.markGlassesReady(staff, id, this.clock.now());
    return { appointmentId: id, glassesReadyAt: outcome.glassesReadyAt!.toISOString() };
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
