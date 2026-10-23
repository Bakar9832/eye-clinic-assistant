import { Global, Module, OnModuleDestroy } from '@nestjs/common';
import { requireEnv } from '../config.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from './create-client.js';

/** Makes one PrismaClient available everywhere. Tests swap it for one on the test database. */
@Global()
@Module({
  providers: [{ provide: PrismaClient, useFactory: () => createPrismaClient(requireEnv('DATABASE_URL')) }],
  exports: [PrismaClient],
})
export class PrismaModule implements OnModuleDestroy {
  constructor(private readonly prisma: PrismaClient) {}

  async onModuleDestroy() {
    await this.prisma.$disconnect();
  }
}
