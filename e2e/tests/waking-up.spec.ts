// The refresh bug: on a sleeping free-tier server the first "who is logged in" request
// (/me) hangs or fails with a 502 from Vercel. The page must not wait on it to draw the
// header, must say what's happening, and must recover by itself.

import { expect, test, type Page } from '@playwright/test';

const PASSWORD = process.env.SEED_PATIENT_PASSWORD!;

async function logIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
}

test.describe('a sleeping server after a refresh', () => {
  test('E9. the header draws at once, a waking-up note appears after 3 s, and the page recovers by itself', async ({ page }) => {
    // /me answers only after 8 seconds, like a server waking up.
    await page.route('**/me', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      await route.continue();
    });
    await page.goto('/');

    // At once: brand and a way in, without waiting for /me.
    await expect(page.getByRole('link', { name: 'Log in' }).first()).toBeVisible({ timeout: 1_500 });
    await expect(page.getByRole('link', { name: 'Sign up' })).toBeVisible();
    // After 3 s: a calm note.
    await expect(page.getByText('Waking up the assistant, this can take up to a minute.')).toBeVisible({ timeout: 6_000 });
    // Then it settles without any help (no tab switch).
    await expect(page.getByText('Waking up the assistant')).toBeHidden({ timeout: 15_000 });
  });

  test('E10. a logged-in patient whose first /me calls fail with 502 is recognised again without a tab switch', async ({ page }) => {
    await logIn(page, 'demo.patient@example.com');

    let failures = 3;
    await page.route('**/me', async (route) => {
      if (failures-- > 0) return route.fulfill({ status: 502, contentType: 'text/html', body: '<html>502</html>' });
      return route.continue();
    });
    await page.reload();

    // Never shown as a guest because of a failed request, and back to "logged in" by itself.
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible({ timeout: 20_000 });
  });

  test('E11. when the server stays unreachable: a clear message with a Retry button that works', async ({ page }) => {
    let down = true;
    await page.route('**/me', (route) => (down ? route.fulfill({ status: 502, body: 'down' }) : route.continue()));
    await page.goto('/');

    const retry = page.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/can't reach the clinic/i)).toBeVisible();

    down = false;
    await retry.click();
    await expect(retry).toBeHidden({ timeout: 10_000 });
  });
});
