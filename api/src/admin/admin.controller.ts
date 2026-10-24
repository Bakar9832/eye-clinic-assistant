import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { IANAZone } from 'luxon';
import { Clock } from '../clock.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { httpError } from '../http/http-error.js';
import { CurrentStaff, Roles, StaffGuard, type StaffActor } from '../staff/staff.guard.js';
import { AdminService } from './admin.service.js';

@ValidatorConstraint({ name: 'timezone' })
class IsTimezone implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return typeof value === 'string' && IANAZone.isValidZone(value);
  }
  defaultMessage() {
    return 'timezone must be an IANA zone such as Asia/Karachi';
  }
}

class SettingsDto {
  @IsOptional() @IsString() @Length(1, 100) name?: string;
  /** Where the clinic is. Viewers' own zones are separate and come from their browsers. */
  @IsOptional() @Validate(IsTimezone) timezone?: string;
  @IsOptional() @IsIn([5, 10, 15, 20, 30, 60], { message: 'slotGridMin must be 5, 10, 15, 20, 30 or 60' }) slotGridMin?: number;
  @IsOptional() @IsBoolean() offerRecheckAfterNewPrescription?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(720) outcomeEditWindowHours?: number;
}

class StepDurationDto {
  @IsInt() @Min(1) position!: number;
  @IsInt() @Min(1) @Max(180) durationMin!: number;
}

class TypeDto {
  @IsOptional() @IsInt() @Min(1) @Max(180) typicalMin?: number;
  @IsOptional() @IsString() @Length(1, 1000) prepInstructions?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => StepDurationDto)
  stepDurations?: StepDurationDto[];
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

class WindowDto {
  @IsInt() @Min(1) @Max(7) weekday!: number;
  @Matches(HHMM, { message: 'start must look like 09:00' }) start!: string;
  @Matches(HHMM, { message: 'end must look like 17:00' }) end!: string;
}

class WorkingHoursDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => WindowDto)
  windows!: WindowDto[];
}

const WITH_ZONE = /(Z|[+-]\d{2}:\d{2})$/;

class TimeOffDto {
  @IsISO8601({ strict: true }) @Matches(WITH_ZONE, { message: 'start must include a time zone' }) start!: string;
  @IsISO8601({ strict: true }) @Matches(WITH_ZONE, { message: 'end must include a time zone' }) end!: string;
  @IsOptional() @IsString() @Length(1, 200) reason?: string;
}

class StaffUserDto {
  @IsBoolean() active!: boolean;
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** How the clinic runs. Changes are admin-only and audited; reading is open to all staff. */
@Controller('staff')
@UseGuards(StaffGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly prisma: PrismaClient,
    private readonly clock: Clock,
  ) {}

  @Get('resources')
  async resources() {
    const resources = await this.prisma.resource.findMany({
      include: { workingHours: { orderBy: [{ weekday: 'asc' }, { startMin: 'asc' }] } },
      orderBy: [{ kind: 'asc' }, { displayName: 'asc' }],
    });
    const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return resources.map((r) => ({
      id: r.id,
      kind: r.kind,
      displayName: r.displayName,
      skills: r.skills ?? [],
      active: r.active,
      workingHours: r.workingHours.map((w) => ({ weekday: w.weekday, start: hhmm(w.startMin), end: hhmm(w.endMin) })),
    }));
  }

  @Patch('settings')
  @Roles(['ADMIN'])
  updateSettings(@CurrentStaff() admin: StaffActor, @Body() body: SettingsDto) {
    return this.admin.updateSettings(admin, body, this.clock.now());
  }

  @Patch('appointment-types/:code')
  @Roles(['ADMIN'])
  async updateType(@CurrentStaff() admin: StaffActor, @Param('code') code: string, @Body() body: TypeDto) {
    const type = await this.admin.updateType(admin, code, body);
    return {
      code: type.code,
      typicalMin: type.typicalMin,
      calendarMin: Math.max(...type.steps.map((s) => s.offsetMin + s.durationMin)),
      active: type.active,
      steps: type.steps.map((s) => ({
        position: s.position,
        resourceKind: s.resourceKind,
        offsetMin: s.offsetMin,
        durationMin: s.durationMin,
      })),
    };
  }

  @Put('resources/:id/working-hours')
  @Roles(['ADMIN'])
  async replaceWorkingHours(@CurrentStaff() admin: StaffActor, @Param('id') id: string, @Body() body: WorkingHoursDto) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw httpError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Resource not found.');
    const windows = body.windows.map((w) => ({ weekday: w.weekday, startMin: toMinutes(w.start), endMin: toMinutes(w.end) }));
    if (windows.some((w) => w.startMin >= w.endMin)) {
      throw httpError(HttpStatus.BAD_REQUEST, 'INVALID_INPUT', 'Each window must end after it starts.');
    }
    return this.admin.replaceWorkingHours(admin, id, windows, this.clock.now());
  }

  @Post('resources/:id/time-off')
  @Roles(['ADMIN'])
  @HttpCode(HttpStatus.CREATED)
  async addTimeOff(@CurrentStaff() admin: StaffActor, @Param('id') id: string, @Body() body: TimeOffDto) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw httpError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Resource not found.');
    const timeOff = await this.admin.addTimeOff(admin, id, new Date(body.start), new Date(body.end), body.reason);
    return { id: timeOff.id, start: timeOff.startsAt.toISOString(), end: timeOff.endsAt.toISOString() };
  }

  @Patch('users/:id')
  @Roles(['ADMIN'])
  async updateStaffUser(@CurrentStaff() admin: StaffActor, @Param('id') id: string, @Body() body: StaffUserDto) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw httpError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Staff member not found.');
    const user = await this.admin.setStaffActive(admin, id, body.active);
    return { id: user.id, email: user.email, role: user.role, active: user.active };
  }
}
