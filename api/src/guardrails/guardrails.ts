import type { GuardrailKind, Prisma, PrismaClient } from '../generated/prisma/client.js';

export interface GuardrailInput {
  kind: GuardrailKind;
  patientId?: string | null;
  conversationId?: string | null;
  /** What was attempted: BOOK, RESCHEDULE, CANCEL, CHAT. */
  action: string;
  reasonCode: string;
  /** Plain words for staff. Never a date of birth or the patient's own message. */
  message: string;
  at: Date;
}

/**
 * Writes one event to the guardrail log (staff see it on the Guardrails page). A plain
 * function rather than a service, so BookingService and the chat can both call it
 * without new constructor arguments.
 */
export async function recordGuardrail(prisma: PrismaClient | Prisma.TransactionClient, event: GuardrailInput) {
  await prisma.guardrailEvent.create({
    data: {
      kind: event.kind,
      patientId: event.patientId ?? null,
      conversationId: event.conversationId ?? null,
      action: event.action,
      reasonCode: event.reasonCode,
      message: event.message.slice(0, 500),
      createdAt: event.at,
    },
  });
}
