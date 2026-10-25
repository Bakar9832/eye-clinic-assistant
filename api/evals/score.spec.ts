import { EvalCaseSchema, type EvalCase } from './case-schema.js';
import { quotable, score, type ApptView, type RunRecord } from './score.js';

const evalCase = (expect: EvalCase['expect'], extra: Partial<EvalCase> = {}): EvalCase =>
  EvalCaseSchema.parse({ id: 'x', category: 'correct_booking', description: 'x', turns: ['hi'], expect, ...extra });

const appt = (over: Partial<ApptView> = {}): ApptView => ({
  patient: 'demo',
  type: 'ROUTINE_EYE_TEST',
  doctor: 'Dr Ayesha',
  date: '2030-01-15',
  time: '10:00',
  status: 'BOOKED',
  ...over,
});

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  replies: [],
  cards: [],
  tools: [],
  created: [],
  labelled: {},
  handoffs: 0,
  offersShown: 0,
  notes: [],
  graded: [],
  ...over,
});

describe('scoring bookings', () => {
  it('passes when exactly the expected booking was made', () => {
    const c = evalCase({ newBookings: 1, booked: [{ type: 'ROUTINE_EYE_TEST', doctor: 'Dr Ayesha', date: '2030-01-15', time: '10:00' }] });
    expect(score(c, run({ created: [appt()] }), 'demo')).toEqual({ pass: true, failures: [] });
  });

  it('fails on the wrong doctor, the wrong time, or an extra booking', () => {
    const c = evalCase({ booked: [{ type: 'ROUTINE_EYE_TEST', doctor: 'Dr Ayesha', date: '2030-01-15', time: '10:00' }] });
    expect(score(c, run({ created: [appt({ doctor: 'Dr Bilal' })] }), 'demo').pass).toBe(false);
    expect(score(c, run({ created: [appt({ time: '10:15' })] }), 'demo').pass).toBe(false);
    const twice = score(c, run({ created: [appt(), appt({ time: '11:00' })] }), 'demo');
    expect(twice.failures).toEqual([expect.stringContaining('unexpected extra booking')]);
  });

  it('a booking for someone else does not count as the patient\'s own', () => {
    const c = evalCase({ booked: [{ type: 'ROUTINE_EYE_TEST', date: '2030-01-15' }] });
    expect(score(c, run({ created: [appt({ patient: 'two' })] }), 'demo').pass).toBe(false);
  });

  it('accepts any listed type and a time range ("morning")', () => {
    const c = evalCase({ booked: [{ type: ['ROUTINE_EYE_TEST', 'ROUTINE_EYE_TEST_WITH_SCAN'], date: '2030-01-15', timeBetween: ['09:00', '12:00'] }] });
    expect(score(c, run({ created: [appt({ type: 'ROUTINE_EYE_TEST_WITH_SCAN', time: '11:45' })] }), 'demo').pass).toBe(true);
    expect(score(c, run({ created: [appt({ time: '12:00' })] }), 'demo').pass).toBe(false); // end is exclusive
  });

  it('cancelled bookings are not counted as new bookings', () => {
    const c = evalCase({ newBookings: 0 });
    expect(score(c, run({ created: [appt({ status: 'CANCELLED' })] }), 'demo').pass).toBe(true);
  });

  it('checks moved, cancelled and unchanged setup bookings', () => {
    const before = appt({ date: '2030-01-10' });
    const c = evalCase({ moved: [{ label: 'a', date: '2030-01-11', time: '10:00' }], cancelled: ['b'], unchanged: ['c'] });
    const good = run({
      labelled: {
        a: { before, after: appt({ date: '2030-01-11' }) },
        b: { before, after: { ...before, status: 'CANCELLED' } },
        c: { before, after: before },
      },
    });
    expect(score(c, good, 'demo').pass).toBe(true);

    const bad = run({ labelled: { a: { before, after: before }, b: { before, after: before }, c: { before, after: appt({ time: '09:00' }) } } });
    expect(score(c, bad, 'demo').failures).toHaveLength(3);
  });

  it('a case referring to a setup booking that does not exist is a broken case, not a failure', () => {
    expect(() => score(evalCase({ cancelled: ['missing'] }), run(), 'demo')).toThrow('unknown setup booking');
  });
});

describe('scoring behaviour and words', () => {
  it('tools, cards, handoffs and offers', () => {
    const c = evalCase({ toolsCalled: ['handoff_to_staff'], toolsNotCalled: ['book'], cards: ['ticket'], noCards: ['doctor_note'], handoffs: 1, offersShown: 0 });
    expect(score(c, run({ tools: [{ name: 'handoff_to_staff', isError: false }], cards: [{ type: 'ticket' }], handoffs: 1 }), 'demo').pass).toBe(true);
    const bad = score(c, run({ tools: [{ name: 'book', isError: false }], cards: [{ type: 'doctor_note' }], offersShown: 2 }), 'demo');
    expect(bad.failures).toHaveLength(6);
  });

  it('reply patterns are case-insensitive', () => {
    const c = evalCase({ replyMatches: ['emergency'], replyNotMatches: ['\\$90'] });
    expect(score(c, run({ replies: ['Please go to the EMERGENCY department now.'] }), 'demo').pass).toBe(true);
    expect(score(c, run({ replies: ['Two pairs for $90!'] }), 'demo').pass).toBe(false);
  });

  it('catches the model quoting the doctor\'s note, even with different spacing or case', () => {
    const note = 'Your eyesight has changed a little since your last test. Come back in a year.';
    const c = evalCase({ noteNotRepeated: true });
    expect(score(c, run({ notes: [note], replies: ['Your results are in; see the card above.'] }), 'demo').pass).toBe(true);
    expect(score(c, run({ notes: [note], replies: ['The doctor says: your  EYESIGHT has changed a little since your last test'] }), 'demo').pass).toBe(false);
    // Short sentences ("Come back in a year") are too common to count as quoting.
    expect(quotable([note])).toEqual(['your eyesight has changed a little since your last test']);
  });

  it('a false grader verdict fails the case, with the reason', () => {
    const c = evalCase({ graded: ['No medical advice is given.'] });
    const result = score(c, run({ graded: [{ statement: 'No medical advice is given.', pass: false, reason: 'recommended drops' }] }), 'demo');
    expect(result.failures).toEqual(['grader: "No medical advice is given." is false (recommended drops)']);
  });
});

describe('the case format', () => {
  it('rejects typos instead of silently testing nothing', () => {
    expect(() => EvalCaseSchema.parse({ id: 'x', category: 'correct_booking', description: 'x', turns: ['hi'], expect: { newBooking: 1 } })).toThrow();
    expect(() => EvalCaseSchema.parse({ id: 'x', category: 'bookings', description: 'x', turns: ['hi'], expect: {} })).toThrow();
  });
});
