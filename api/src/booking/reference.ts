import { randomInt } from 'node:crypto';

// No 0/O or 1/I/L, so codes can be read aloud or typed from a ticket without mix-ups.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Booking ticket code, e.g. "EC-7K3QFM". Uniqueness is enforced by the database. */
export function generateReference(): string {
  let code = '';
  for (let i = 0; i < 6; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return `EC-${code}`;
}
