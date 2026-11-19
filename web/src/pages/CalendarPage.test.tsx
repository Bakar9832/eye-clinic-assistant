import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEMO, mockApi, renderApp } from '../test/render';

const TYPES = [
  {
    code: 'ROUTINE_EYE_TEST',
    name: 'Routine eye test',
    typicalMin: 25,
    calendarMin: 30,
    isUrgent: false,
    prepInstructions: 'Bring your glasses.',
    steps: [
      { position: 1, resourceKind: 'TECHNICIAN', requiredSkill: 'PRETEST', offsetMin: 0, durationMin: 10 },
      { position: 2, resourceKind: 'OPTOMETRIST', requiredSkill: null, offsetMin: 10, durationMin: 20 },
    ],
  },
  {
    code: 'CHILD_EYE_EXAM',
    name: "Child's eye exam",
    typicalMin: 35,
    calendarMin: 40,
    isUrgent: false,
    prepInstructions: 'A parent must attend.',
    steps: [{ position: 2, resourceKind: 'OPTOMETRIST', requiredSkill: 'PAEDIATRIC', offsetMin: 10, durationMin: 30 }],
  },
];

/** Every day has one free time, 10:00 Karachi, with Dr Ayesha. */
function calendarApi(me: object | null) {
  return mockApi({
    'GET /me': me ? { body: me } : { status: 401, body: { error: 'UNAUTHENTICATED', reasons: [] } },
    'GET /appointment-types': { body: TYPES },
    'GET /availability': (call) => {
      const day = new URLSearchParams(call.path.split('?')[1]).get('day')!;
      const start = new Date(`${day}T05:00:00.000Z`).toISOString();
      return { body: { type: 'ROUTINE_EYE_TEST', day, timezone: 'Asia/Karachi', slots: [{ start, end: start, doctor: { id: 'doc-ayesha', displayName: 'Dr Ayesha' } }] } };
    },
    'POST /me/appointments': (call) => ({
      status: 201,
      body: {
        id: 'a1',
        reference: 'EC-ABC234',
        status: 'BOOKED',
        start: call.body?.start,
        end: call.body?.start,
        type: { code: 'ROUTINE_EYE_TEST', name: 'Routine eye test', typicalMin: 25 },
        doctor: { displayName: 'Dr Ayesha' },
        prepInstructions: 'Bring your glasses.',
      },
    }),
  });
}

/** The first free time on the first day with times (chosen by default). */
async function pickFirstSlot() {
  const times = await screen.findByRole('region', { name: 'Pick a time' });
  await userEvent.click(await within(times).findByRole('button', { name: /10:00 AM/ }));
}

