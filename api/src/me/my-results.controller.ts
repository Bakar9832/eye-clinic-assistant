import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { IsISO8601, Length } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import { CurrentPatient, SessionGuard, type PatientActor } from '../auth/session.guard.js';
import { Clock } from '../clock.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { httpError } from '../http/http-error.js';
import { OutcomesService } from '../outcomes/outcomes.service.js';

/** How long a passed date-of-birth check unlocks results in this session. */
export const DOB_UNLOCK_MINUTES = 15;
/** Wrong dates of birth before the session is ended. */
export const MAX_DOB_ATTEMPTS = 5;

class VerifyDobDto {
  @IsISO8601({ strict: true })
  @Length(10, 10, { message: 'dateOfBirth must look like 1990-01-15' })
  dateOfBirth!: string;
}

/**
 * Results need more than a login: the patient also confirms their date of birth, per
 * session. Someone who finds an unlocked laptop with the patient logged in still can't
 * read results without knowing it.
 */
@Controller('me')
@UseGuards(SessionGuard)
export class MyResultsController {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly outcomes: OutcomesService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  @Post('verify-dob')
  @HttpCode(HttpStatus.OK)
  async verifyDob(@CurrentPatient() me: PatientActor, @Body() body: VerifyDobDto) {
    const patient = await this.prisma.patient.findUniqueOrThrow({ where: { id: me.id } });
    if (!patient.dateOfBirth) {
      throw httpError(HttpStatus.CONFLICT, 'PROFILE_INCOMPLETE', 'Please add your date of birth to your profile first.');
    }

    if (patient.dateOfBirth.toISOString().slice(0, 10) === body.dateOfBirth) {
      await this.prisma.session.update({
        where: { id: me.sessionId },
        data: { dobVerifiedAt: this.clock.now(), dobFailedAttempts: 0 },
      });
      await this.audit.record({ actor: me, action: 'DOB_CHECK_PASSED' });
      return { verified: true, validForMinutes: DOB_UNLOCK_MINUTES };
    }

    // Counted in the database, so parallel guesses can't share one attempt.
    const { dobFailedAttempts } = await this.prisma.session.update({
      where: { id: me.sessionId },
      data: { dobFailedAttempts: { increment: 1 } },
    });
    if (dobFailedAttempts >= MAX_DOB_ATTEMPTS) {
      await this.auth.revoke(me.sessionId);
      await this.audit.record({ actor: me, action: 'DOB_CHECK_LOCKED' });
      throw httpError(HttpStatus.UNAUTHORIZED, 'DOB_LOCKED', 'Too many wrong attempts. Please log in again.');
    }
    await this.audit.record({ actor: me, action: 'DOB_CHECK_FAILED' });
    throw httpError(HttpStatus.UNAUTHORIZED, 'DOB_MISMATCH', "That date of birth doesn't match our records.");
  }

  /** The latest result: the outcome code and the doctor's note, word for word. Nothing else. */
  @Get('outcome')
  async latestOutcome(@CurrentPatient() me: PatientActor) {
    const session = await this.prisma.session.findUniqueOrThrow({ where: { id: me.sessionId } });
    const unlockedUntil = (session.dobVerifiedAt?.getTime() ?? 0) + DOB_UNLOCK_MINUTES * 60_000;
    // Even "no results yet" needs the check, so nothing at all leaks without it.
    if (this.clock.now().getTime() > unlockedUntil) {
      throw httpError(HttpStatus.FORBIDDEN, 'DOB_REQUIRED', 'Please confirm your date of birth to see results.');
    }

    const outcome = await this.outcomes.latestFor(me.id);
    await this.audit.record({ actor: me, action: 'RESULTS_VIEWED', details: { found: outcome !== null } });
    if (!outcome) return { status: 'NOT_READY' };

    return {
      status: 'READY',
      outcome: outcome.code,
      doctorNote: outcome.patientNote,
      doctorName: outcome.recordedBy.displayName,
      appointment: { date: outcome.appointment.startsAt.toISOString(), type: outcome.appointment.appointmentType.name },
      recordedAt: outcome.recordedAt.toISOString(),
      // The patient is told when a doctor has corrected a result.
      edited: outcome.correctedAt !== null,
      editedAt: outcome.correctedAt?.toISOString() ?? null,
    };
  }
}
