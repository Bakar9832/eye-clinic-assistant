import { claimsUrgency, urgentSymptoms } from '../chat/urgent-symptoms.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { recordGuardrail } from './guardrails.js';

const ATTENTION = 'Booked in a chat that mentioned urgent eye symptoms: please contact the patient.';

/**
 * Checks one chat message before the agent sees it, and acts in code:
 * - urgent eye symptoms: one URGENT alert for staff per conversation (Handoffs page) and
 *   a guardrail event; the agent is then told to give the emergency message.
 * - "urgent"/"emergency" without symptoms: logged once per conversation as an urgency
 *   claim. Nothing else changes: the patient is booked normally, never ahead of others.
 * Returns whether this conversation has urgent symptoms (now or earlier).
 */
export async function screenMessage(
  prisma: PrismaClient,
  input: { message: string; patientId: string | null; conversationId: string; at: Date },
): Promise<{ urgent: boolean }> {
  const { message, patientId, conversationId, at } = input;
  const alreadyUrgent = await prisma.handoffRequest.findFirst({ where: { conversationId, kind: 'URGENT' } });
  const symptoms = urgentSymptoms(message);

  if (symptoms.length > 0 && !alreadyUrgent) {
    await prisma.handoffRequest.create({
      data: {
        kind: 'URGENT',
        patientId,
        conversationId,
        // The matched labels, not the patient's words: enough for staff to act on.
        reason: `Urgent eye symptoms mentioned in the chat (${symptoms.join(', ')}). The patient was told to seek emergency care; please contact them.`,
        createdAt: at,
      },
    });
    await recordGuardrail(prisma, {
      kind: 'URGENT_SYMPTOMS',
      patientId,
      conversationId,
      action: 'CHAT',
      reasonCode: 'URGENT_SYMPTOMS',
      message: `Urgent symptoms mentioned (${symptoms.join(', ')}). Staff alerted on the Handoffs page.`,
      at,
    });
    return { urgent: true };
  }

  if (symptoms.length === 0 && !alreadyUrgent && claimsUrgency(message)) {
    const logged = await prisma.guardrailEvent.findFirst({ where: { conversationId, kind: 'URGENCY_CLAIM' } });
    if (!logged) {
      await recordGuardrail(prisma, {
        kind: 'URGENCY_CLAIM',
        patientId,
        conversationId,
        action: 'CHAT',
        reasonCode: 'URGENCY_WORDS',
        message: 'Asked for urgency without urgent symptoms. Booked normally; no priority given.',
        at,
      });
    }
  }
  return { urgent: Boolean(alreadyUrgent) || symptoms.length > 0 };
}

/** A booking made in a conversation with urgent symptoms is flagged for staff ("Attention needed"). */
export async function flagIfUrgentConversation(prisma: PrismaClient, conversationId: string | undefined, appointmentId: string) {
  if (!conversationId) return;
  const urgent = await prisma.handoffRequest.findFirst({ where: { conversationId, kind: 'URGENT' } });
  if (urgent) await prisma.appointment.update({ where: { id: appointmentId }, data: { attentionReason: ATTENTION } });
}
