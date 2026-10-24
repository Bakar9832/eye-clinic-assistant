import { Controller, Get } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client.js';

/** Public: what the web page needs before it can show any time or doctor. */
@Controller('clinic')
export class ClinicController {
  constructor(private readonly prisma: PrismaClient) {}

  @Get()
  async info() {
    const [s, doctors] = await Promise.all([
      this.prisma.clinicSetting.findUniqueOrThrow({ where: { id: 1 } }),
      this.prisma.resource.findMany({ where: { kind: 'OPTOMETRIST', active: true }, orderBy: { displayName: 'asc' } }),
    ]);
    return {
      name: s.name,
      timezone: s.timezone,
      slotGridMin: s.slotGridMin,
      // Names and specialities only, for "with Dr Ayesha" choices. Nothing about bookings.
      doctors: doctors.map((d) => ({ id: d.id, displayName: d.displayName, skills: d.skills ?? [] })),
    };
  }
}
