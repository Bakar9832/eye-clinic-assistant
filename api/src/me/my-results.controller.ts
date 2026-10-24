import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { IsISO8601, Length } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import { CurrentPatient, SessionGuard, type PatientActor } from '../auth/session.guard.js';
import { Clock } from '../clock.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { httpError } from '../http/http-error.js';
import { DOB_UNLOCK_MINUTES, ResultsService } from '../results/results.service.js';

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
    private readonly results: ResultsService,
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
    // Even "no results yet" needs the check, so nothing at all leaks without it.
    if (!(await this.results.isUnlocked(me.sessionId))) {
      throw httpError(HttpStatus.FORBIDDEN, 'DOB_REQUIRED', 'Please confirm your date of birth to see results.');
    }
    return this.results.latest(me.id, me);
  }
}
