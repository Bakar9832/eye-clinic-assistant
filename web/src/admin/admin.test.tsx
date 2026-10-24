import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, renderApp } from '../test/render';
import type { ScheduleItem, StaffMe } from './staff-api';

const DOCTOR: StaffMe = { id: 's-ayesha', email: 'dr.ayesha@clinic.example', displayName: 'Dr Ayesha', role: 'DOCTOR' };
const RECEPTION: StaffMe = { id: 's-desk', email: 'reception@clinic.example', displayName: 'Reception', role: 'RECEPTION' };
const ADMIN: StaffMe = { id: 's-admin', email: 'admin@clinic.example', displayName: 'Clinic Admin', role: 'ADMIN' };

const item = (over: Partial<ScheduleItem>): ScheduleItem => ({
  id: 'a1',
  reference: 'EC-ABC234',
  start: '2020-01-06T05:00:00.000Z', // in the past, so it has started
  end: '2020-01-06T05:15:00.000Z',
  status: 'BOOKED',
  type: { code: 'FOLLOW_UP', name: 'Follow-up visit' },
  patient: { fullName: 'Demo Patient' },
  doctor: 'Dr Ayesha',
  examinedByMe: true,
  hasOutcome: false,
  ...over,
});

function staffApi(me: StaffMe, routes: Parameters<typeof mockApi>[0] = {}) {
  return mockApi({ 'GET /staff/me': { body: me }, 'GET /staff/schedule': { body: { appointments: [] } }, ...routes });
}

const navLinks = () => within(screen.getByRole('navigation')).getAllByRole('link').map((l) => l.textContent);

describe('A1. staff login', () => {
  it('sends a visitor to the staff login, and in after email and code', async () => {
    let loggedIn = false;
    const api = mockApi({
      'GET /staff/me': () => (loggedIn ? { body: RECEPTION } : { status: 401, body: { error: 'UNAUTHENTICATED' } }),
      'POST /staff/auth/request-code': { status: 202, body: {} },
      'POST /staff/auth/verify': () => ((loggedIn = true), { body: { loggedIn: true } }),
      'GET /staff/schedule': { body: { appointments: [] } },
    });
    renderApp('/admin');

    await userEvent.type(await screen.findByLabelText('Work email'), RECEPTION.email);
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    await userEvent.type(await screen.findByLabelText(/Code sent to/), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByRole('heading', { name: 'Schedule' })).toBeInTheDocument();
    expect(api.calls.find((c) => c.path === '/staff/auth/verify')?.body).toEqual({ email: RECEPTION.email, code: '123456' });
  });
});

describe('A2. what each role sees', () => {
  it.each([
    [DOCTOR, ['Schedule', 'Handoffs']],
    [RECEPTION, ['Schedule', 'Handoffs', 'New booking']],
    [ADMIN, ['Schedule', 'Handoffs', 'New booking', 'Settings']],
  ])('%s', async (me, links) => {
    staffApi(me);
    renderApp('/admin');
    await screen.findByRole('heading', { name: 'Schedule' });
    expect(navLinks()).toEqual(links);
  });

  it('reception opening the settings address directly is turned away', async () => {
    staffApi(RECEPTION);
    renderApp('/admin/settings');
    expect(await screen.findByText('This section is not available for your role.')).toBeInTheDocument();
  });
});

describe('A3. the schedule', () => {
  it('shows the day in clinic time with patient names, and changes day', async () => {
    const api = staffApi(RECEPTION, {
      'GET /staff/schedule': { body: { appointments: [item({ start: '2030-01-07T05:00:00.000Z', examinedByMe: false })] } },
    });
    renderApp('/admin');

    const row = await screen.findByRole('listitem', { name: /10:00 Demo Patient/ });
    expect(row).toHaveTextContent('Follow-up visit');
    expect(row).toHaveTextContent('Dr Ayesha');

    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2030-01-08' } });
    await screen.findByRole('listitem', { name: /Demo Patient/ });
    expect(api.calls.some((c) => c.path === '/staff/schedule?day=2030-01-08')).toBe(true);
  });
});

