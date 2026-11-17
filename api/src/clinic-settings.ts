import type { PrismaClient } from './generated/prisma/client.js';

/** The clinic's settings: a single row, id 1. */
export const clinicSettings = (prisma: PrismaClient) => prisma.clinicSetting.findUniqueOrThrow({ where: { id: 1 } });
