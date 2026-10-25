import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { NotificationsService } from './notifications.service.js';

/**
 * Runs the notifications every NOTIFICATIONS_EVERY_SECONDS (default 60) inside the API.
 * 0 switches it off: tests and evals do, and call runOnce themselves when they need it.
 * Safe with several API instances: each email is claimed in the database before sending.
 */
@Injectable()
export class NotificationsWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Notifications');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly notifications: NotificationsService) {}

  onApplicationBootstrap() {
    const seconds = Number(process.env.NOTIFICATIONS_EVERY_SECONDS ?? 60);
    if (!(seconds > 0)) return;
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref(); // never keeps the process alive on its own
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return; // a slow run (e.g. a slow mail server) never overlaps the next
    this.running = true;
    try {
      const { sent, failed } = await this.notifications.runOnce();
      if (sent || failed) this.logger.log(`Sent ${sent} email(s), ${failed} failed (retried next run)`);
    } catch (error) {
      this.logger.error(`Notifications run failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
