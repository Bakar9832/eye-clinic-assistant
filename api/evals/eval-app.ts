// The clinic API set up for evals: the eval database, a fixed clock, an inbox that
// captures login codes, and recorders for every tool call and every agent turn.

import { Injectable, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DateTime } from 'luxon';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import type { AgentIdentity } from '../src/agent/agent-token.service.js';
import { AgentClient, HttpAgentClient, type AgentTurnRequest, type AgentTurnResponse } from '../src/chat/agent-client.js';
import { Clock } from '../src/clock.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { ClinicToolsService, type ToolName, type ToolResult } from '../src/mcp/clinic-tools.service.js';
import { EmailSender } from '../src/notifications/email-sender.js';
import { createPrismaClient } from '../src/prisma/create-client.js';
import { FakeClock, FakeInbox } from '../test/harness.js';

export const CLINIC_ZONE = 'Asia/Karachi';
/** Every eval conversation happens on Wednesday 9 January 2030, 08:00 clinic time. */
export const EVAL_NOW = DateTime.fromISO('2030-01-09T08:00', { zone: CLINIC_ZONE }).toJSDate();

export interface ToolCallRecord {
  name: ToolName;
  args: unknown;
  isError: boolean;
}

/** Shared by the recorders below and read by the runner after each conversation. */
export const toolLog: ToolCallRecord[] = [];
export const turnLog: { usage?: Usage }[] = [];

export interface Usage {
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  toolCalls: number;
  models: string[];
}

/** The real tools, with every call written down. */
@Injectable()
export class RecordingTools extends ClinicToolsService {
  override async call(name: ToolName, rawArgs: unknown, who: AgentIdentity): Promise<ToolResult> {
    const result = await super.call(name, rawArgs, who);
    toolLog.push({ name, args: rawArgs, isError: result.isError ?? false });
    return result;
  }
}

/** The real Python agent over HTTP, with each turn's usage written down. */
@Injectable()
export class RecordingHttpAgent extends HttpAgentClient {
  override async turn(req: AgentTurnRequest): Promise<AgentTurnResponse> {
    const res = (await super.turn(req)) as AgentTurnResponse & { usage?: Usage };
    turnLog.push({ usage: res.usage });
    return res;
  }
}

export interface EvalApp {
  app: INestApplication;
  prisma: PrismaClient;
  clock: FakeClock;
  inbox: FakeInbox;
  baseUrl: string;
  http: () => ReturnType<typeof request>;
  browser: () => ReturnType<typeof request.agent>;
}

export async function createEvalApp(options: { databaseUrl: string; agent: AgentClient; port?: number }): Promise<EvalApp> {
  // No background jobs while evals run: the cases are about the chat.
  process.env.NOTIFICATIONS_EVERY_SECONDS = '0';
  process.env.RETENTION_EVERY_HOURS = '0';
  const prisma = createPrismaClient(options.databaseUrl);
  const clock = new FakeClock(EVAL_NOW);
  const inbox = new FakeInbox();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaClient)
    .useValue(prisma)
    .overrideProvider(Clock)
    .useValue(clock)
    .overrideProvider(EmailSender)
    .useValue(inbox)
    .overrideProvider(AgentClient)
    .useValue(options.agent)
    .overrideProvider(ClinicToolsService)
    .useClass(RecordingTools)
    .compile();
  const app = moduleRef.createNestApplication({ logger: ['error'] });
  await app.listen(options.port ?? 0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;

  return {
    app,
    prisma,
    clock,
    inbox,
    baseUrl: `http://127.0.0.1:${port}`,
    http: () => request(app.getHttpServer()),
    browser: () => request.agent(app.getHttpServer()),
  };
}
