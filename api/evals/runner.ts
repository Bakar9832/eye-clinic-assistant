// Runs one eval case: sets the clinic up, has the conversation through POST /chat exactly as
// the web page would, then gathers what happened and scores it.

import { DateTime } from 'luxon';
import { seedClinic } from '../prisma/clinic-data.js';
import { BookingService } from '../src/booking/booking.service.js';
import { generateReference } from '../src/booking/reference.js';
import type { EvalCase, PatientKey } from './case-schema.js';
import { CLINIC_ZONE, EVAL_NOW, toolLog, turnLog, type EvalApp, type Usage } from './eval-app.js';
import { score, type ApptView, type RunRecord, type Score } from './score.js';
import { login } from '../test/harness.js';

const EMAIL: Record<PatientKey | 'new', string> = {
  demo: 'demo.patient@example.com',
  two: 'test.two@example.com',
  three: 'test.three@example.com',
  new: 'new.person@example.com',
};
const DOB: Record<PatientKey, string> = { demo: '1990-01-15', two: '1985-06-02', three: '2016-09-20' };

/** A transcript for the grader. Cards are described, so it knows the page showed them. */
export interface Exchange {
  patient: string;
  assistant: string;
  cards: { type: string }[];
}

export type Grader = (transcript: Exchange[], statements: string[]) => Promise<{ statement: string; pass: boolean; reason: string }[]>;

/** Paces model calls to stay inside free-tier limits. */
export type Pace = (expectedCalls: number) => Promise<void>;

export interface CaseRun extends Score {
  transcript: Exchange[];
  tools: string[];
  latencyMs: number[];
  usage: Usage;
}

const local = (date: string, time: string) => DateTime.fromISO(`${date}T${time}`, { zone: CLINIC_ZONE }).toJSDate();

/**
 * The model couldn't be reached (quota used up, outage). Not the agent's fault, so it must
 * never be scored as a failed case: the run stops instead.
 */
export class ModelUnavailable extends Error {}

