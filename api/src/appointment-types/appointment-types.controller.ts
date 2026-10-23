import { Controller, Get } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client.js';

/** Public: what can be booked, how long it takes and how to prepare. */
@Controller('appointment-types')
export class AppointmentTypesController {
  constructor(private readonly prisma: PrismaClient) {}

  @Get()
  async list() {
    const types = await this.prisma.appointmentType.findMany({
      where: { active: true },
      include: { steps: { orderBy: { position: 'asc' } } },
      orderBy: { name: 'asc' },
    });

    return types.map((t) => ({
      code: t.code,
      name: t.name,
      /** What the patient is told. */
      typicalMin: t.typicalMin,
      /** Calendar time actually blocked: where the last step ends. */
      calendarMin: Math.max(...t.steps.map((s) => s.offsetMin + s.durationMin)),
      isUrgent: t.isUrgent,
      prepInstructions: t.prepInstructions,
      steps: t.steps.map((s) => ({
        position: s.position,
        resourceKind: s.resourceKind,
        requiredSkill: s.requiredSkill,
        offsetMin: s.offsetMin,
        durationMin: s.durationMin,
      })),
    }));
  }
}
