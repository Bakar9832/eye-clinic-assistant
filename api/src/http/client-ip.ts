import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';

/** Set by the web app's edge middleware (web/middleware.ts) on every API request it passes on. */
export const VISITOR_IP_HEADER = 'x-visitor-ip';
export const PROXY_SECRET_HEADER = 'x-proxy-secret';
/** What every request that didn't come through the site counts as, for the per-IP limits. */
export const UNVERIFIED_IP = 'unverified';

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const sameSecret = (given: string, expected: string) => {
  const [a, b] = [Buffer.from(given), Buffer.from(expected)];
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * The visitor's address, for the per-IP limits and the audit log.
 *
 * - PROXY_SHARED_SECRET set (live): the address the web app's edge middleware signed, if
 *   the secret matches. Anything else (someone calling the API host directly, or a forged
 *   header) counts as one shared "unverified" address, so going round the site can't get
 *   round the per-IP limits.
 * - Not set (local development, tests, evals): the connection's address, after
 *   TRUST_PROXY_HOPS proxies (see main.ts), as before.
 */
export function clientIp(req: Request, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return verifiedIp(req, env) ?? (env.PROXY_SHARED_SECRET ? UNVERIFIED_IP : req.ip);
}

/** The signed visitor address, or null when there is none (or no secret is set). */
export function verifiedIp(req: Request, env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = env.PROXY_SHARED_SECRET;
  const given = one(req.headers[PROXY_SECRET_HEADER]);
  const ip = one(req.headers[VISITOR_IP_HEADER])?.trim();
  if (!secret || !given || !ip || !sameSecret(given, secret) || isIP(ip) === 0) return null;
  return ip;
}

/** The visitor's address as a handler parameter: use instead of Nest's @Ip(). */
export const ClientIp = createParamDecorator((_data: unknown, ctx: ExecutionContext) => clientIp(ctx.switchToHttp().getRequest<Request>()));