export async function runCase(t: EvalApp, evalCase: EvalCase, grade: Grader, pace: Pace): Promise<CaseRun> {
  const { setup } = evalCase;

  // --- 1. A fresh clinic, at the eval moment ---------------------------------
  const clinic = await seedClinic(t.prisma, CLINIC_ZONE);
  t.clock.set(EVAL_NOW);
  t.inbox.sent = [];
  toolLog.length = 0;
  turnLog.length = 0;

  const patientIds: Record<string, string> = {
    demo: clinic.patients.demo.id,
    two: clinic.patients.two.id,
    three: clinic.patients.three.id,
  };
  const doctorIds: Record<string, string> = {
    'Dr Ayesha': clinic.resources.ayesha.id,
    'Dr Bilal': clinic.resources.bilal.id,
  };

  // --- 2. Past results ---------------------------------------------------------
  for (const outcome of setup.outcomes) {
    const start = local('2030-01-02', '11:00'); // last Wednesday
    await t.prisma.appointment.create({
      data: {
        reference: generateReference(),
        patientId: patientIds[outcome.patient],
        appointmentTypeId: clinic.types.ROUTINE_EYE_TEST.id,
        startsAt: start,
        endsAt: new Date(start.getTime() + 30 * 60_000),
        status: 'COMPLETED',
        allocations: {
          create: [
            { resourceId: clinic.resources.sara.id, startsAt: start, endsAt: new Date(start.getTime() + 10 * 60_000) },
            { resourceId: clinic.resources.ayesha.id, startsAt: new Date(start.getTime() + 10 * 60_000), endsAt: new Date(start.getTime() + 30 * 60_000) },
          ],
        },
        outcome: {
          create: {
            code: outcome.code,
            patientNote: outcome.note,
            recordedByStaffId: clinic.staff.drAyesha.id,
            recordedAt: new Date(start.getTime() + 40 * 60_000),
          },
        },
      },
    });
  }

  // --- 3. Existing bookings ----------------------------------------------------
  const booking = t.app.get(BookingService);
  const labelIds: Record<string, string> = {};
  const references: Record<string, string> = {};
  for (const b of setup.bookings) {
    const created = await booking.book(
      patientIds[b.patient],
      { typeCode: b.type, start: local(b.date, b.time), doctorId: b.doctor ? doctorIds[b.doctor] : undefined },
      EVAL_NOW,
    );
    labelIds[b.label] = created.id;
    references[b.label] = created.reference;
  }

  // --- 4. Who is chatting --------------------------------------------------------
  const browser = setup.login === 'guest' ? t.browser() : await login(t, EMAIL[setup.login]);
  if (setup.dobVerified && setup.login !== 'guest' && setup.login !== 'new') {
    await browser.post('/me/verify-dob').send({ dateOfBirth: DOB[setup.login] }).expect(200);
  }
  if (setup.login === 'new') {
    const created = await t.prisma.patient.findUniqueOrThrow({ where: { email: EMAIL.new } });
    patientIds.new = created.id;
  }

  const before = new Set((await t.prisma.appointment.findMany({ select: { id: true } })).map((a) => a.id));
  const labelledBefore = await viewsById(t, Object.values(labelIds), patientIds);
  const handoffsBefore = await t.prisma.handoffRequest.count();
  const offersBefore = await t.prisma.offerShown.count();

  // --- 5. The conversation ---------------------------------------------------------
  const transcript: Exchange[] = [];
  const latencyMs: number[] = [];
  let conversationId: string | undefined;
  for (const raw of evalCase.turns) {
    const message = raw.replace(/\{ref:([a-z0-9-]+)\}/gi, (_, name: string) => references[name] ?? `{unknown ref ${name}}`);
    await pace(4);
    const started = Date.now();
    const res = await browser
      .post('/chat')
      .send({ message, viewerTimezone: CLINIC_ZONE, ...(conversationId ? { conversationId } : {}) });
    latencyMs.push(Date.now() - started);
    if (res.status === 200) {
      conversationId = res.body.conversationId;
      transcript.push({ patient: message, assistant: res.body.reply, cards: res.body.cards });
    } else if (res.body?.error === 'AGENT_UNAVAILABLE') {
      throw new ModelUnavailable(`The model was unavailable during "${evalCase.id}" (likely the daily quota).`);
    } else {
      transcript.push({ patient: message, assistant: `[chat failed: HTTP ${res.status} ${res.body?.error ?? ''}]`, cards: [] });
    }
  }

  // --- 6. What happened ---------------------------------------------------------------
  const createdIds = (await t.prisma.appointment.findMany({ select: { id: true } })).map((a) => a.id).filter((id) => !before.has(id));
  const labelledAfter = await viewsById(t, Object.values(labelIds), patientIds);
  const labelled = Object.fromEntries(
    Object.entries(labelIds).map(([label, id]) => [label, { before: labelledBefore[id], after: labelledAfter[id] }]),
  );

  let graded: RunRecord['graded'] = [];
  if (evalCase.expect.graded?.length) {
    await pace(1);
    try {
      graded = await grade(transcript, evalCase.expect.graded);
    } catch (error) {
      throw new ModelUnavailable(`The grader model was unavailable during "${evalCase.id}": ${(error as Error).message}`);
    }
  }

  const record: RunRecord = {
    replies: transcript.map((e) => e.assistant),
    cards: transcript.flatMap((e) => e.cards),
    tools: toolLog.map((c) => ({ name: c.name, isError: c.isError })),
    created: Object.values(await viewsById(t, createdIds, patientIds)),
    labelled,
    handoffs: (await t.prisma.handoffRequest.count()) - handoffsBefore,
    offersShown: (await t.prisma.offerShown.count()) - offersBefore,
    notes: setup.outcomes.map((o) => o.note),
    graded,
  };

  const usage = turnLog.reduce<Usage>(
    (sum, turn) => ({
      llmCalls: sum.llmCalls + (turn.usage?.llmCalls ?? 0),
      promptTokens: sum.promptTokens + (turn.usage?.promptTokens ?? 0),
      completionTokens: sum.completionTokens + (turn.usage?.completionTokens ?? 0),
      toolCalls: sum.toolCalls + (turn.usage?.toolCalls ?? 0),
      models: [...sum.models, ...(turn.usage?.models ?? [])],
    }),
    { llmCalls: 0, promptTokens: 0, completionTokens: 0, toolCalls: 0, models: [] },
  );

  const chattingAs = setup.login === 'guest' ? '(guest)' : setup.login;
  return { ...score(evalCase, record, chattingAs), transcript, tools: record.tools.map((t) => t.name), latencyMs, usage };
}

/** Appointments as the checks see them: patient key, type, doctor, clinic date and time. */
async function viewsById(t: EvalApp, ids: string[], patientIds: Record<string, string>): Promise<Record<string, ApptView>> {
  if (ids.length === 0) return {};
  const keyOf = Object.fromEntries(Object.entries(patientIds).map(([key, id]) => [id, key]));
  const rows = await t.prisma.appointment.findMany({
    where: { id: { in: ids } },
    include: { appointmentType: true, allocations: { include: { resource: true } } },
  });
  return Object.fromEntries(
    rows.map((a) => {
      const start = DateTime.fromJSDate(a.startsAt, { zone: CLINIC_ZONE });
      const doctor = a.allocations.find((x) => x.resource.kind === 'OPTOMETRIST' && x.startsAt >= a.startsAt && x.endsAt <= a.endsAt);
      return [
        a.id,
        {
          patient: keyOf[a.patientId] ?? a.patientId,
          type: a.appointmentType.code,
          doctor: doctor?.resource.displayName ?? null,
          date: start.toISODate()!,
          time: start.toFormat('HH:mm'),
          status: a.status,
        },
      ];
    }),
  );
}
