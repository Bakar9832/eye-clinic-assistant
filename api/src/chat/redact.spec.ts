import { DOB_HIDDEN, redactDateOfBirth } from './redact.js';

// How Prisma returns a @db.Date: midnight UTC.
const DOB = new Date('1990-01-15T00:00:00Z');

describe('redactDateOfBirth', () => {
  it.each([
    'Please confirm 1990-01-15 in the box.',
    'Please confirm 15/01/1990 in the box.',
    'Please confirm 15/1/1990 in the box.',
    'Please confirm 01/15/1990 in the box.',
    'Please confirm 15-01-1990 in the box.',
    'Please confirm 15.01.1990 in the box.',
    'Please confirm 15 January 1990 in the box.',
    'Please confirm 15th of January, 1990 in the box.',
    'Please confirm January 15, 1990 in the box.',
    'Please confirm Jan 15th 1990 in the box.',
    'Please confirm 15 JANUARY 1990 in the box.',
  ])('hides it written as in: %s', (text) => {
    expect(redactDateOfBirth(text, DOB)).toBe(`Please confirm ${DOB_HIDDEN} in the box.`);
  });

  it('leaves other dates alone: appointments, and dates that only look similar', () => {
    const text = 'Your visit is on 2030-01-15 at 10:00. Born 1990-01-16? Ref EC-1990AB, room 215011990.';
    expect(redactDateOfBirth(text, DOB)).toBe(text);
  });

  it('hides every mention, and does nothing without a date of birth (guests)', () => {
    expect(redactDateOfBirth('1990-01-15 and again 15/01/1990', DOB)).toBe(`${DOB_HIDDEN} and again ${DOB_HIDDEN}`);
    expect(redactDateOfBirth('1990-01-15', null)).toBe('1990-01-15');
  });
});
