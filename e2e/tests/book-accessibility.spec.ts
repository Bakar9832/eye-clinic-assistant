// The Book page's rules for patients aged 55 and over, measured on the real page.

import { expect, test, type Page } from '@playwright/test';

const sizes = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } } as const;

async function openWithTimeChosen(page: Page) {
  await page.goto('/calendar');
  const times = page.getByRole('region', { name: 'Pick a time' }).getByRole('button', { name: /\d:\d\d (AM|PM)/ });
  await times.first().click();
  await expect(times.first()).toHaveAttribute('aria-pressed', 'true');
}

for (const [size, viewport] of Object.entries(sizes)) {
  test.describe(`Book page, ${size}`, () => {
    test.use({ viewport });

    test(`E15. buttons at least 48 px tall with 8 px between them; text at least 18 px (${size})`, async ({ page }) => {
      await openWithTimeChosen(page);
      const main = page.locator('main');

      const report = await main.evaluate((root) => {
        const visible = (el: Element) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !el.closest('.sr-only');
        };
        const buttons = [...root.querySelectorAll('button, a[href]')].filter(visible);
        const short = buttons.filter((b) => b.getBoundingClientRect().height < 47.5).map((b) => b.textContent?.trim());

        // Gaps between neighbouring buttons in the same row of a group.
        const tight: string[] = [];
        for (const group of root.querySelectorAll('[role="group"]')) {
          const rects = [...group.querySelectorAll('button')].filter(visible).map((b) => b.getBoundingClientRect());
          for (let i = 1; i < rects.length; i++) {
            const [a, b] = [rects[i - 1], rects[i]];
            const sameRow = Math.abs(a.top - b.top) < 2;
            const gap = sameRow ? b.left - a.right : b.top - a.bottom;
            if (gap >= 0 && gap < 7.5) tight.push(`${group.getAttribute('aria-label') ?? group.getAttribute('aria-labelledby')}: ${gap.toFixed(1)}px`);
          }
        }

        // Every visible text node's font size.
        const small: string[] = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const el = n.parentElement!;
          if (!n.textContent?.trim() || !visible(el)) continue;
          const px = parseFloat(getComputedStyle(el).fontSize);
          if (px < 17.9) small.push(`${n.textContent.trim().slice(0, 30)} (${px}px)`);
        }
        return { short, tight: [...new Set(tight)], small: [...new Set(small)] };
      });

      expect(report.short, 'buttons under 48 px').toEqual([]);
      expect(report.tight, 'buttons closer than 8 px').toEqual([]);
      expect(report.small, 'text under 18 px').toEqual([]);
    });

    test(`E16. the selected time shows a check and aria-pressed; Tab order follows the screen (${size})`, async ({ page }) => {
      await openWithTimeChosen(page);
      const chosen = page.getByRole('region', { name: 'Pick a time' }).getByRole('button', { pressed: true });
      await expect(chosen).toHaveCount(1);
      await expect(chosen.locator('svg')).toHaveCount(1); // the check icon, not colour alone

      // Tab through the page area: each next stop is below or to the right of the last.
      await page.getByRole('heading', { name: 'Book an appointment' }).click();
      const positions: { y: number; x: number; name: string }[] = [];
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press('Tab');
        const pos = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          if (!el.closest('main')) return null;
          const r = el.getBoundingClientRect();
          return { y: Math.round(r.top + (el.closest('main')?.scrollTop ?? 0)), x: Math.round(r.left), name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 25) };
        });
        if (pos) positions.push(pos);
      }
      // The sticky bar is last on screen and last in order; skip it, it moves with scrolling.
      const flow = positions.filter((p) => !/Confirm booking|Log in to confirm/.test(p.name));
      for (let i = 1; i < flow.length; i++) {
        const [a, b] = [flow[i - 1], flow[i]];
        expect(b.y > a.y + 4 || (Math.abs(b.y - a.y) <= 4 && b.x > a.x), `${a.name} → ${b.name}`).toBe(true);
      }
    });
  });
}
