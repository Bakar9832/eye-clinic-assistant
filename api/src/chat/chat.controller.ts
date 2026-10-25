import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Logger, Param, Post, Req, Res } from '@nestjs/common';
import { IsOptional, IsString, IsUUID, Length, Validate, ValidatorConstraint, type ValidatorConstraintInterface } from 'class-validator';
import type { Request, Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { DateTime, IANAZone } from 'luxon';
import { AgentTokenService } from '../agent/agent-token.service.js';
import { AuthService } from '../auth/auth.service.js';
import { SESSION_COOKIE } from '../auth/session.guard.js';
import { Clock } from '../clock.js';
import { PrismaClient, type Prisma } from '../generated/prisma/client.js';
import { httpError } from '../http/http-error.js';
import { AgentClient } from './agent-client.js';
import { redactDateOfBirth } from './redact.js';

export const CHAT_LIMIT = { messages: 20, windowMinutes: 10 };
export const MAX_MESSAGE_CHARS = 1000;
/** How many earlier messages the agent sees each turn. */
const HISTORY = 20;
/** Anonymous visitors' browsers get a random key, so they can continue their own chat. */
const ANON_COOKIE = 'chat_anon';

@ValidatorConstraint({ name: 'timezone' })
class IsTimezone implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return typeof value === 'string' && IANAZone.isValidZone(value);
  }
  defaultMessage() {
    return 'viewerTimezone must be an IANA zone such as Europe/London';
  }
}

class ChatDto {
  @IsString()
  @Length(1, MAX_MESSAGE_CHARS, { message: `message must be 1-${MAX_MESSAGE_CHARS} characters` })
  message!: string;

  @IsOptional()
  @IsUUID()
  conversationId?: string;

  /** Detected by the browser; only used to show times in the viewer's zone too. */
  @IsOptional()
  @Validate(IsTimezone)
  viewerTimezone?: string;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * The chat. Open to everyone; what the agent can do depends on who is logged in. The
 * API decides who that is (session cookie) and puts it in a 5-minute agent token. The
 * agent and the model only ever carry that token; they never name a patient.
 */
@Controller('chat')
export class ChatController {
  private readonly logger = new Logger('Chat');

  constructor(
    private readonly prisma: PrismaClient,
    private readonly auth: AuthService,
    private readonly tokens: AgentTokenService,
    private readonly agent: AgentClient,
    private readonly clock: Clock,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async send(@Body() body: ChatDto, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Ip() ip: string) {
    const owner = await this.owner(req, res);
    const now = this.clock.now();

    // Per visitor and per IP, so one person can't run up the LLM bill.
    const since = new Date(now.getTime() - CHAT_LIMIT.windowMinutes * 60_000);
    const recent = await this.prisma.chatMessage.count({
      where: {
        role: 'USER',
        createdAt: { gt: since },
        OR: [{ conversation: owner.where }, { requestIp: ip }],
      },
    });
    if (recent >= CHAT_LIMIT.messages) {
      throw httpError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', 'Too many messages. Please wait a few minutes.');
    }

    const conversation = body.conversationId
      ? await this.prisma.conversation.findFirst({ where: { id: body.conversationId, ...owner.where } })
      : await this.prisma.conversation.create({ data: { ...owner.where, createdAt: now, lastMessageAt: now } });
    // Someone else's conversation looks exactly like a missing one.
    if (!conversation) throw httpError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Conversation not found.');

    await this.prisma.chatMessage.create({
      data: { conversationId: conversation.id, role: 'USER', text: body.message, requestIp: ip, createdAt: now },
    });
    const history = (
      await this.prisma.chatMessage.findMany({
        where: { conversationId: conversation.id },
        orderBy: { seq: 'desc' },
        take: HISTORY,
      })
    ).reverse();

    const settings = await this.prisma.clinicSetting.findUniqueOrThrow({ where: { id: 1 } });
    const patient = owner.patientId ? await this.prisma.patient.findUnique({ where: { id: owner.patientId } }) : null;
    const viewerTimezone = body.viewerTimezone ?? patient?.timezone ?? settings.timezone;
    const today = DateTime.fromJSDate(now, { zone: settings.timezone });

    let turn;
    try {
      turn = await this.agent.turn({
        messages: history.map((m) => ({ role: m.role === 'USER' ? 'user' : 'assistant', text: m.text })),
        agentToken: this.tokens.mint({
          patientId: owner.patientId,
          sessionId: owner.sessionId,
          conversationId: conversation.id,
          viewerTimezone,
        }),
        context: {
          clinicName: settings.name,
          clinicTimezone: settings.timezone,
          today: today.toISODate()!,
          weekday: today.toFormat('cccc'),
          viewerTimezone,
          loggedIn: owner.patientId !== null,
        },
      });
    } catch (error) {
      this.logger.error(`Agent turn failed: ${(error as Error).message}`);
      throw httpError(HttpStatus.SERVICE_UNAVAILABLE, 'AGENT_UNAVAILABLE', 'The assistant is unavailable right now. Please try again.');
    }

    const reply = redactDateOfBirth(turn.reply.trim(), patient?.dateOfBirth) || 'Sorry, I could not answer that. Could you rephrase?';
    const answeredAt = this.clock.now();
    await this.prisma.$transaction([
      this.prisma.chatMessage.create({
        data: {
          conversationId: conversation.id,
          role: 'ASSISTANT',
          text: reply,
          cards: turn.cards.length ? (turn.cards as unknown as Prisma.InputJsonArray) : undefined,
          createdAt: answeredAt,
        },
      }),
      this.prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: answeredAt } }),
    ]);
    return { conversationId: conversation.id, reply, cards: turn.cards };
  }

  @Get(':id')
  async history(@Param('id') id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const owner = await this.owner(req, res);
    const conversation = /^[0-9a-f-]{36}$/i.test(id)
      ? await this.prisma.conversation.findFirst({
          where: { id, ...owner.where },
          include: { messages: { orderBy: { seq: 'asc' } } },
        })
      : null;
    if (!conversation) throw httpError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Conversation not found.');
    return conversation.messages.map((m) => ({
      role: m.role === 'USER' ? 'user' : 'assistant',
      text: m.text,
      cards: m.cards ?? [],
      at: m.createdAt.toISOString(),
    }));
  }

  /** Whose chat this is: the logged-in patient, or this browser if nobody is logged in. */
  private async owner(req: Request, res: Response) {
    const session = await this.auth.findSession(req.cookies?.[SESSION_COOKIE]);
    if (session?.patientId) {
      return { patientId: session.patientId, sessionId: session.id, where: { patientId: session.patientId } };
    }

    let key: string | undefined = req.cookies?.[ANON_COOKIE];
    if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key)) {
      key = randomBytes(32).toString('base64url');
      res.cookie(ANON_COOKIE, key, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/chat',
        maxAge: 30 * 24 * 60 * 60_000,
      });
    }
    return { patientId: null, sessionId: null, where: { anonKeyHash: hash(key) } };
  }
}
