// Starts the real app for HTTP tests, with three things swapped:
// the test database, a clock the test controls, and an inbox that captures emails.

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { seedClinic } from '../prisma/clinic-data.js';
import { AppModule } from '../src/app.module.js';
import { Clock } from '../src/clock.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { EmailSender, type Email } from '../src/notifications/email-sender.js';
import { testPrisma } from '../src/testing-db.js';

export const ZONE = 'Asia/Karachi';

export class FakeClock extends Clock {
  constructor(private current: Date) {
    super();
  }
  now() {
    return new Date(this.current);
  }
  set(date: Date) {
    this.current = new Date(date);
  }
  advanceMinutes(minutes: number) {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }
}

export class FakeInbox extends EmailSender {
  sent: Email[] = [];
  async send(email: Email) {
    this.sent.push(email);
  }
  /** The 6-digit code in the latest email to this address. */
  lastCode(to: string): string {
    const email = this.sent.filter((e) => e.to === to).at(-1);
    const code = email?.text.match(/\b(\d{6})\b/)?.[1];
    if (!code) throw new Error(`No login code was emailed to ${to}`);
    return code;
  }
}

export interface TestApp {
  app: INestApplication;
  prisma: PrismaClient;
  clock: FakeClock;
  inbox: FakeInbox;
  /** A fresh client with no cookies. */
  http: () => ReturnType<typeof request>;
  /** A client that keeps cookies between requests, like a browser. */
  browser: () => ReturnType<typeof request.agent>;
  reset: () => Promise<Awaited<ReturnType<typeof seedClinic>>>;
}

/** Tests start on 1 Jan 2030; the bookable test days are after that. */
export const START = new Date('2030-01-01T05:00:00Z');

export async function createTestApp(): Promise<TestApp> {
  const prisma = testPrisma();
  const clock = new FakeClock(START);
  const inbox = new FakeInbox();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaClient)
    .useValue(prisma)
    .overrideProvider(Clock)
    .useValue(clock)
    .overrideProvider(EmailSender)
    .useValue(inbox)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();

  return {
    app,
    prisma,
    clock,
    inbox,
    http: () => request(app.getHttpServer()),
    browser: () => request.agent(app.getHttpServer()),
    reset: async () => {
      inbox.sent = [];
      clock.set(START);
      return seedClinic(prisma, ZONE);
    },
  };
}

/** Logs in through the real email-code flow and returns a browser holding the session cookie. */
export async function login(t: TestApp, email: string) {
  const browser = t.browser();
  await browser.post('/auth/request-code').send({ email }).expect(202);
  await browser.post('/auth/verify').send({ email, code: t.inbox.lastCode(email.trim().toLowerCase()) }).expect(200);
  return browser;
}
