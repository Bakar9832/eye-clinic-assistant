import { CanActivate, createParamDecorator, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { Actor } from '../audit/audit.service.js';
import { httpError } from '../http/http-error.js';
import { AuthService } from './auth.service.js';

export const SESSION_COOKIE = 'session';

type AuthenticatedRequest = Request & { patientId?: string };

/** The logged-in patient, as an audit actor with a guaranteed id. */
export type PatientActor = Actor & { type: 'PATIENT'; id: string };

/** Lets the request through only with a valid session cookie, and remembers whose it is. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = await this.auth.findSession(req.cookies?.[SESSION_COOKIE]);
    if (!session) throw httpError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', 'Please log in.');
    req.patientId = session.patientId;
    return true;
  }
}

/**
 * The logged-in patient. This is the ONLY way a patient id reaches the /me endpoints:
 * from the session, never from the URL or the body.
 */
export const CurrentPatient = createParamDecorator((_: unknown, context: ExecutionContext): PatientActor => {
  const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!req.patientId) throw new Error('CurrentPatient used on a route without SessionGuard');
  return { type: 'PATIENT', id: req.patientId, ip: req.ip };
});
