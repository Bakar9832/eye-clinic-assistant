import { Injectable } from '@nestjs/common';
import { Clock } from '../clock.js';
import { PrismaClient, type AuditActorType, type Prisma } from '../generated/prisma/client.js';

/** Who is acting. The id always comes from the session, never from a request body. */
export interface Actor {
  type: AuditActorType;
  id?: string;
  ip?: string;
}

export const SYSTEM: Actor = { type: 'SYSTEM' };

export interface AuditInput {
  actor: Actor;
  action: string;
  entityType?: string;
  entityId?: string;
  /** Safe details only: never codes, tokens, dates of birth or doctors' notes. */
  details?: Prisma.InputJsonObject;
}

/** Writes to the append-only audit log, optionally inside the caller's transaction. */
@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Clock,
  ) {}

  async record(event: AuditInput, db: Prisma.TransactionClient | PrismaClient = this.prisma) {
    await db.auditEvent.create({
      data: {
        at: this.clock.now(),
        actorType: event.actor.type,
        actorId: event.actor.id,
        ip: event.actor.ip,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        details: event.details,
      },
    });
  }
}
