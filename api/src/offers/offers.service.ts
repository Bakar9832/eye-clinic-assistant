import { Injectable } from '@nestjs/common';
import { Clock } from '../clock.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { OutcomesService } from '../outcomes/outcomes.service.js';

/**
 * "Made once, never pushed": offers that fit the patient's latest outcome and haven't
 * been shown for that outcome yet. Taking them marks them shown.
 */
@Injectable()
export class OffersService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly outcomes: OutcomesService,
    private readonly clock: Clock,
  ) {}

  async takeUnshown(patientId: string) {
    const outcome = await this.outcomes.latestFor(patientId);
    if (!outcome) return [];

    const offers = await this.prisma.offer.findMany({
      where: { active: true, appliesTo: { has: outcome.code }, shown: { none: { outcomeId: outcome.id } } },
      orderBy: { title: 'asc' },
    });
    if (offers.length === 0) return [];

    // The unique (offer, outcome) pair means two parallel calls can't both show the same offer.
    const { count } = await this.prisma.offerShown.createMany({
      data: offers.map((o) => ({ offerId: o.id, outcomeId: outcome.id, shownAt: this.clock.now() })),
      skipDuplicates: true,
    });
    return count === offers.length ? offers : [];
  }
}
