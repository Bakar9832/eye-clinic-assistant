import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEMO, mockApi, renderApp } from '../test/render';

const UPCOMING = {
  id: 'appt-1',
  reference: 'EC-ABC234',
  status: 'BOOKED',
  start: '2030-01-07T05:00:00.000Z',
  end: '2030-01-07T05:15:00.000Z',
  type: { code: 'FOLLOW_UP', name: 'Follow-up visit', typicalMin: 10 },
  doctor: { displayName: 'Dr Ayesha' },
  prepInstructions: 'Bring your glasses.',
};

function appointmentsApi() {
  let status = 'BOOKED'; // like the real API: cancelling changes what the list returns
  return mockApi({
    'GET /me': { body: DEMO },
    'GET /me/appointments': () => ({ body: [{ ...UPCOMING, status }] }),
    'DELETE /me/appointments/appt-1': () => {
      status = 'CANCELLED';
      return { body: { ...UPCOMING, status } };
    },
    'GET /availability': { body: { type: 'FOLLOW_UP', day: 'x', timezone: 'Asia/Karachi', slots: [{ start: '2030-01-08T06:00:00.000Z', end: '2030-01-08T06:15:00.000Z', doctor: { id: 'doc-ayesha', displayName: 'Dr Ayesha' } }] } },
    'POST /me/appointments/appt-1/reschedule': { body: { ...UPCOMING, start: '2030-01-08T06:00:00.000Z' } },
  });
}

describe('my appointments', () => {
  it('W12. cancelling asks first, and only then calls the API', async () => {
    const api = appointmentsApi();
    renderApp('/my');

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Cancel this appointment?')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }));
    // The refreshed list shows it under past and cancelled.
    expect(await screen.findByText(/cancelled · EC-ABC234/)).toBeInTheDocument();
    expect(screen.getByText('Nothing booked.')).toBeInTheDocument();
    expect(api.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/me/appointments/appt-1']);
  });

  it("W12b. moving offers free times with the same doctor and sends the new start", async () => {
    const api = appointmentsApi();
    renderApp('/my');

    await userEvent.click(await screen.findByRole('button', { name: 'Move' }));
    await userEvent.click(await screen.findByRole('button', { name: /11:00/ }));

    const lookup = api.calls.find((c) => c.path.startsWith('/availability'))!;
    expect(new URLSearchParams(lookup.path.split('?')[1]).get('doctorId')).toBe('doc-ayesha');
    const move = api.calls.find((c) => c.path === '/me/appointments/appt-1/reschedule');
    expect(move?.body).toEqual({ start: '2030-01-08T06:00:00.000Z' });
  });

  it('asks a logged-out visitor to log in', async () => {
    mockApi({});
    renderApp('/my');
    expect(await screen.findByText('Please log in to see your appointments.')).toBeInTheDocument();
  });
});
