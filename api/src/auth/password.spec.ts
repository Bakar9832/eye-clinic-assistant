import { hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('PW1. the right password verifies, a wrong one does not', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('correct horse batterz', stored)).toBe(false);
  });

  it('PW2. the stored value is not the password, names its parameters, and is salted', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).toMatch(/^scrypt\$65536\$8\$2\$[\w-]+\$[\w-]+$/);
    expect(a).not.toContain('same-password');
    expect(a).not.toBe(b); // a random salt each time: equal passwords don't look equal
  });

  it('PW3. anything that is not one of our hashes is rejected without throwing', async () => {
    for (const bad of ['', 'plain-text', 'scrypt$1$1$1$x$y', 'bcrypt$2b$10$abc', 'scrypt$999999999$8$2$c2FsdA$aGFzaA']) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });

  it('PW4. the same characters typed differently (Unicode forms) count as the same password', async () => {
    const stored = await hashPassword('café-1234'); // é as one character
    expect(await verifyPassword('café-1234', stored)).toBe(true); // e + combining accent
  });
});
