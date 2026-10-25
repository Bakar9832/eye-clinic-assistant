import { DateTime } from 'luxon';

export const DOB_HIDDEN = '[date of birth hidden]';

/**
 * Removes the patient's own date of birth from the agent's reply, in the ways it is
 * usually written (1990-01-15, 15/01/1990, 15 January 1990, January 15th, 1990, ...).
 *
 * The prompt already says never to repeat it, but a small model sometimes does when the
 * patient types it into the chat. Like identity, the protection lives in the backend, so
 * it holds whatever the model writes. Only this patient's date is touched, and appointment
 * dates can't match: those are in the future, a date of birth is in the past.
 */
export function redactDateOfBirth(text: string, dateOfBirth: Date | null | undefined): string {
  if (!dateOfBirth) return text;
  // A @db.Date column comes back as midnight UTC.
  const d = DateTime.fromJSDate(dateOfBirth, { zone: 'utc' });
  const day = `${d.day}(?:st|nd|rd|th)?`;
  const month = `(?:${d.toFormat('LLLL')}|${d.toFormat('LLL')}\\.?)`;
  const pad = (n: number) => `0?${n}`;
  const numeric = [
    `${d.year}-${d.toFormat('MM')}-${d.toFormat('dd')}`,
    `${pad(d.day)}[/.-]${pad(d.month)}[/.-]${d.year}`,
    `${pad(d.month)}[/.-]${pad(d.day)}[/.-]${d.year}`,
    `${d.year}/${pad(d.month)}/${pad(d.day)}`,
  ];
  const written = [`${day}(?: of)? ${month},? ${d.year}`, `${month} ${day},? ${d.year}`];
  const pattern = new RegExp(`(?<![\\d\\w])(?:${[...numeric, ...written].join('|')})(?![\\d\\w])`, 'gi');
  return text.replace(pattern, DOB_HIDDEN);
}
