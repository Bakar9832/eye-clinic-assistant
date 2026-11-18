import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { AuditService, SYSTEM, type Actor } from '../audit/audit.service.js';
import { Clock } from '../clock.js';
import { requireEnv } from '../config.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { httpError } from '../http/http-error.js';
import { EmailSender } from '../notifications/email-sender.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password.js';

const CODE_TTL_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;
const SESSION_DAYS = 7;
/** Staff sessions last one shift. */
const STAFF_SESSION_HOURS = 12;
const CODES_PER_EMAIL = { limit: 5, windowMinutes: 15 };
const CODES_PER_IP = { limit: 10, windowMinutes: 60 };
/** Wrong passwords: per email (slows guessing one account) and per IP (slows trying many). */
const FAILURES_PER_EMAIL = { limit: 5, windowMinutes: 15 };
const FAILURES_PER_IP = { limit: 20, windowMinutes: 60 };

const minutes = (n: number) => n * 60_000;

function normaliseEmail(email: string) {
  return email.trim().toLowerCase();
}

/** A new login: the raw token goes in the cookie and is never stored. */
export interface NewSession {
  token: string;
  expiresAt: Date;
}

type Owner = { patientId: string } | { staffUserId: string };

/**
 * Email + password login, with emailed codes to prove the inbox:
 *  - sign up / forgot password: email -> 6-digit code -> choose a password -> logged in.
 *    The code is the same proof either way (you control the inbox), so one flow does both;
 *    a reset also logs out every other session.
 *  - log in: email + password -> session cookie.
 * Staff log in with a password only. They can't sign up: their accounts and passwords
 * are created by the seed or scripts/set-password.ts.
 *
 * Nothing secret is stored in readable form. Passwords: scrypt (password.ts). Codes: an
 * HMAC keyed with AUTH_SECRET (a plain hash of a 6-digit code is cracked in seconds).
 * Session tokens are 256-bit random, so a plain SHA-256 is enough.
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
  async requestCode(rawEmail: string, ip: string | undefined) {
    const email = normaliseEmail(rawEmail);
    const now = this.clock.now();
    const actor: Actor = { ...SYSTEM, ip };

    const [forEmail, forIp] = await Promise.all([
      this.prisma.loginCode.count({
        where: { email, createdAt: { gt: new Date(now.getTime() - minutes(CODES_PER_EMAIL.windowMinutes)) } },
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

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');

    await this.prisma.$transaction(async (tx) => {
      // Only the newest code works: earlier unused ones are retired.
      await tx.loginCode.updateMany({ where: { email, consumedAt: null }, data: { consumedAt: now } });
      await tx.loginCode.create({
        data: {
          email,
          codeHash: this.hashCode(email, code),
          requestIp: ip,
          createdAt: now,
          expiresAt: new Date(now.getTime() + minutes(CODE_TTL_MINUTES)),
        },
      });
      await this.audit.record({ actor, action: 'LOGIN_CODE_REQUESTED' }, tx);
    });

    // Only the inbox's owner reads this, so it may say whether the account exists.
    const existing = await this.prisma.patient.findUnique({ where: { email }, select: { passwordHash: true } });
    const reset = Boolean(existing?.passwordHash);
    await this.email.send({
      to: email,
      subject: reset ? 'Your password reset code' : 'Your sign-up code',
      text:
        `Your code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes.\n` +
        (reset ? 'Use it to choose a new password. ' : 'Use it to create your account. ') +
        "If you didn't ask for it, ignore this email: nothing changes without the code.",
    });
  }

  /**
   * Sign-up and password reset: the emailed code proves the inbox, then the password is set.
   * The first time creates the patient. A reset logs out every other session, so whoever
   * knew the old password is out.
   */
  async setPassword(rawEmail: string, code: string, password: string, ip: string | undefined): Promise<NewSession> {
    const email = normaliseEmail(rawEmail);
    const now = this.clock.now();
    const invalid = () => httpError(HttpStatus.UNAUTHORIZED, 'INVALID_CODE', 'That code is wrong or has expired.');

    const loginCode = await this.prisma.loginCode.findFirst({
      where: { email, consumedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });

    if (!loginCode || loginCode.attempts >= MAX_CODE_ATTEMPTS || !this.matches(loginCode.codeHash, email, code)) {
      if (loginCode) {
        // Counted in the database, so parallel guesses can't share one attempt.
        await this.prisma.loginCode.update({ where: { id: loginCode.id }, data: { attempts: { increment: 1 } } });
      }
      await this.audit.record({ actor: { ...SYSTEM, ip }, action: 'LOGIN_FAILED', details: { method: 'code' } });
      throw invalid();
    }

    // Hashed before the code is used up, so a slow hash can't leave a spent code and no password.
    const passwordHash = await hashPassword(password);

    // Conditional update: if the same code is submitted twice at once, only one wins.
    const { count } = await this.prisma.loginCode.updateMany({
      where: { id: loginCode.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (count === 0) throw invalid();

    const before = await this.prisma.patient.findUnique({ where: { email }, select: { passwordHash: true } });
    const patient = await this.prisma.patient.upsert({ where: { email }, create: { email, passwordHash }, update: { passwordHash } });
    const reset = Boolean(before?.passwordHash);
    if (reset) {
      await this.prisma.session.updateMany({ where: { patientId: patient.id, revokedAt: null }, data: { revokedAt: now } });
    }
    await this.audit.record({ actor: { type: 'PATIENT', id: patient.id, ip }, action: reset ? 'PASSWORD_RESET' : 'SIGNED_UP' });
    return this.startSession({ patientId: patient.id }, 'LOGIN_SUCCEEDED', ip, minutes(SESSION_DAYS * 24 * 60));
  }

  /**
   * Email + password, for patients or staff. A wrong password, an unknown email and an
   * account without a password all get the same answer in the same time, so nobody can
   * find out which emails have accounts.
   */
  async login(rawEmail: string, password: string, ip: string | undefined, door: 'PATIENT' | 'STAFF'): Promise<NewSession> {
    const email = normaliseEmail(rawEmail);
    const now = this.clock.now();
    const since = (windowMinutes: number) => ({ gt: new Date(now.getTime() - minutes(windowMinutes)) });

    // Checked before the password, so a locked-out guesser learns nothing even when right.
    const [forEmail, forIp] = await Promise.all([
      this.prisma.loginFailure.count({ where: { email, createdAt: since(FAILURES_PER_EMAIL.windowMinutes) } }),
      ip === undefined ? 0 : this.prisma.loginFailure.count({ where: { ip, createdAt: since(FAILURES_PER_IP.windowMinutes) } }),
    ]);
    if (forEmail >= FAILURES_PER_EMAIL.limit || forIp >= FAILURES_PER_IP.limit) {
      await this.audit.record({ actor: { ...SYSTEM, ip }, action: 'LOGIN_RATE_LIMITED' });
      throw httpError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', 'Too many failed logins. Please wait 15 minutes and try again.');
    }

    const account =
      door === 'STAFF'
        ? await this.prisma.staffUser.findFirst({ where: { email, active: true }, select: { id: true, passwordHash: true } })
        : await this.prisma.patient.findUnique({ where: { email }, select: { id: true, passwordHash: true } });
    // No account or no password: still run a full scrypt check, so it takes as long as a wrong password.
    const ok = await verifyPassword(password, account?.passwordHash ?? (await DUMMY_HASH));

    if (!account?.passwordHash || !ok) {
      await this.prisma.loginFailure.create({ data: { email, ip, createdAt: now } });
      await this.audit.record({ actor: { ...SYSTEM, ip }, action: 'LOGIN_FAILED', details: { method: 'password', door } });
      throw httpError(HttpStatus.UNAUTHORIZED, 'INVALID_LOGIN', 'Email or password is incorrect.');
    }

    return door === 'STAFF'
      ? this.startSession({ staffUserId: account.id }, 'STAFF_LOGIN_SUCCEEDED', ip, minutes(STAFF_SESSION_HOURS * 60))
      : this.startSession({ patientId: account.id }, 'LOGIN_SUCCEEDED', ip, minutes(SESSION_DAYS * 24 * 60));
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

  private hashCode(email: string, code: string) {
    return createHmac('sha256', this.secret).update(`PATIENT:${email}:${code}`).digest('hex');
  }

  /** Constant-time comparison, so response timing doesn't leak how close a guess was. */
  private matches(storedHash: string, email: string, code: string) {
    return timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(this.hashCode(email, code), 'hex'));
  }
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function actorFor(session: { patientId: string | null; staffUserId: string | null }, ip: string | undefined): Actor {
  return session.staffUserId
    ? { type: 'STAFF', id: session.staffUserId, ip }
    : { type: 'PATIENT', id: session.patientId ?? undefined, ip };
}