describe('the booking calendar', () => {
  // Changed with the 55+ redesign (approved): day cards became day buttons, "Book this"
  // became "Confirm booking", the dropdowns became cards and buttons. Same checks.
  it('W11. shows a week of days; a logged-out visitor confirms by logging in, keeping the choice', async () => {
    calendarApi(null);
    renderApp('/calendar');

    const week = await screen.findByRole('group', { name: 'Pick a day' });
    expect(await within(week).findAllByRole('button')).toHaveLength(7);
    await pickFirstSlot();
    const login = screen.getByRole('link', { name: 'Log in to confirm' });
    const next = decodeURIComponent(login.getAttribute('href')!.split('next=')[1]);
    expect(next).toMatch(/^\/calendar\?/);
    expect(next).toContain('start=');
    expect(next).toContain('slotDoctor=doc-ayesha');
  });

  it('W11b. logged in: books the chosen time with that doctor and shows the ticket', async () => {
    const api = calendarApi(DEMO);
    renderApp('/calendar');

    const confirm = await screen.findByRole('button', { name: 'Confirm booking' });
    expect(confirm).toBeDisabled(); // nothing chosen yet
    await pickFirstSlot();
    expect(screen.getByRole('button', { name: /10:00 AM/, pressed: true })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm booking' }));

    expect(await screen.findByText('EC-ABC234')).toBeInTheDocument();
    const booking = api.calls.find((c) => c.method === 'POST' && c.path === '/me/appointments');
    expect(booking?.body).toMatchObject({ typeCode: 'ROUTINE_EYE_TEST', doctorId: 'doc-ayesha' });
  });

  it('W13. an incomplete profile is asked for name and date of birth first', async () => {
    calendarApi({ ...DEMO, fullName: null, hasDateOfBirth: false, profileComplete: false });
    renderApp('/calendar');

    await pickFirstSlot();
    expect(screen.getByRole('form', { name: 'Your details' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm booking' })).toBeNull();
  });

  it("only offers doctors who do that kind of visit: a child's exam is Dr Ayesha only", async () => {
    calendarApi(null);
    renderApp('/calendar');

    const visits = await screen.findByRole('group', { name: 'Type of visit' });
    await userEvent.click(await within(visits).findByRole('button', { name: /Child's eye exam/ }));
    expect(within(visits).getByRole('button', { name: /Child's eye exam/ })).toHaveAttribute('aria-pressed', 'true');
    const doctors = within(screen.getByRole('group', { name: 'Doctor' }))
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(doctors).toEqual(['Any doctor (soonest)', 'Dr Ayesha']);
  });
});

describe('Book page states and keyboard (55+ redesign, phase 2)', () => {
  /** Availability where `slotsFor(day)` decides each day's times (Karachi 10:00 = 05:00Z). */
  function weekApi(slotsFor: (day: string) => 'one' | 'none' | 'error') {
    return mockApi({
      'GET /me': { status: 401, body: { error: 'UNAUTHENTICATED', reasons: [] } },
      'GET /appointment-types': { body: TYPES },
      'GET /availability': (call) => {
        const day = new URLSearchParams(call.path.split('?')[1]).get('day')!;
        const kind = slotsFor(day);
        if (kind === 'error') return { status: 500, body: { error: 'HTTP_500', reasons: [] } };
        const start = new Date(`${day}T05:00:00.000Z`).toISOString();
        const slots = kind === 'one' ? [{ start, end: start, doctor: { id: 'doc-ayesha', displayName: 'Dr Ayesha' } }] : [];
        return { body: { type: 'ROUTINE_EYE_TEST', day, timezone: 'Asia/Karachi', slots } };
      },
    });
  }
  const daysAsked = (api: ReturnType<typeof mockApi>) =>
    api.calls.filter((c) => c.path.startsWith('/availability')).map((c) => new URLSearchParams(c.path.split('?')[1]).get('day')!);

  it('B1. a week with no free times says so and Later moves to the next week', async () => {
    const api = weekApi(() => 'none');
    renderApp('/calendar');

    expect(await screen.findByText('No free times this week, try later.')).toBeInTheDocument();
    const week = screen.getByRole('group', { name: 'Pick a day' });
    for (const day of within(week).getAllByRole('button')) expect(day).toBeDisabled();
    const firstWeek = [...new Set(daysAsked(api))];

    await userEvent.click(screen.getAllByRole('button', { name: 'Later' })[0]);
    await waitFor(() => expect(new Set(daysAsked(api)).size).toBe(14));
    expect(daysAsked(api).some((d) => !firstWeek.includes(d))).toBe(true);
  });

  it('B2. a day that fails to load shows an error with Retry, which asks again', async () => {
    let failing = true;
    let first: string | null = null; // the first day the page asks for fails
    const api = weekApi((day) => {
      first ??= day;
      return failing && day === first ? 'error' : 'one';
    });
    renderApp('/calendar');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't load the free times");
    const before = api.calls.length;
    failing = false;
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/couldn't load the free times/)).toBeNull());
    expect(api.calls.length).toBeGreaterThan(before);
  });

  it('B3. arrow keys move between days and times; each group is a single Tab stop', async () => {
    weekApi(() => 'one');
    renderApp('/calendar');

    const week = await screen.findByRole('group', { name: 'Pick a day' });
    await waitFor(() => expect(within(week).getAllByRole('button').filter((b) => !b.hasAttribute('disabled'))).toHaveLength(7));
    const days = within(week).getAllByRole('button');
    expect(days.filter((b) => b.tabIndex === 0)).toHaveLength(1); // one Tab stop: the selected day
    days[0].focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(days[1]);
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(days[6]);
    await userEvent.keyboard('{Enter}');
    expect(days[6]).toHaveAttribute('aria-pressed', 'true');
  });

  it('B4. Earlier is off on the first week; a new week clears the chosen time', async () => {
    weekApi(() => 'one');
    renderApp('/calendar');

    expect(await screen.findByRole('button', { name: /Earlier/ })).toBeDisabled();
    await pickFirstSlot();
    expect(screen.getByRole('link', { name: 'Log in to confirm' })).not.toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(screen.getByRole('button', { name: /Later/ }));
    expect(await screen.findByText(/Choose a time to continue/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Earlier/ })).toBeEnabled();
  });
});
