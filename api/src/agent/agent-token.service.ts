import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Clock } from '../clock.js';
import { requireEnv } from '../config.js';

/** How long the agent may act for one chat turn. */
export const AGENT_TOKEN_MINUTES = 5;

/** Who the agent is acting for during one chat turn. Never chosen by the model. */
export interface AgentIdentity {
  /** null = an anonymous visitor: only public tools work. */
  patientId: string | null;
  /** The patient's browser session: the date-of-birth unlock is checked on it. */
  sessionId: string | null;
  conversationId: string;
  /** For showing times in the viewer's own zone as well as clinic time. */
  viewerTimezone: string;
}

interface Payload extends AgentIdentity {
  exp: number;
}

/**
 * The pass the API hands the agent for one chat turn: base64url(JSON) + "." + HMAC.
 *
 * Signed with AGENT_TOKEN_SECRET, which only the API holds. The agent just carries the
 * token to the MCP server in a header; it can't make one or change one, and the model
 * never sees it. Tampering breaks the signature; after 5 minutes it's useless.
 */
@Injectable()
export class AgentTokenService {
  private readonly secret = requireEnv('AGENT_TOKEN_SECRET');

  constructor(private readonly clock: Clock) {}

  mint(identity: AgentIdentity): string {
    const payload: Payload = { ...identity, exp: this.clock.now().getTime() + AGENT_TOKEN_MINUTES * 60_000 };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  /** The identity inside a valid, unexpired token, or null. */
  verify(token: string | undefined): AgentIdentity | null {
    const [body, signature, extra] = (token ?? '').split('.');
    if (!body || !signature || extra !== undefined) return null;

    const expected = Buffer.from(this.sign(body), 'base64url');
    const given = Buffer.from(signature, 'base64url');
    // Constant-time, and only once lengths match (timingSafeEqual requires that).
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

    let payload: Payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Payload;
    } catch {
      return null;
    }
    if (typeof payload.exp !== 'number' || payload.exp <= this.clock.now().getTime()) return null;

    const { patientId, sessionId, conversationId, viewerTimezone } = payload;
    return { patientId, sessionId, conversationId, viewerTimezone };
  }

  private sign(body: string) {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}
