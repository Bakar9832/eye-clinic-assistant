import { Injectable } from '@nestjs/common';
import { AuditService, type Actor } from '../audit/audit.service.js';
import { Clock } from '../clock.js';
import { PrismaClient, type OutcomeCode } from '../generated/prisma/client.js';
import { OutcomesService } from '../outcomes/outcomes.service.js';

/** How long a passed date-of-birth check unlocks results in this session. */
export const DOB_UNLOCK_MINUTES = 15;

export type ResultView =
  | { status: 'NOT_READY' }
  | {
      status: 'READY';
      outcome: OutcomeCode;
      doctorNote: string;
      doctorName: string;
      appointment: { date: string; type: string };
      recordedAt: string;
      edited: boolean;
      editedAt: string | null;
    };

/**
 * Results as the patient sees them. Shared by the website (/me/outcome) and the agent's
 * get_my_outcome tool, so both follow exactly the same rules.
 */
@Injectable()
export class ResultsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly outcomes: OutcomesService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** Did this session pass the date-of-birth check within the last 15 minutes? */
  async isUnlocked(sessionId: string | null): Promise<boolean> {
    if (!sessionId) return false;
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    const unlockedUntil = (session?.dobVerifiedAt?.getTime() ?? 0) + DOB_UNLOCK_MINUTES * 60_000;
    return session !== null && session.revokedAt === null && this.clock.now().getTime() <= unlockedUntil;
  }

  /** The latest result. Callers check isUnlocked first. */
  async latest(patientId: string, actor: Actor): Promise<ResultView> {
    const outcome = await this.outcomes.latestFor(patientId);
    await this.audit.record({ actor, action: 'RESULTS_VIEWED', details: { found: outcome !== null } });
    if (!outcome) return { status: 'NOT_READY' };

    return {
      status: 'READY',
      outcome: outcome.code,
      doctorNote: outcome.patientNote,
      doctorName: outcome.recordedBy.displayName,
      appointment: { date: outcome.appointment.startsAt.toISOString(), type: outcome.appointment.appointmentType.name },
      recordedAt: outcome.recordedAt.toISOString(),
      // The patient is told when a doctor has corrected a result.
      edited: outcome.correctedAt !== null,
      editedAt: outcome.correctedAt?.toISOString() ?? null,
    };
  }
}
