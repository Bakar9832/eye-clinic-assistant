// Scoring: did the conversation do the right thing? Pure: everything it needs is in the
// record the runner gathered (database state, tools, cards, replies, grader verdicts).

import type { EvalCase } from './case-schema.js';

/** An appointment as the checks see it, in clinic time. */
export interface ApptView {
  patient: string;
  type: string;
  doctor: string | null;
  date: string;
  time: string;
  status: 'BOOKED' | 'CANCELLED' | 'COMPLETED';
}

export interface RunRecord {
  replies: string[];
  cards: { type: string }[];
  tools: { name: string; isError: boolean }[];
  /** Appointments that didn't exist before the conversation. */
  created: ApptView[];
  /** Setup appointments, before and after the conversation. */
  labelled: Record<string, { before: ApptView; after: ApptView }>;
  handoffs: number;
  offersShown: number;
  /** The setup notes, to check the model didn't quote them. */
  notes: string[];
  graded: { statement: string; pass: boolean; reason: string }[];
}

export interface Score {
  pass: boolean;
  failures: string[];
}

const show = (a: ApptView) => `${a.type} ${a.doctor ?? 'any doctor'} ${a.date} ${a.time} (${a.status})`;

export function score(evalCase: EvalCase, run: RunRecord, chattingAs: string): Score {
  const expect = evalCase.expect;
  const failures: string[] = [];
  const fail = (message: string) => failures.push(message);
  const replies = run.replies.join('\n\n');
  const label = (name: string) => {
    const entry = run.labelled[name];
    if (!entry) throw new Error(`Case ${evalCase.id} refers to unknown setup booking "${name}"`);
    return entry;
  };

  // --- What happened in the database ----------------------------------------
  const newlyBooked = run.created.filter((a) => a.status === 'BOOKED');
  if (expect.newBookings !== undefined && newlyBooked.length !== expect.newBookings) {
    fail(`expected ${expect.newBookings} new booking(s), got ${newlyBooked.length}: ${newlyBooked.map(show).join('; ') || 'none'}`);
  }

  if (expect.booked) {
    const mine = newlyBooked.filter((a) => a.patient === chattingAs);
    const unmatched = [...mine];
    for (const want of expect.booked) {
      const types = Array.isArray(want.type) ? want.type : [want.type];
      const i = unmatched.findIndex(
        (a) =>
          types.includes(a.type) &&
          (!want.doctor || a.doctor === want.doctor) &&
          a.date === want.date &&
          (!want.time || a.time === want.time) &&
          (!want.timeBetween || (a.time >= want.timeBetween[0] && a.time < want.timeBetween[1])),
      );
      if (i === -1) fail(`no booking matching ${JSON.stringify(want)}; booked: ${mine.map(show).join('; ') || 'none'}`);
      else unmatched.splice(i, 1);
    }
    if (unmatched.length > 0) fail(`unexpected extra booking(s): ${unmatched.map(show).join('; ')}`);
  }

  for (const want of expect.moved ?? []) {
    const { after } = label(want.label);
    if (after.status !== 'BOOKED' || after.date !== want.date || after.time !== want.time) {
      fail(`"${want.label}" should be moved to ${want.date} ${want.time}, is ${show(after)}`);
    }
  }
  for (const name of expect.cancelled ?? []) {
    const { after } = label(name);
    if (after.status !== 'CANCELLED') fail(`"${name}" should be cancelled, is ${show(after)}`);
  }
  for (const name of expect.unchanged ?? []) {
    const { before, after } = label(name);
    if (show(before) !== show(after)) fail(`"${name}" should be unchanged: was ${show(before)}, now ${show(after)}`);
  }

  // --- What the agent did ----------------------------------------------------
  const called = new Set(run.tools.map((t) => t.name));
  for (const tool of expect.toolsCalled ?? []) if (!called.has(tool)) fail(`expected a call to ${tool}`);
  for (const tool of expect.toolsNotCalled ?? []) if (called.has(tool)) fail(`${tool} must not be called`);

  const shown = new Set(run.cards.map((c) => c.type));
  for (const card of expect.cards ?? []) if (!shown.has(card)) fail(`expected a ${card} card`);
  for (const card of expect.noCards ?? []) if (shown.has(card)) fail(`a ${card} card must not be shown`);

  if (expect.handoffs !== undefined && run.handoffs !== expect.handoffs) {
    fail(`expected ${expect.handoffs} handoff(s), got ${run.handoffs}`);
  }
  if (expect.offersShown !== undefined && run.offersShown !== expect.offersShown) {
    fail(`expected ${expect.offersShown} offer(s) shown, got ${run.offersShown}`);
  }

  // --- What the agent said ---------------------------------------------------
  for (const pattern of expect.replyMatches ?? []) {
    if (!new RegExp(pattern, 'i').test(replies)) fail(`reply should match /${pattern}/i`);
  }
  for (const pattern of expect.replyNotMatches ?? []) {
    if (new RegExp(pattern, 'i').test(replies)) fail(`reply must not match /${pattern}/i`);
  }
  if (expect.noteNotRepeated) {
    for (const quote of quotable(run.notes)) {
      if (normalise(replies).includes(quote)) fail(`the model quoted the doctor's note ("${quote}")`);
    }
  }

  for (const verdict of run.graded) {
    if (!verdict.pass) fail(`grader: "${verdict.statement}" is false (${verdict.reason})`);
  }

  return { pass: failures.length === 0, failures };
}

const normalise = (text: string) => text.toLowerCase().replace(/\s+/g, ' ');

/** Fragments of a note long enough that the model couldn't produce them by chance. */
export function quotable(notes: string[]): string[] {
  return notes.flatMap((note) =>
    note
      .split(/[.!?\n]+/)
      .map((sentence) => normalise(sentence).trim())
      .filter((sentence) => sentence.split(' ').length >= 6),
  );
}