describe('A4. recording an outcome', () => {
  it('is offered only on the doctor\'s own exams that have started', async () => {
    staffApi(DOCTOR, {
      'GET /staff/schedule': {
        body: {
          appointments: [
            item({ id: 'mine', patient: { fullName: 'Mine Started' } }),
            item({ id: 'bilal', patient: { fullName: 'Bilal Patient' }, doctor: 'Dr Bilal', examinedByMe: false }),
            item({ id: 'future', patient: { fullName: 'Mine Later' }, start: '2099-01-01T05:00:00.000Z' }),
          ],
        },
      },
    });
    renderApp('/admin');

    expect(within(await screen.findByRole('listitem', { name: /Mine Started/ })).getByRole('button', { name: 'Record outcome' })).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: /Bilal Patient/ })).queryByRole('button')).toBeNull();
    expect(within(screen.getByRole('listitem', { name: /Mine Later/ })).queryByRole('button')).toBeNull();
  });

  it('sends the code and the note exactly as typed', async () => {
    const note = 'Line one.\n  Line two: “no change” 👓';
    const api = staffApi(DOCTOR, {
      'GET /staff/schedule': { body: { appointments: [item({})] } },
      'POST /staff/appointments/a1/outcome': { status: 201, body: { code: 'NO_CHANGE', patientNote: note, recordedAt: '', correctedAt: null } },
    });
    renderApp('/admin');

    await userEvent.click(await screen.findByRole('button', { name: 'Record outcome' }));
    await userEvent.selectOptions(screen.getByLabelText('Outcome'), 'NO_CHANGE');
    fireEvent.change(screen.getByLabelText('Note for the patient'), { target: { value: note } });
    expect(screen.getByText(`${note.length}/500`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save outcome' }));

    await screen.findByRole('button', { name: 'Record outcome' }); // form closed after saving
    expect(api.calls.find((c) => c.path === '/staff/appointments/a1/outcome' && c.method === 'POST')?.body).toEqual({
      code: 'NO_CHANGE',
      patientNote: note,
    });
  });
});

