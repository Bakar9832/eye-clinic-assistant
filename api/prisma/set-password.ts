// Sets the password of one existing staff member or patient, e.g. on the live demo's
// database, where the seed must never run again. The password comes from the environment,
// never the command line, so it isn't saved in your shell history.
//
//   $env:DATABASE_URL = "<the database>"      (omit for the local one in .env)
//   $env:NEW_PASSWORD = "<the new password>"
//   npm run set-password -- staff admin@clinic.example
//   Remove-Item Env:NEW_PASSWORD, Env:DATABASE_URL
//
// A patient's other sessions are logged out, like a reset. Staff can't reset their own
// password (their addresses are made up), so this is how it's done.

import path from 'node:path';
import { config } from 'dotenv';
import { hashPassword, PASSWORD_MAX, PASSWORD_MIN } from '../src/auth/password.js';
import { createPrismaClient } from '../src/prisma/create-client.js';

config({ path: path.resolve(import.meta.dirname, '..', '..', '.env') });

async function main() {
  const [kind, rawEmail] = process.argv.slice(2);
  const password = process.env.NEW_PASSWORD ?? '';
  if ((kind !== 'staff' && kind !== 'patient') || !rawEmail) {
    throw new Error('Usage: npm run set-password -- <staff|patient> <email>   (password in NEW_PASSWORD)');
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new Error(`Set NEW_PASSWORD to ${PASSWORD_MIN}-${PASSWORD_MAX} characters first.`);
  }

  const email = rawEmail.trim().toLowerCase();
  const prisma = createPrismaClient(process.env.DATABASE_URL!);
  try {
    const passwordHash = await hashPassword(password);
    const exists =
      kind === 'staff' ? await prisma.staffUser.findUnique({ where: { email } }) : await prisma.patient.findUnique({ where: { email } });
    if (!exists) throw new Error(`No ${kind} account with the email ${email}.`);
    if (kind === 'staff') {
      await prisma.staffUser.update({ where: { email }, data: { passwordHash } });
      await prisma.session.updateMany({ where: { staffUser: { email }, revokedAt: null }, data: { revokedAt: new Date() } });
    } else {
      await prisma.patient.update({ where: { email }, data: { passwordHash } });
      await prisma.session.updateMany({ where: { patient: { email }, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    // Only the host, never the full connection string (it holds the database password).
    console.log(`Password set for ${kind} ${email} on ${new URL(process.env.DATABASE_URL!).host}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
