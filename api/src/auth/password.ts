import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt (built into Node, so no native module to compile).
 *
 * scrypt is deliberately slow AND memory-hungry: each guess needs ~64 MB of RAM, which
 * makes cracking a stolen hash on GPUs expensive. Parameters are OWASP's scrypt option
 * N=2^16, r=8, p=2 (2^17 would need 128 MB per login; Render's free plan has 512 MB).
 *
 * Stored as `scrypt$N$r$p$salt$hash` (salt and hash base64url), so the cost can be raised
 * later: old hashes still verify with the parameters written in them.
 */
const COST = { N: 2 ** 16, r: 8, p: 2 };
const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** scrypt needs 128 * N * r bytes; Node refuses above `maxmem`, which defaults to 32 MB. */
const maxmemFor = (N: number, r: number) => 128 * N * r + 1024 * 1024;

export const PASSWORD_MIN = 8;
/** scrypt takes any length; the cap only stops someone posting megabytes to make us hash them. */
export const PASSWORD_MAX = 128;

function derive(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  const options: ScryptOptions = { N, r, p, maxmem: maxmemFor(N, r) };
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_BYTES, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, COST.N, COST.r, COST.p);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** false for a wrong password and for anything that isn't a hash we wrote (never throws on bad input). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  // Only parameters we could have written: a tampered row can't make us burn gigabytes.
  if (![N, r, p].every(Number.isInteger) || N < 2 || N > COST.N || r < 1 || r > COST.r || p < 1 || p > COST.p) return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (expected.length !== KEY_BYTES) return false;

  const actual = await derive(password, salt, N, r, p);
  return timingSafeEqual(actual, expected); // constant time: timing doesn't show how close a guess was
}

/**
 * A hash of a random password, checked when the email has no account (or no password),
 * so "no such account" takes as long as "wrong password" and timing gives nothing away.
 */
export const DUMMY_HASH = hashPassword(randomBytes(16).toString('hex'));
