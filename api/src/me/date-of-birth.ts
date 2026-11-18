import { HttpStatus } from '@nestjs/common';
import { httpError } from '../http/http-error.js';

/**
 * A YYYY-MM-DD date of birth (format already checked by the DTO) as a UTC midnight Date.
 * Refuses dates in the future or before 1900. Used by the profile and by sign-up.
 */
export function parseDateOfBirth(value: string, now: Date): Date {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date > now || date < new Date('1900-01-01T00:00:00Z')) {
    throw httpError(HttpStatus.BAD_REQUEST, 'INVALID_INPUT', 'That date of birth is not possible.');
  }
  return date;
}
