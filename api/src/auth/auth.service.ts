import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { AuditService, SYSTEM, type Actor } from '../audit/audit.service.js';
import { Clock } from '../clock.js';
import { requireEnv } from '../config.js';
import { PrismaClient, type LoginPurpose } from '../generated/prisma/client.js';
import { httpError } from '../http/http-error.js';
import { EmailSender } from '../notifications/email-sender.js';

export const CODE_TTL_MINUTES = 10;
export const MAX_CODE_ATTEMPTS = 5;
export const SESSION_DAYS = 7;
/** Staff sessions last one shift. */
export const STAFF_SESSION_HOURS = 12;
export const CODES_PER_EMAIL = { limit: 5, windowMinutes: 15 };
export const CODES_PER_IP = { limit: 10, windowMinutes: 60 };

const minutes = (n: number) => n * 60_000;

export function normaliseEmail(email: string) {
  return email.trim().toLowerCase();
}

/** A new login: the raw token goes in the cookie and is never stored. */
export interface NewSession {
  token: string;
  expiresAt: Date;
}

type Owner = { patientId: string } | { staffUserId: string };

/**
 * Passwordless login: email → 6-digit code → session cookie. One flow, two doors:
 * PATIENT (anyone; first login creates the patient) and STAFF (existing, active staff
 * accounts only). Codes are tagged with their door, so a patient code never opens staff.
 *
 * Nothing secret is stored in readable form. Codes are stored as an HMAC keyed with
 * AUTH_SECRET (a plain hash of a 6-digit code is cracked in seconds); session tokens
 * are 256-bit random, so a plain SHA-256 is enough.
 */
