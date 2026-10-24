import { HttpException, type HttpStatus } from '@nestjs/common';

/**
 * Same JSON shape as scheduling refusals: { error, reasons: [{ code, message }] },
 * plus any extra fields the caller needs to act on (e.g. the bookings in the way).
 */
export function httpError(status: HttpStatus, code: string, message: string, extra: Record<string, unknown> = {}) {
  return new HttpException({ error: code, reasons: [{ code, message }], ...extra }, status);
}
