import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Logger, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, IsUUID, Length, Validate } from 'class-validator';
import type { Request, Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import { AgentTokenService } from '../agent/agent-token.service.js';
import { AuthService } from '../auth/auth.service.js';
import { CurrentPatient, SESSION_COOKIE, SessionGuard, type PatientActor } from '../auth/session.guard.js';
import { BookDto } from '../booking/booking.dto.js';
import { BookingService } from '../booking/booking.service.js';
import { clinicSettings } from '../clinic-settings.js';
import { Clock } from '../clock.js';
import { PrismaClient, type Prisma } from '../generated/prisma/client.js';
import { httpError } from '../http/http-error.js';
import { IsTimezone } from '../http/is-timezone.js';
import { doctorOf, ticketCard } from '../mcp/clinic-tools.service.js';
import { AuditService } from '../audit/audit.service.js';
import { requestCallback } from '../guardrails/callbacks.js';
import { recordGuardrail } from '../guardrails/guardrails.js';
import { checkStalled } from '../guardrails/stalling.js';
import { flagIfUrgentConversation, screenMessage } from '../guardrails/urgent.js';
import { AgentClient } from './agent-client.js';
import { redactDateOfBirth } from './redact.js';

const CHAT_LIMIT = { messages: 20, windowMinutes: 10 };
const MAX_MESSAGE_CHARS = 1000;
/** How many earlier messages the agent sees each turn. */
const HISTORY = 20;
/** Anonymous visitors' browsers get a random key, so they can continue their own chat. */
const ANON_COOKIE = 'chat_anon';
const CONVERSATION_ID = /^[0-9a-f-]{36}$/i;
/** What the conversation records for a click on Confirm. */
const CONFIRM_MESSAGE = 'Yes, please book it.';
/** What the "Request a call back" button says for the patient. */
const CALLBACK_MESSAGE = 'Please ask the clinic to call me back.';

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
    private readonly booking: BookingService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
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
    await this.refuseOverDailyCap(owner.patientId, now);

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

    // Urgent symptoms and urgency claims are handled in code before the model sees the message.
    const { urgent } = await screenMessage(this.prisma, { message: body.message, patientId: owner.patientId, conversationId: conversation.id, at: now });

    const settings = await clinicSettings(this.prisma);
    const stalled = await checkStalled(this.prisma, {
      conversationId: conversation.id,
      conversationStartedAt: conversation.createdAt,
      patientId: owner.patientId,
      threshold: settings.stallMessageThreshold,
      at: now,
    });
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
          urgentSymptoms: urgent,
          stalled,
        },
      });
    } catch (error) {
      this.logger.error(`Agent turn failed: ${(error as Error).message}`);
      throw httpError(HttpStatus.SERVICE_UNAVAILABLE, 'AGENT_UNAVAILABLE', 'The assistant is unavailable right now. Please try again.');
    }

    const reply = redactDateOfBirth(turn.reply.trim(), patient?.dateOfBirth) || 'Sorry, I could not answer that. Could you rephrase?';
    // A stalled chat always gets the call-back button, added here so it never depends on the model.
    if (stalled) turn.cards = [...turn.cards, { type: 'callback_offer', loggedIn: owner.patientId !== null }];
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

  /**
   * The Confirm button on a booking offer. The patient's click is the consent, so the
   * model isn't asked again: the booking is made from the session, like the calendar's,
   * and both sides are written into the conversation so the agent knows on its next turn.
   */
  @Post(':id/book')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  async confirm(@Param('id') id: string, @Body() body: BookDto, @CurrentPatient() me: PatientActor) {
    const conversation = CONVERSATION_ID.test(id) ? await this.prisma.conversation.findFirst({ where: { id, patientId: me.id } }) : null;
    if (!conversation) throw httpError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Conversation not found.');

    const booked = await this.booking.book(
      me.id,
      { typeCode: body.typeCode, start: new Date(body.start), doctorId: body.doctorId },
      this.clock.now(),
      { ...me, conversationId: id },
    );
    await flagIfUrgentConversation(this.prisma, id, booked.id);
    const a = await this.prisma.appointment.findUniqueOrThrow({
      where: { id: booked.id },
      include: { appointmentType: true, allocations: { include: { resource: true } } },
    });
    const { timezone } = await clinicSettings(this.prisma);
    const doctor = doctorOf(a);
    const when = DateTime.fromJSDate(a.startsAt, { zone: timezone }).toFormat('cccc d LLLL, h:mm a');
    const reply = `Booked: ${a.appointmentType.name}, ${when} clinic time${doctor ? ` with ${doctor}` : ''}. Your reference is ${a.reference}.`;
    const cards = [ticketCard(a)];

    const at = this.clock.now();
    await this.prisma.$transaction([
      this.prisma.chatMessage.create({ data: { conversationId: id, role: 'USER', text: CONFIRM_MESSAGE, createdAt: at } }),
      this.prisma.chatMessage.create({ data: { conversationId: id, role: 'ASSISTANT', text: reply, cards, createdAt: at } }),
      this.prisma.conversation.update({ where: { id }, data: { lastMessageAt: at } }),
    ]);
    return { conversationId: id, reply, cards };
  }

  /**
   * Opening the chat page wakes the agent service in the background (free hosting puts it
   * to sleep), so the first message doesn't wait for it. Answers at once; no login needed.
   */
  @Post('warm')
  @HttpCode(HttpStatus.ACCEPTED)
  warm() {
    void this.agent.warm();
    return { warming: true };
  }

  /**
   * The "Request a call back" button. Like Confirm, the click is the request: no model in
   * between. Both sides go into the conversation so the agent knows on its next turn.
   */
  @Post(':id/callback')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  async callback(@Param('id') id: string, @CurrentPatient() me: PatientActor) {
    const conversation = CONVERSATION_ID.test(id) ? await this.prisma.conversation.findFirst({ where: { id, patientId: me.id } }) : null;
    if (!conversation) throw httpError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Conversation not found.');

    const at = this.clock.now();
    const result = await requestCallback(this.prisma, this.audit, {
      patientId: me.id,
      conversationId: id,
      reason: 'Asked for a call back with the button in the chat.',
      actor: me,
      at,
    });
    const reply =
      result.status === 'ALREADY_REQUESTED'
        ? `You're already on the list: a member of staff will contact you at ${result.contact}.`
        : `Done. A member of staff will contact you at ${result.contact}.`;
    await this.prisma.$transaction([
      this.prisma.chatMessage.create({ data: { conversationId: id, role: 'USER', text: CALLBACK_MESSAGE, createdAt: at } }),
      this.prisma.chatMessage.create({ data: { conversationId: id, role: 'ASSISTANT', text: reply, createdAt: at } }),
      this.prisma.conversation.update({ where: { id }, data: { lastMessageAt: at } }),
    ]);
    return { conversationId: id, reply, cards: [] };
  }

  /**
   * The site-wide daily cap (ClinicSetting.dailyChatMessageCap, 0 = off): patient messages
   * since clinic midnight, across everyone, so a free LLM quota lasts the day. Checked
   * before anything is saved or the agent is called. Logged once a day for staff.
   */
  private async refuseOverDailyCap(patientId: string | null, now: Date) {
    const { dailyChatMessageCap, timezone } = await clinicSettings(this.prisma);
    if (dailyChatMessageCap <= 0) return;
    const midnight = DateTime.fromJSDate(now, { zone: timezone }).startOf('day').toJSDate();
    const today = await this.prisma.chatMessage.count({ where: { role: 'USER', createdAt: { gte: midnight } } });
    if (today < dailyChatMessageCap) return;

    const logged = await this.prisma.guardrailEvent.findFirst({ where: { kind: 'CHAT_CAP', createdAt: { gte: midnight } } });
    if (!logged) {
      await recordGuardrail(this.prisma, {
        kind: 'CHAT_CAP',
        patientId,
        action: 'CHAT',
        reasonCode: 'DAILY_CAP',
        message: `The daily cap of ${dailyChatMessageCap} chat messages was reached; the assistant said it was busy until tomorrow.`,
        at: now,
      });
    }
    throw httpError(
      HttpStatus.SERVICE_UNAVAILABLE,
      'CHAT_BUSY',
      'The assistant is busy today. You can still book on the Book page, or try the chat again tomorrow.',
    );
  }

  @Get(':id')
  async history(@Param('id') id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const owner = await this.owner(req, res);
    const conversation = CONVERSATION_ID.test(id)
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