@Injectable()
export class AuthService {
  private readonly secret = requireEnv('AUTH_SECRET');

  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Clock,
    private readonly email: EmailSender,
    private readonly audit: AuditService,
  ) {}

  /** Same outcome whether or not the email has an account, so nobody can test which emails exist. */
  async requestCode(rawEmail: string, ip: string | undefined, purpose: LoginPurpose = 'PATIENT') {
    const email = normaliseEmail(rawEmail);
    const now = this.clock.now();
    const actor: Actor = { ...SYSTEM, ip };

    const [forEmail, forIp] = await Promise.all([
      this.prisma.loginCode.count({
        where: { email, purpose, createdAt: { gt: new Date(now.getTime() - minutes(CODES_PER_EMAIL.windowMinutes)) } },
      }),
      ip === undefined
        ? 0
        : this.prisma.loginCode.count({
            where: { requestIp: ip, createdAt: { gt: new Date(now.getTime() - minutes(CODES_PER_IP.windowMinutes)) } },
          }),
    ]);
    if (forEmail >= CODES_PER_EMAIL.limit || forIp >= CODES_PER_IP.limit) {
      await this.audit.record({ actor, action: 'LOGIN_RATE_LIMITED' });
      throw httpError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', 'Too many code requests. Please wait and try again.');
    }

    // Staff can't sign up: no account, no code, no email. The caller sees the same reply.
    if (purpose === 'STAFF' && !(await this.activeStaff(email))) {
      await this.audit.record({ actor, action: 'STAFF_CODE_REQUESTED_UNKNOWN' });
      return;
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');

    await this.prisma.$transaction(async (tx) => {
      // Only the newest code works: earlier unused ones are retired.
      await tx.loginCode.updateMany({ where: { email, purpose, consumedAt: null }, data: { consumedAt: now } });
      await tx.loginCode.create({
        data: {
          email,
          purpose,
          codeHash: this.hashCode(purpose, email, code),
          requestIp: ip,
          createdAt: now,
          expiresAt: new Date(now.getTime() + minutes(CODE_TTL_MINUTES)),
        },
      });
      await this.audit.record({ actor, action: 'LOGIN_CODE_REQUESTED' }, tx);
    });

    await this.email.send({
      to: email,
      subject: purpose === 'STAFF' ? 'Your staff login code' : 'Your login code',
      text: `Your login code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes.\nIf you didn't ask for it, ignore this email.`,
    });
  }

  async verify(
    rawEmail: string,
    code: string,
    ip: string | undefined,
    purpose: LoginPurpose = 'PATIENT',
  ): Promise<NewSession> {
    const email = normaliseEmail(rawEmail);
    const now = this.clock.now();
    const invalid = () => httpError(HttpStatus.UNAUTHORIZED, 'INVALID_CODE', 'That code is wrong or has expired.');

    const loginCode = await this.prisma.loginCode.findFirst({
      where: { email, purpose, consumedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });

    if (!loginCode || loginCode.attempts >= MAX_CODE_ATTEMPTS || !this.matches(loginCode.codeHash, purpose, email, code)) {
      if (loginCode) {
        // Counted in the database, so parallel guesses can't share one attempt.
        await this.prisma.loginCode.update({ where: { id: loginCode.id }, data: { attempts: { increment: 1 } } });
      }
      await this.audit.record({ actor: { ...SYSTEM, ip }, action: 'LOGIN_FAILED', details: { purpose } });
      throw invalid();
    }

    // Conditional update: if the same code is submitted twice at once, only one wins.
    const { count } = await this.prisma.loginCode.updateMany({
      where: { id: loginCode.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (count === 0) throw invalid();

    if (purpose === 'STAFF') {
      // Re-checked: the account may have been switched off since the code was sent.
      const staff = await this.activeStaff(email);
      if (!staff) throw invalid();
      return this.startSession({ staffUserId: staff.id }, 'STAFF_LOGIN_SUCCEEDED', ip, minutes(STAFF_SESSION_HOURS * 60));
    }

    // First patient login creates the patient. Name and date of birth come later, before booking.
    const patient = await this.prisma.patient.upsert({ where: { email }, create: { email }, update: {} });
    return this.startSession({ patientId: patient.id }, 'LOGIN_SUCCEEDED', ip, minutes(SESSION_DAYS * 24 * 60));
  }

  /** "Try as demo patient". Only when DEMO_MODE=true; read on every call so it can be switched off. */
  async demoLogin(ip: string | undefined): Promise<NewSession> {
    const demo =
      process.env.DEMO_MODE === 'true' ? await this.prisma.patient.findFirst({ where: { isDemo: true } }) : null;
    if (!demo) throw httpError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found.');
    return this.startSession({ patientId: demo.id }, 'DEMO_LOGIN', ip, minutes(SESSION_DAYS * 24 * 60));
  }

  /** The session behind a cookie, or null if it's missing, revoked or expired. */
  async findSession(token: string | undefined) {
    if (!token) return null;
    return this.prisma.session.findFirst({
      where: { tokenHash: hashToken(token), revokedAt: null, expiresAt: { gt: this.clock.now() } },
      include: { staffUser: { select: { id: true, role: true, resourceId: true, active: true } } },
    });
  }

  async logout(token: string | undefined, ip: string | undefined) {
    const session = await this.findSession(token);
    if (!session) return;
    await this.revoke(session.id);
    await this.audit.record({ actor: actorFor(session, ip), action: 'LOGOUT' });
  }

  async revoke(sessionId: string) {
    await this.prisma.session.update({ where: { id: sessionId }, data: { revokedAt: this.clock.now() } });
  }

  private activeStaff(email: string) {
    return this.prisma.staffUser.findFirst({ where: { email, active: true } });
  }

  private async startSession(owner: Owner, action: string, ip: string | undefined, lengthMs: number): Promise<NewSession> {
    const now = this.clock.now();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + lengthMs);

    await this.prisma.session.create({ data: { tokenHash: hashToken(token), ...owner, createdAt: now, expiresAt } });
    await this.audit.record({
      actor: 'staffUserId' in owner ? { type: 'STAFF', id: owner.staffUserId, ip } : { type: 'PATIENT', id: owner.patientId, ip },
      action,
    });
    return { token, expiresAt };
  }

  private hashCode(purpose: LoginPurpose, email: string, code: string) {
    return createHmac('sha256', this.secret).update(`${purpose}:${email}:${code}`).digest('hex');
  }

  /** Constant-time comparison, so response timing doesn't leak how close a guess was. */
  private matches(storedHash: string, purpose: LoginPurpose, email: string, code: string) {
    return timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(this.hashCode(purpose, email, code), 'hex'));
  }
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function actorFor(session: { patientId: string | null; staffUserId: string | null }, ip: string | undefined): Actor {
  return session.staffUserId
    ? { type: 'STAFF', id: session.staffUserId, ip }
    : { type: 'PATIENT', id: session.patientId ?? undefined, ip };
}
