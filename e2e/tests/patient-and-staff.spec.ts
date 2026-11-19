// The main flows in a real browser: the real web app and API on their own seeded
// database, with a scripted stand-in for the AI agent (stub-agent.mjs).
// Each flow uses a different seeded patient, so the booking guardrails (one appointment a
// day, 3 changes in 10 minutes) don't make the tests depend on each other.

import { expect, test, type Page } from '@playwright/test';

const PATIENT_PASSWORD = process.env.SEED_PATIENT_PASSWORD!;
const STAFF_PASSWORD = process.env.SEED_STAFF_PASSWORD!;

async function logIn(page: Page, email: string, password = PATIENT_PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

async function staffLogIn(page: Page, email: string) {
  await page.goto('/admin/login');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible();
}

const TIME = /\d:\d\d (AM|PM)/;

/**
 * Picks a day after today with at least two free times in the week strip (not today: its
 * last times run out while the test runs) and returns that day's time buttons.
 * Changed with the 55+ Book page redesign: days are buttons, times are one step below.
 */
async function firstFreeSlot(page: Page) {
  const days = page.getByRole('group', { name: 'Pick a day' }).getByRole('button');
  await expect(days).toHaveCount(7);
  const day = page.getByRole('region', { name: 'Pick a time' });
  for (let i = 1; i < 7; i++) {
    const button = days.nth(i);
    await expect(button).not.toHaveAccessibleName(/loading/);
    if (await button.isDisabled()) continue;
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    if ((await day.getByRole('button', { name: TIME }).count()) >= 2) {
      return { day, slot: day.getByRole('button', { name: TIME }).first() };
    }
  }
  throw new Error('No day after today with two free times on the Book page');
}

type Appointment = { reference: string; status: string; start: string };
const myAppointments = async (page: Page) => (await (await page.request.get('/me/appointments')).json()) as Appointment[];

test.describe('logging in', () => {
  test('E1. a patient logs in with email and password; a wrong password is refused', async ({ page }) => {
    await logIn(page, 'test.two@example.com', 'not-the-password');
    await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');

    await logIn(page, 'test.two@example.com');
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
    await expect(page.getByText('Test Patient Two')).toBeVisible();
  });

  test('E1b. staff log in through their own door', async ({ page }) => {
    await staffLogIn(page, 'reception@clinic.example');
    await expect(page.getByRole('link', { name: 'Guardrails' })).toBeVisible();
  });
});

test.describe('booking, moving and cancelling on the calendar', () => {
  test('E2-E4. book a time, move it (same reference), cancel it (the time is free again)', async ({ page }) => {
    await logIn(page, 'test.two@example.com');
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();

    // Book
    await page.goto('/calendar');
    const { slot } = await firstFreeSlot(page);
    await slot.click();
    await page.getByRole('button', { name: 'Confirm booking' }).click();
    const ticket = page.getByRole('region', { name: 'Booking ticket' });
    await expect(ticket).toContainText(/EC-[A-Z0-9]{6}/);
    const reference = /EC-[A-Z0-9]{6}/.exec((await ticket.textContent()) ?? '')![0];

    await page.goto('/my');
    const row = page.locator('div.rounded-lg', { hasText: reference });
    await expect(row).toBeVisible();
    const before = (await myAppointments(page)).find((a) => a.reference === reference)!;

    // Move: like a person would, try the days in order until one has a free time.
    await row.getByRole('button', { name: 'Move' }).click();
    const newDay = row.getByLabel('New day');
    const times = row.getByRole('button', { name: /\d:\d\d (AM|PM)/ });
    const noTimes = row.getByText('No free times that day.');
    const days = await newDay.locator('option').count();
    for (let i = 0; i < days; i++) {
      await newDay.selectOption({ index: i });
      await expect(times.first().or(noTimes)).toBeVisible();
      // Two or more, so the last one is not the appointment's own (earliest) time.
      if ((await times.count()) >= 2) break;
    }
    await times.last().click();
    await expect(row.getByRole('button', { name: 'Move' })).toBeVisible();
    const moved = (await myAppointments(page)).find((a) => a.reference === reference)!;
    expect(moved.status).toBe('BOOKED');
    expect(moved.start).not.toBe(before.start);

    // Cancel
    await row.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Yes, cancel it' }).click();
    await expect.poll(async () => (await myAppointments(page)).find((a) => a.reference === reference)?.status).toBe('CANCELLED');
  });

  test('E5. a second booking on the same day is refused, and nothing is booked', async ({ page }) => {
    await logIn(page, 'test.three@example.com');
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
    await page.goto('/calendar');

    const { day, slot } = await firstFreeSlot(page);
    await slot.click();
    await page.getByRole('button', { name: 'Confirm booking' }).click();
    await expect(page.getByRole('region', { name: 'Booking ticket' })).toBeVisible();

    // Another time on the same day.
    await day.getByRole('button', { name: /\d:\d\d (AM|PM)/ }).last().click();
    await page.getByRole('button', { name: 'Confirm booking' }).click();
    await expect(page.getByRole('alert')).toContainText('already have');

    expect((await myAppointments(page)).filter((a) => a.status === 'BOOKED')).toHaveLength(1);
  });
});

test.describe('the chat (scripted agent, real tools)', () => {
  test('E6. asking for a person creates a call back that reception sees', async ({ page, browser }) => {
    await logIn(page, 'demo.patient@example.com');
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();

    await page.getByLabel('Message').fill('Can I speak to a person, please?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText(/call you back/)).toBeVisible();

    const staff = await (await browser.newContext()).newPage();
    await staffLogIn(staff, 'reception@clinic.example');
    await staff.getByRole('link', { name: 'Handoffs' }).click();
    await expect(staff.getByRole('listitem', { name: /Call back Demo Patient/ })).toBeVisible();
  });

  test('E7. an out-of-scope request gets the eye-care-only reply and books nothing', async ({ page }) => {
    await logIn(page, 'demo.patient@example.com');
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
    const before = (await myAppointments(page)).length;

    await page.getByLabel('Message').fill('I need a dental check-up.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText(/only handles eye care/)).toBeVisible();

    expect((await myAppointments(page)).length).toBe(before);
  });

  test('E8. a booking in the chat goes through the real book tool and shows the ticket', async ({ page }) => {
    await logIn(page, 'demo.patient@example.com');
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();

    // A free follow-up time well after the seeded bookings, in clinic time.
    const { timezone } = (await (await page.request.get('/clinic')).json()) as { timezone: string };
    let found: { date: string; time: string } | undefined;
    for (let offset = 15; offset < 30 && !found; offset++) {
      const date = new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
      const { slots } = (await (await page.request.get(`/availability?type=FOLLOW_UP&day=${date}`)).json()) as { slots?: { start: string }[] };
      if (slots?.length) {
        const time = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(slots[0].start));
        found = { date, time };
      }
    }
    expect(found, 'a free follow-up time in the next weeks').toBeDefined();

    await page.getByLabel('Message').fill(`book FOLLOW_UP on ${found!.date} at ${found!.time}`);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('region', { name: 'Booking ticket' })).toContainText(/EC-[A-Z0-9]{6}/);
  });
});
