import type { Actor, AuditService } from '../audit/audit.service.js';
import type { PrismaClient } from '../generated/prisma/client.js';

export interface CallbackResult {
  status: 'CALLBACK_REQUESTED' | 'ALREADY_REQUESTED';
  /** Where staff will reach the patient: the account's email. */
  contact: string;
}

/**
 * Asks staff to call a logged-in patient back (Handoffs page, kind CALLBACK). Used by the
 * request_callback tool and by the "Request a call back" button, so both follow the same
 * rule: one open request per patient is enough.
 */
export async function requestCallback(
  prisma: PrismaClient,
  audit: AuditService,
  input: { patientId: string; conversationId?: string | null; reason: string; preferredTime?: string; actor: Actor; at: Date },
): Promise<CallbackResult> {
  const patient = await prisma.patient.findUniqueOrThrow({ where: { id: input.patientId }, select: { email: true } });
  const open = await prisma.handoffRequest.findFirst({ where: { patientId: input.patientId, kind: 'CALLBACK', status: 'OPEN' } });
  if (open) return { status: 'ALREADY_REQUESTED', contact: patient.email };

  const request = await prisma.handoffRequest.create({
    data: {
      kind: 'CALLBACK',
      patientId: input.patientId,
      conversationId: input.conversationId ?? null,
      reason: input.reason,
      preferredTime: input.preferredTime,
      createdAt: input.at,
    },
  });
  // The reason may describe symptoms, so it stays out of the audit log.
  await audit.record({ actor: input.actor, action: 'CALLBACK_REQUESTED', entityType: 'HandoffRequest', entityId: request.id });
  return { status: 'CALLBACK_REQUESTED', contact: patient.email };
}
