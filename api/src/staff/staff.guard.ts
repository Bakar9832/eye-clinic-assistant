import { CanActivate, createParamDecorator, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Actor } from '../audit/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { StaffRole } from '../generated/prisma/client.js';
import { httpError } from '../http/http-error.js';

/** Sent only to /staff routes (cookie Path), so patient pages never carry it. */
export const STAFF_COOKIE = 'staff_session';

/** Which roles may use a route. Without it, any active staff member may. */
export const Roles = Reflector.createDecorator<StaffRole[]>();

export type StaffActor = Actor & { type: 'STAFF'; id: string; role: StaffRole; resourceId: string | null };

type StaffRequest = Request & { staff?: StaffActor };

/** Valid staff session + active account + allowed role, or no entry. */
@Injectable()
export class StaffGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<StaffRequest>();
    const session = await this.auth.findSession(req.cookies?.[STAFF_COOKIE]);
    // Checked on every request, so switching an account off locks it out immediately.
    if (!session?.staffUser?.active) {
      throw httpError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', 'Please log in as staff.');
    }

    const allowed = this.reflector.getAllAndOverride(Roles, [context.getHandler(), context.getClass()]);
    if (allowed && !allowed.includes(session.staffUser.role)) {
      throw httpError(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'Your role is not allowed to do this.');
    }

    req.staff = {
      type: 'STAFF',
      id: session.staffUser.id,
      role: session.staffUser.role,
      resourceId: session.staffUser.resourceId,
      ip: req.ip,
    };
    return true;
  }
}

export const CurrentStaff = createParamDecorator((_: unknown, context: ExecutionContext): StaffActor => {
  const req = context.switchToHttp().getRequest<StaffRequest>();
  if (!req.staff) throw new Error('CurrentStaff used on a route without StaffGuard');
  return req.staff;
});
