import { Injectable } from '@nestjs/common';
import { AuditService, SYSTEM } from '../audit/audit.service.js';
import { Clock } from '../clock.js';
import { PrismaClient } from '../generated/prisma/client.js';

const DAY = 24 * 3_600_000;

export interface RetentionResult {
  chats: number;
  handoffs: number;
  loginCodes: number;
  sessions: number;
}

/**
 * Deletes personal data the clinic no longer needs. Kept on purpose: patients,
 * appointments and results (medical records have legal retention rules), sent-email
 * records (no content, and deleting one would let it be sent again) and the audit log
 * (an audit trail is only trustworthy if the app can't erase it).
 *
 * Every rule is a plain "delete where older than", so running it twice, or on two API
 * instances at once, is harmless.
 */
@Injectable()
export class RetentionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async runOnce(now = this.clock.now()): Promise<RetentionResult> {
    const { chatRetentionDays } = await this.prisma.clinicSetting.findUniqueOrThrow({ where: { id: 1 } });
    const chatCutoff = new Date(now.getTime() - chatRetentionDays * DAY);
    const dayAgo = new Date(now.getTime() - DAY);

    // From the LAST message, so a chat still in use isn't cut off because it started long ago.
    // Messages go with it (cascade); a handoff from it keeps its reason and loses the link.
    const chats = await this.prisma.conversation.deleteMany({ where: { lastMessageAt: { lt: chatCutoff } } });
    // Open ones stay until staff handle them: nothing waiting for a person disappears.
    const handoffs = await this.prisma.handoffRequest.deleteMany({ where: { status: 'CLOSED', createdAt: { lt: chatCutoff } } });
    // The rate limits look back at most an hour; a day leaves plenty of margin.
    const loginCodes = await this.prisma.loginCode.deleteMany({ where: { createdAt: { lt: dayAgo } } });
    // Only sessions that already stopped working a day ago: nobody is logged out by this.
    const sessions = await this.prisma.session.deleteMany({
      where: { OR: [{ expiresAt: { lt: dayAgo } }, { revokedAt: { lt: dayAgo } }] },
    });

    const result = { chats: chats.count, handoffs: handoffs.count, loginCodes: loginCodes.count, sessions: sessions.count };
    // Counts only, never what was deleted.
    await this.audit.record({ actor: SYSTEM, action: 'RETENTION_RUN', details: { ...result } });
    return result;
  }
}
