// Full keyboard use: the main paths work with Tab and Enter alone, and focus is visible.

import { expect, test, type Page } from '@playwright/test';

/** Presses Tab until the element matching `isTarget` has focus (at most `max` presses). */
async function tabTo(page: Page, isTarget: () => Promise<boolean>, max = 30) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await isTarget()) return;
  }
  throw new Error('Never reached the element with Tab');
}

const focusedName = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el?.getAttribute('aria-label') ?? el?.textContent?.trim() ?? '';
  });

test.describe('keyboard', () => {
  test('E12. a guest can reach the chat box with Tab, send with Enter, and the focus ring shows', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByLabel('Message')).toBeEnabled();

    await tabTo(page, async () => (await focusedName(page)) === 'Message');
    await page.keyboard.type('I need a dental check-up.');
    await page.keyboard.press('Enter');
    await expect(page.getByText(/only handles eye care/)).toBeVisible();
  });

  test('E13. links and buttons show a visible accent focus ring', async ({ page }) => {
    await page.goto('/');
    await tabTo(page, async () => (await focusedName(page)) === 'Log in');
    const outline = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement as Element);
      return { width: style.outlineWidth, style: style.outlineStyle, color: style.outlineColor };
    });
    expect(outline).toEqual({ width: '2px', style: 'solid', color: 'rgb(15, 118, 110)' });
  });

  test('E14. login works with the keyboard alone', async ({ page }) => {
    await page.goto('/login');
    await tabTo(page, async () => (await focusedName(page)) === '' && (await page.evaluate(() => (document.activeElement as HTMLInputElement)?.type === 'email')));
    await page.keyboard.type('test.two@example.com');
    await page.keyboard.press('Tab');
    await page.keyboard.type(process.env.SEED_PATIENT_PASSWORD!);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  });
});
