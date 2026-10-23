import { HttpException, type HttpStatus } from '@nestjs/common';

/** Same JSON shape as scheduling refusals: { error, reasons: [{ code, message }] }. */
export function httpError(status: HttpStatus, code: string, message: string) {
  return new HttpException({ error: code, reasons: [{ code, message }] }, status);
}
