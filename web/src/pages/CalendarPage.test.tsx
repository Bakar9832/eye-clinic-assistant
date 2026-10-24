import { screen, within } from '@testing-library/react';
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

async function pickFirstSlot() {
  const firstDay = (await screen.findAllByRole('region'))[0];
  await userEvent.click(await within(firstDay).findByRole('button', { name: /10:00/ }));
}

describe('the booking calendar', () => {
  it('W11. shows a week of free times; booking first asks a logged-out visitor to log in', async () => {
    calendarApi(null);
    renderApp('/calendar');

    expect(await screen.findAllByRole('region')).toHaveLength(7);
    await pickFirstSlot();
    expect(screen.getByText('Please log in to book.')).toBeInTheDocument();
  });

  it('W11b. logged in: books the chosen time with that doctor and shows the ticket', async () => {
    const api = calendarApi(DEMO);
    renderApp('/calendar');

    await pickFirstSlot();
    await userEvent.click(screen.getByRole('button', { name: 'Book this' }));

    expect(await screen.findByText('EC-ABC234')).toBeInTheDocument();
    const booking = api.calls.find((c) => c.method === 'POST' && c.path === '/me/appointments');
    expect(booking?.body).toMatchObject({ typeCode: 'ROUTINE_EYE_TEST', doctorId: 'doc-ayesha' });
  });

  it('W13. an incomplete profile is asked for name and date of birth first', async () => {
    calendarApi({ ...DEMO, fullName: null, hasDateOfBirth: false, profileComplete: false });
    renderApp('/calendar');

    await pickFirstSlot();
    expect(screen.getByRole('form', { name: 'Your details' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Book this' })).toBeNull();
  });

  it("only offers doctors who do that kind of visit: a child's exam is Dr Ayesha only", async () => {
    calendarApi(null);
    renderApp('/calendar');

    await screen.findByRole('option', { name: /Child's eye exam/ }); // types have loaded
    await userEvent.selectOptions(screen.getByLabelText('Appointment type'), 'CHILD_EYE_EXAM');
    const doctors = within(screen.getByLabelText('Doctor')).getAllByRole('option').map((o) => o.textContent);
    expect(doctors).toEqual(['Any doctor', 'Dr Ayesha']);
  });
});
