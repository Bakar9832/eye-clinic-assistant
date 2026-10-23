import { Body, Controller, Get, HttpStatus, Patch, UseGuards } from '@nestjs/common';
import {
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { IANAZone } from 'luxon';
import { AuditService } from '../audit/audit.service.js';
import { CurrentPatient, SessionGuard, type PatientActor } from '../auth/session.guard.js';
import { Clock } from '../clock.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { httpError } from '../http/http-error.js';

@ValidatorConstraint({ name: 'timezone' })
class IsTimezone implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return typeof value === 'string' && IANAZone.isValidZone(value);
  }
  defaultMessage() {
    return 'timezone must be an IANA zone such as Europe/London';
  }
}

class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  fullName?: string;

  /** YYYY-MM-DD. Can be set once; changing it later goes through the clinic. */
  @IsOptional()
  @IsISO8601({ strict: true })
  @Length(10, 10, { message: 'dateOfBirth must look like 1990-01-15' })
  dateOfBirth?: string;

  @IsOptional()
  @Validate(IsTimezone)
  timezone?: string;
}

/** The logged-in patient's own profile. Every query is scoped by the id from the session. */
@Controller('me')
@UseGuards(SessionGuard)
export class MeController {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  @Get()
  async profile(@CurrentPatient() me: PatientActor) {
    return toProfile(await this.prisma.patient.findUniqueOrThrow({ where: { id: me.id } }));
  }

  @Patch()
  async update(@CurrentPatient() me: PatientActor, @Body() body: UpdateProfileDto) {
    const patient = await this.prisma.patient.findUniqueOrThrow({ where: { id: me.id } });

    // The date of birth is the second check before results are shown. If a stolen
    // session could change it, that check would be worthless.
    if (body.dateOfBirth !== undefined && patient.dateOfBirth !== null) {
      throw httpError(
        HttpStatus.CONFLICT,
        'DOB_ALREADY_SET',
        'Your date of birth is already set. Please contact the clinic to change it.',
      );
    }
    const dateOfBirth = body.dateOfBirth === undefined ? undefined : new Date(`${body.dateOfBirth}T00:00:00Z`);
    if (dateOfBirth && (dateOfBirth > this.clock.now() || dateOfBirth < new Date('1900-01-01T00:00:00Z'))) {
      throw httpError(HttpStatus.BAD_REQUEST, 'INVALID_INPUT', 'That date of birth is not possible.');
    }

    const updated = await this.prisma.patient.update({
      where: { id: me.id },
      data: { fullName: body.fullName?.trim(), dateOfBirth, timezone: body.timezone },
    });
    // Which fields changed, never their values.
    await this.audit.record({
      actor: me,
      action: 'PROFILE_UPDATED',
      entityType: 'Patient',
      entityId: me.id,
      details: { fields: Object.keys(body) },
    });
    return toProfile(updated);
  }
}

/** The date of birth is never sent back: it's the second factor for results. */
function toProfile(p: { email: string; fullName: string | null; dateOfBirth: Date | null; timezone: string | null }) {
  return {
    email: p.email,
    fullName: p.fullName,
    hasDateOfBirth: p.dateOfBirth !== null,
    timezone: p.timezone,
    profileComplete: p.fullName !== null && p.dateOfBirth !== null,
  };
}
