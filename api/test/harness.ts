// Starts the real app for HTTP tests, with four things swapped: the test database, a
// clock the test controls, an inbox that captures emails, and a fake agent in place of
// the Python service. The app listens on a real port so MCP clients can connect.

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { seedClinic } from '../prisma/clinic-data.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AddressInfo } from 'node:net';
import { AppModule } from '../src/app.module.js';
import { AgentClient, type AgentTurnRequest, type AgentTurnResponse } from '../src/chat/agent-client.js';
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

/** Stands in for the Python agent: records each turn and answers with `respond`. */
export class FakeAgent extends AgentClient {
  turns: AgentTurnRequest[] = [];
  respond: (request: AgentTurnRequest) => Promise<AgentTurnResponse> = async () => ({ reply: 'OK', cards: [] });

  async turn(request: AgentTurnRequest) {
    this.turns.push(request);
    return this.respond(request);
  }

  /** The agent token the API minted for the latest turn. */
  get lastToken() {
    const token = this.turns.at(-1)?.agentToken;
    if (!token) throw new Error('No chat turn has reached the agent yet');
    return token;
  }
}

export interface TestApp {
  app: INestApplication;
  prisma: PrismaClient;
  clock: FakeClock;
  inbox: FakeInbox;
  agent: FakeAgent;
  /** e.g. http://127.0.0.1:53211 */
  baseUrl: string;
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
  const agent = new FakeAgent();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaClient)
    .useValue(prisma)
    .overrideProvider(Clock)
    .useValue(clock)
    .overrideProvider(EmailSender)
    .useValue(inbox)
    .overrideProvider(AgentClient)
    .useValue(agent)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;

  return {
    app,
    prisma,
    clock,
    inbox,
    agent,
    baseUrl: `http://127.0.0.1:${port}`,
    http: () => request(app.getHttpServer()),
    browser: () => request.agent(app.getHttpServer()),
    reset: async () => {
      inbox.sent = [];
      agent.turns = [];
      agent.respond = async () => ({ reply: 'OK', cards: [] });
      clock.set(START);
      return seedClinic(prisma, ZONE);
    },
  };
}

/** Logs a staff member in through the staff door and returns a browser holding the staff cookie. */
export async function staffLogin(t: TestApp, email: string) {
  const browser = t.browser();
  await browser.post('/staff/auth/request-code').send({ email }).expect(202);
  await browser.post('/staff/auth/verify').send({ email, code: t.inbox.lastCode(email) }).expect(200);
  return browser;
}

/** Logs in through the real email-code flow and returns a browser holding the session cookie. */
export async function login(t: Pick<TestApp, 'browser' | 'inbox'>, email: string) {
  const browser = t.browser();
  await browser.post('/auth/request-code').send({ email }).expect(202);
  await browser.post('/auth/verify').send({ email, code: t.inbox.lastCode(email.trim().toLowerCase()) }).expect(200);
  return browser;
}

/** An MCP client that connects the way the Python agent will: agent token in the header. */
export async function mcpClient(t: Pick<TestApp, 'baseUrl'>, agentToken: string) {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${t.baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${agentToken}` } },
    }),
  );
  return client;
}

/** Sends one chat message from this browser and returns the agent token the API minted for it. */
export async function agentTokenFor(t: TestApp, browser: ReturnType<typeof request.agent>, viewerTimezone?: string) {
  await browser.post('/chat').send({ message: 'Hello', ...(viewerTimezone ? { viewerTimezone } : {}) }).expect(200);
  return t.agent.lastToken;
}

/** A tool's answer for the model, parsed from its text content. */
export function toolData(result: unknown): Record<string, unknown> {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}
