import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { SchedulingError, type SchedulingErrorCode } from './scheduling-error.js';

const STATUS: Record<SchedulingErrorCode, HttpStatus> = {
  INVALID_DAY: HttpStatus.BAD_REQUEST,
  UNKNOWN_TYPE: HttpStatus.BAD_REQUEST,
  UNKNOWN_DOCTOR: HttpStatus.BAD_REQUEST,
  INVALID_SLOT: HttpStatus.UNPROCESSABLE_ENTITY,
  SLOT_TAKEN: HttpStatus.CONFLICT,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  NOT_CANCELLABLE: HttpStatus.CONFLICT,
  NOT_CHANGEABLE: HttpStatus.CONFLICT,
  PROFILE_INCOMPLETE: HttpStatus.FORBIDDEN,
  OVERRIDE_REQUIRED: HttpStatus.CONFLICT,
  ALREADY_BOOKED: HttpStatus.CONFLICT,
};

/** Turns a SchedulingError into a JSON response with its reasons. */
@Catch(SchedulingError)
export class SchedulingErrorFilter implements ExceptionFilter {
  catch(error: SchedulingError, host: ArgumentsHost) {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(STATUS[error.code])
      .json({ error: error.code, reasons: error.reasons });
  }
}
