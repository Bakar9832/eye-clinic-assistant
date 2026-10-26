import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { RetentionService } from './retention.service.js';

/**
 * Runs the cleanup when the API starts and then every RETENTION_EVERY_HOURS (default 24).
 * Starting with a run means a PC that is switched off at night still gets cleaned.
 * 0 switches it off: tests and evals do.
 */
@Injectable()
export class RetentionWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Retention');
  private timer?: NodeJS.Timeout;

  constructor(private readonly retention: RetentionService) {}

  onApplicationBootstrap() {
    const hours = Number(process.env.RETENTION_EVERY_HOURS ?? 24);
    if (!(hours > 0)) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), hours * 3_600_000);
    this.timer.unref();
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  private async tick() {
    try {
      const deleted = await this.retention.runOnce();
      this.logger.log(`Deleted ${deleted.chats} chat(s), ${deleted.handoffs} handoff(s), ${deleted.loginCodes} login code(s), ${deleted.sessions} session(s)`);
    } catch (error) {
      this.logger.error(`Cleanup failed: ${(error as Error).message}`);
    }
  }
}
