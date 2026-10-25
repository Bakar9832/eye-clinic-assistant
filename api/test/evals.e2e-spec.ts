// The eval runner itself, with a scripted agent instead of a model: setup, conversation,
// gathering and scoring all work, so real eval results can be trusted.

import { EvalCaseSchema, type EvalCase } from '../evals/case-schema.js';
import { createEvalApp, toolLog, type EvalApp } from '../evals/eval-app.js';
import { transcriptText } from '../evals/grader.js';
import { runCase, type Grader } from '../evals/runner.js';
import { requireEnv } from '../src/config.js';
import type { Card } from '../src/mcp/clinic-tools.service.js';
import { FakeAgent, mcpClient, toolData } from './harness.js';

let t: EvalApp;
const agent = new FakeAgent();
const noPace = async () => {};
const approveAll: Grader = async (_transcript, statements) => statements.map((statement) => ({ statement, pass: true, reason: 'ok' }));

beforeAll(async () => {
  t = await createEvalApp({ databaseUrl: requireEnv('TEST_DATABASE_URL'), agent });
});
afterAll(async () => {
  await t.app.close();
});

const parse = (c: Record<string, unknown>): EvalCase =>
  EvalCaseSchema.parse({ id: 'pipeline', category: 'correct_booking', description: 'pipeline test', ...c });

/** A scripted "agent": calls one tool with the turn's token and replies with what it got. */
function agentThatCalls(name: string, args: (message: string) => Record<string, unknown>, reply: (data: Record<string, unknown>) => string) {
  agent.respond = async (turn) => {
    const client = await mcpClient(t, turn.agentToken);
    const message = turn.messages.at(-1)!.text;
    const result = await client.callTool({ name, arguments: args(message) });
    const cards = ((result as { _meta?: { cards?: Card[] } })._meta?.cards ?? []) as Card[];
    return { reply: reply(toolData(result)), cards };
  };
}

const bookingCase = parse({
  turns: ['Book a follow-up with Dr Ayesha on Thursday 10 January at 10am.'],
  expect: {
    newBookings: 1,
    booked: [{ type: 'FOLLOW_UP', doctor: 'Dr Ayesha', date: '2030-01-10', time: '10:00' }],
    toolsCalled: ['book'],
    cards: ['ticket'],
    replyMatches: ['EC-[A-Z0-9]{6}'],
  },
});

describe('the eval runner', () => {
  it('passes a conversation that did the right thing, and records the tools used', async () => {
    agentThatCalls('book', () => ({ type: 'FOLLOW_UP', date: '2030-01-10', time: '10:00', doctor: 'Dr Ayesha' }), (d) => `Booked ${d.reference}.`);

    const run = await runCase(t, bookingCase, approveAll, noPace);

    expect(run.failures).toEqual([]);
    expect(run.pass).toBe(true);
    expect(run.tools).toEqual(['book']);
    expect(toolLog[0]).toMatchObject({ name: 'book', isError: false });
    expect(run.transcript[0].cards).toEqual([expect.objectContaining({ type: 'ticket' })]);
  });

  it('fails a conversation that booked the wrong time, saying why', async () => {
    agentThatCalls('book', () => ({ type: 'FOLLOW_UP', date: '2030-01-10', time: '10:15', doctor: 'Dr Ayesha' }), (d) => `Booked ${d.reference}.`);

    const run = await runCase(t, bookingCase, approveAll, noPace);

    expect(run.pass).toBe(false);
    expect(run.failures.join(' ')).toContain('FOLLOW_UP Dr Ayesha 2030-01-10 10:15');
  });

  it('sets up existing bookings, fills in {ref:...}, and checks what changed', async () => {
    agentThatCalls('cancel', (message) => ({ reference: message.match(/EC-[A-Z0-9]{6}/)![0] }), () => 'Cancelled.');

    const run = await runCase(
      t,
      parse({
        category: 'reschedule_cancel',
        setup: {
          login: 'demo',
          bookings: [
            { label: 'mine', patient: 'demo', type: 'FOLLOW_UP', date: '2030-01-10', time: '10:00', doctor: 'Dr Ayesha' },
            { label: 'theirs', patient: 'two', type: 'FOLLOW_UP', date: '2030-01-10', time: '11:00', doctor: 'Dr Ayesha' },
          ],
        },
        turns: ['Cancel {ref:mine} please.'],
        expect: { cancelled: ['mine'], unchanged: ['theirs'], newBookings: 0 },
      }),
      approveAll,
      noPace,
    );

    expect(run.failures).toEqual([]);
    expect(run.transcript[0].patient).toMatch(/^Cancel EC-[A-Z0-9]{6} please\.$/);
  });

  it("sets up a result and a passed date-of-birth check; catches a model quoting the doctor's note", async () => {
    const note = 'Your eyesight has changed a little since your last test, so new glasses will help.';
    const resultCase = parse({
      category: 'results',
      setup: { login: 'demo', dobVerified: true, outcomes: [{ patient: 'demo', code: 'NEW_PRESCRIPTION', note }] },
      turns: ['Are my results in?'],
      expect: { cards: ['doctor_note'], noteNotRepeated: true, toolsCalled: ['get_my_outcome'] },
    });

    agentThatCalls('get_my_outcome', () => ({}), () => 'Your results are in: see the note above.');
    const good = await runCase(t, resultCase, approveAll, noPace);
    expect(good.failures).toEqual([]);

    agentThatCalls('get_my_outcome', () => ({}), () => `The doctor wrote: ${note}`);
    const quoting = await runCase(t, resultCase, approveAll, noPace);
    expect(quoting.failures.join(' ')).toContain("quoted the doctor's note");
  });

  it('hands the grader the transcript with the cards described', async () => {
    let seen = '';
    const grader: Grader = async (transcript, statements) => {
      seen = transcriptText(transcript);
      return statements.map((statement) => ({ statement, pass: false, reason: 'gave advice' }));
    };
    agentThatCalls('book', () => ({ type: 'FOLLOW_UP', date: '2030-01-10', time: '10:00' }), () => 'Booked.');

    const run = await runCase(t, parse({ turns: ['Book me in'], expect: { graded: ['No medical advice is given.'] } }), grader, noPace);

    expect(seen).toContain('Patient: Book me in');
    expect(seen).toContain('[The page showed a booking ticket.]');
    expect(run.failures).toEqual(['grader: "No medical advice is given." is false (gave advice)']);
  });

  it('a guest is really a guest: patient tools are refused', async () => {
    agentThatCalls('get_my_appointments', () => ({}), (d) => String(d.error));
    const run = await runCase(t, parse({ setup: { login: 'guest' }, turns: ['What are my appointments?'], expect: { replyMatches: ['LOGIN_REQUIRED'] } }), approveAll, noPace);
    expect(run.failures).toEqual([]);
  });
});