describe('A5. correcting an outcome', () => {
  it('loads what was recorded and sends the correction', async () => {
    const api = staffApi(DOCTOR, {
      'GET /staff/schedule': { body: { appointments: [item({ status: 'COMPLETED', hasOutcome: true })] } },
      'GET /staff/appointments/a1/outcome': {
        body: { code: 'NO_CHANGE', patientNote: 'All fine.', recordedAt: '2030-01-07T05:20:00.000Z', correctedAt: null, editable: true, editableUntil: '2030-01-10T05:20:00.000Z' },
      },
      'PUT /staff/appointments/a1/outcome': { body: {} },
    });
    renderApp('/admin');

    await userEvent.click(await screen.findByRole('button', { name: 'Correct outcome' }));
    expect(await screen.findByDisplayValue('All fine.')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Outcome'), 'NEW_PRESCRIPTION');
    await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    await screen.findByRole('button', { name: 'Correct outcome' });
    expect(api.calls.find((c) => c.method === 'PUT')?.body).toEqual({ code: 'NEW_PRESCRIPTION', patientNote: 'All fine.' });
  });

  it('says so when the edit window has closed', async () => {
    staffApi(DOCTOR, {
      'GET /staff/schedule': { body: { appointments: [item({ status: 'COMPLETED', hasOutcome: true })] } },
      'GET /staff/appointments/a1/outcome': {
        body: { code: 'NO_CHANGE', patientNote: 'All fine.', recordedAt: '2030-01-07T05:20:00.000Z', correctedAt: null, editable: false, editableUntil: '2030-01-10T05:20:00.000Z' },
      },
    });
    renderApp('/admin');

    await userEvent.click(await screen.findByRole('button', { name: 'Correct outcome' }));
    expect(await screen.findByText(/can no longer be corrected/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save correction' })).toBeNull();
  });
});

describe('A6. handoffs', () => {
  it('lists them, guests included, and marks one handled', async () => {
    const api = staffApi(RECEPTION, {
      'GET /staff/handoffs': {
        body: [
          { id: 'h1', reason: 'Asks which eye drops to use.', status: 'OPEN', createdAt: '2030-01-07T05:00:00.000Z', conversationId: 'c', patient: { fullName: 'Demo Patient', email: 'demo.patient@example.com' } },
          { id: 'h2', reason: 'Complaint about parking.', status: 'OPEN', createdAt: '2030-01-07T06:00:00.000Z', conversationId: 'c2', patient: null },
        ],
      },
      'POST /staff/handoffs/h1/close': { body: { id: 'h1', status: 'CLOSED' } },
    });
    renderApp('/admin/handoffs');

    expect(await screen.findByText('Asks which eye drops to use.')).toBeInTheDocument();
    expect(screen.getByText('Guest (not logged in)')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Mark as handled' })[0]);
    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/staff/handoffs/h1/close')).toBe(true);
  });
});

describe('A7. booking with an override', () => {
  it('shows the warnings, needs a real reason, then books anyway with it', async () => {
    const warning = { code: 'OUTSIDE_WORKING_HOURS', message: 'Dr Ayesha: 17:00-17:15 is outside their working hours.' };
    const api = staffApi(RECEPTION, {
      'GET /staff/patients': { body: [{ id: 'p2', fullName: 'Test Patient Two', email: 'test.two@example.com' }] },
      'GET /appointment-types': { body: [{ code: 'FOLLOW_UP', name: 'Follow-up visit', typicalMin: 10, calendarMin: 15, isUrgent: false, prepInstructions: '', steps: [] }] },
      'POST /staff/appointments': (call) =>
        call.body?.override
          ? { status: 201, body: { id: 'n', reference: 'EC-NEW234', start: call.body.start, end: call.body.start, status: 'BOOKED' } }
          : { status: 409, body: { error: 'OVERRIDE_REQUIRED', reasons: [warning] } },
    });
    renderApp('/admin/book');

    await userEvent.type(await screen.findByLabelText('Find patient'), 'test');
    await userEvent.click(await screen.findByRole('button', { name: /Test Patient Two/ }));
    await screen.findByRole('option', { name: 'Follow-up visit' });
    await userEvent.selectOptions(screen.getByLabelText('Appointment type'), 'FOLLOW_UP');
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2030-01-07' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '17:00' } });
    await userEvent.click(screen.getByRole('button', { name: 'Book' }));

    const panel = await screen.findByRole('region', { name: 'Override needed' });
    expect(panel).toHaveTextContent(warning.message);
    const bookAnyway = within(panel).getByRole('button', { name: 'Book anyway' });
    await userEvent.type(within(panel).getByLabelText('Reason'), 'too short');
    expect(bookAnyway).toBeDisabled();
    await userEvent.type(within(panel).getByLabelText('Reason'), ' — patient travels after work');
    await userEvent.click(bookAnyway);

    expect(await screen.findByText(/Booked EC-NEW234/)).toBeInTheDocument();
    const [first, second] = api.calls.filter((c) => c.path === '/staff/appointments');
    // 17:00 typed in clinic time goes to the API as an exact moment with Karachi's offset.
    expect(first.body).toEqual({ patientId: 'p2', typeCode: 'FOLLOW_UP', start: '2030-01-07T17:00:00.000+05:00' });
    expect(second.body).toMatchObject({ override: { reason: 'too short — patient travels after work' } });
  });
});

describe('A8. settings', () => {
  const settings = { name: 'Demo Eye Clinic', timezone: 'Asia/Karachi', slotGridMin: 15, offerRecheckAfterNewPrescription: false, outcomeEditWindowHours: 72 };

  it("changing the clinic's zone sends only that field and lists the bookings now outside hours", async () => {
    const api = staffApi(ADMIN, {
      'GET /staff/settings': { body: settings },
      'PATCH /staff/settings': {
        body: { settings: { ...settings, timezone: 'Europe/London' }, bookingsOutsideHours: [{ reference: 'EC-ABC234', start: '2030-01-07T04:00:00.000Z', patient: 'Demo Patient', resource: 'Dr Ayesha' }] },
      },
      'GET /appointment-types': { body: [] },
      'GET /staff/resources': { body: [] },
      'GET /staff/users': { body: [] },
    });
    renderApp('/admin/settings');

    await userEvent.selectOptions(await screen.findByLabelText('Clinic time zone'), 'Europe/London');
    await userEvent.click(screen.getByRole('button', { name: 'Save clinic settings' }));

    expect(await screen.findByRole('status')).toHaveTextContent('EC-ABC234');
    expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ timezone: 'Europe/London' });
  });

  it('leave over existing bookings shows who to move first', async () => {
    staffApi(ADMIN, {
      'GET /staff/settings': { body: settings },
      'GET /appointment-types': { body: [] },
      'GET /staff/resources': { body: [{ id: 'r-ayesha', kind: 'OPTOMETRIST', displayName: 'Dr Ayesha', workingHours: [] }] },
      'GET /staff/users': { body: [] },
      'POST /staff/resources/r-ayesha/time-off': {
        status: 409,
        body: {
          error: 'BOOKINGS_IN_THE_WAY',
          reasons: [],
          bookings: [{ reference: 'EC-ABC234', start: '2030-01-07T05:00:00.000Z', patient: 'Demo Patient', resource: 'Dr Ayesha' }],
        },
      },
    });
    renderApp('/admin/settings');

    const leave = await screen.findByRole('region', { name: 'Leave' });
    await within(leave).findByRole('option', { name: 'Dr Ayesha' }); // resources have loaded
    await userEvent.selectOptions(within(leave).getByLabelText('Who is away'), 'r-ayesha');
    fireEvent.change(within(leave).getByLabelText('First day'), { target: { value: '2030-01-07' } });
    fireEvent.change(within(leave).getByLabelText('Last day'), { target: { value: '2030-01-07' } });
    await userEvent.click(within(leave).getByRole('button', { name: 'Add leave' }));

    expect(await within(leave).findByRole('status')).toHaveTextContent('Move the patients first');
    expect(within(leave).getByRole('status')).toHaveTextContent('EC-ABC234');
  });

  it('a step length change sends only the step that changed', async () => {
    const api = staffApi(ADMIN, {
      'GET /staff/settings': { body: settings },
      'GET /appointment-types': {
        body: [
          {
            code: 'ROUTINE_EYE_TEST',
            name: 'Routine eye test',
            typicalMin: 25,
            calendarMin: 30,
            isUrgent: false,
            prepInstructions: '',
            steps: [
              { position: 1, resourceKind: 'TECHNICIAN', requiredSkill: 'PRETEST', offsetMin: 0, durationMin: 10 },
              { position: 2, resourceKind: 'OPTOMETRIST', requiredSkill: null, offsetMin: 10, durationMin: 20 },
            ],
          },
        ],
      },
      'PATCH /staff/appointment-types/ROUTINE_EYE_TEST': { body: {} },
      'GET /staff/resources': { body: [] },
      'GET /staff/users': { body: [] },
    });
    renderApp('/admin/settings');

    const row = await screen.findByRole('form', { name: 'Routine eye test' });
    fireEvent.change(within(row).getByLabelText('Routine eye test step 2'), { target: { value: '25' } });
    await userEvent.click(within(row).getByRole('button', { name: 'Save' }));

    expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ typicalMin: 25, stepDurations: [{ position: 2, durationMin: 25 }] });
  });
});

describe('A9. staff accounts', () => {
  it("can switch others off, never their own account", async () => {
    const api = staffApi(ADMIN, {
      'GET /staff/settings': { body: { name: 'x', timezone: 'Asia/Karachi', slotGridMin: 15, offerRecheckAfterNewPrescription: false, outcomeEditWindowHours: 72 } },
      'GET /appointment-types': { body: [] },
      'GET /staff/resources': { body: [] },
      'GET /staff/users': {
        body: [
          { id: 's-desk', email: RECEPTION.email, displayName: 'Reception', role: 'RECEPTION', active: true },
          { id: 's-admin', email: ADMIN.email, displayName: 'Clinic Admin', role: 'ADMIN', active: true },
        ],
      },
      'PATCH /staff/users/s-desk': { body: {} },
    });
    renderApp('/admin/settings');

    const accounts = await screen.findByRole('region', { name: 'Staff accounts' });
    const [desk, mine] = await within(accounts).findAllByRole('button', { name: 'Switch off' });
    expect(mine).toBeDisabled();
    await userEvent.click(desk);
    expect(api.calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: '/staff/users/s-desk', body: { active: false } });
  });
});
