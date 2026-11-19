import type { PrismaClient } from '../generated/prisma/client.js';
import { recordGuardrail } from './guardrails.js';

/** What counts as progress: the patient booked, moved or cancelled something. */
const PROGRESS = ['APPOINTMENT_BOOKED', 'APPOINTMENT_RESCHEDULED', 'APPOINTMENT_CANCELLED'];

/**
 * Is this conversation going round in circles? Counted in code, not judged by the model:
 * the messages (both sides) since the chat started or since the patient's last booking,
 * move or cancel. At ClinicSetting.stallMessageThreshold (0 = off) it is stalled; this
 * returns true once per stall (a STALLED guardrail event marks it), so the summary and
 * the call-back offer come once, not on every later message. Progress starts a new count.
 */
export async function checkStalled(
  prisma: PrismaClient,
  input: { conversationId: string; conversationStartedAt: Date; patientId: string | null; threshold: number; at: Date },
): Promise<boolean> {
  const { conversationId, conversationStartedAt, patientId, threshold, at } = input;
  if (threshold <= 0) return false;

  const progress = patientId
    ? await prisma.auditEvent.findFirst({
        where: { actorType: 'PATIENT', actorId: patientId, action: { in: PROGRESS }, at: { gte: conversationStartedAt } },
        orderBy: { at: 'desc' },
      })
    : null;
  const since = progress?.at ?? new Date(conversationStartedAt.getTime() - 1);

  const messages = await prisma.chatMessage.count({ where: { conversationId, createdAt: { gt: since } } });
  if (messages < threshold) return false;

  const offered = await prisma.guardrailEvent.findFirst({ where: { conversationId, kind: 'STALLED', createdAt: { gt: since } } });
  if (offered) return false;

  await recordGuardrail(prisma, {
    kind: 'STALLED',
    patientId,
    conversationId,
    action: 'CHAT',
    reasonCode: 'NO_PROGRESS',
    message: `${messages} messages without a booking, move or cancel. The patient was offered a call back.`,
    at,
  });
  return true;
}
