import { Controller, Get, Header, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AgentClient } from '../chat/agent-client.js';
import { verifiedIp } from '../http/client-ip.js';

/**
 * Keep-warm: one cheap URL that an external pinger (and the web app's status dot) can call
 * to keep both free-tier services awake. Hitting it wakes the API; it then pings the
 * agent's /health with a short limit (AGENT_PING_TIMEOUT_MS, 5 s), which wakes the agent.
 *
 * Deliberately touches nothing else: no login, no database, no audit entry, no rate-limit
 * or chat-cap counter (those are counts of stored chat messages and login attempts, and
 * this route stores nothing), and never the model. Always 200: a slow agent is "waking".
 */
@Controller('health')
export class HealthController {
  constructor(private readonly agent: AgentClient) {}

  @Get('warm')
  @Header('Cache-Control', 'no-store')
  async warm(): Promise<{ api: 'ok'; agent: 'ok' | 'waking' }> {
    const answered = await this.agent.warm();
    return { api: 'ok', agent: answered ? 'ok' : 'waking' };
  }

  /**
   * Whether this request carried a valid signed visitor address (from the web app's edge
   * middleware). For checking the live setup: true through the site, false when calling
   * the API host directly. Never echoes the address itself.
   */
  @Get('ip')
  @Header('Cache-Control', 'no-store')
  ip(@Req() req: Request): { verified: boolean } {
    return { verified: verifiedIp(req) !== null };
  }
}
