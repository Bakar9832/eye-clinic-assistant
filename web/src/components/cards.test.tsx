import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DobCard, DoctorNoteCard, TicketCard } from './cards';
import { DEMO, mockApi, renderApp } from '../test/render';

const TRICKY = 'Line one.\n  Indented line: “quoted”, 50% & <b>not html</b> -1.25 👓';

describe('the doctor note card', () => {
  it('W8. shows the note exactly as written, with the doctor', async () => {
    mockApi({});
    renderApp(
      '/',
      <DoctorNoteCard card={{ type: 'doctor_note', note: TRICKY, doctorName: 'Dr Ayesha', recordedAt: '2030-01-07T05:20:00.000Z', edited: false, editedAt: null }} />,
    );

    // textContent, not toHaveTextContent: that would collapse the line break and spaces.
    expect(screen.getByTestId('doctor-note').textContent).toBe(TRICKY);
    expect(screen.getByText('Note from Dr Ayesha')).toBeInTheDocument();
    expect(screen.queryByText(/Edited/)).toBeNull();
    // Rendered as text, never as HTML.
    expect(document.querySelector('[data-testid="doctor-note"] b')).toBeNull();
  });

  it('W8b. a corrected note carries an "Edited" tag with the date', () => {
    mockApi({});
    renderApp(
      '/',
      <DoctorNoteCard
        card={{ type: 'doctor_note', note: 'Updated.', doctorName: 'Dr Ayesha', recordedAt: '2030-01-07T05:20:00.000Z', edited: true, editedAt: '2030-01-08T06:00:00.000Z' }}
      />,
    );
    expect(screen.getByText('Edited 8 Jan 2030')).toBeInTheDocument();
  });
});

describe('the ticket card', () => {
  it("W10. shows the reference, both clocks when they differ, and the preparation", async () => {
    localStorage.setItem('viewerZone', 'Europe/London');
    mockApi({});
    renderApp(
      '/',
      <TicketCard card={{ type: 'ticket', reference: 'EC-7K3QFM', start: '2030-01-07T05:00:00.000Z', doctor: 'Dr Ayesha', prepInstructions: 'Bring your glasses.' }} />,
    );

    expect(await screen.findByText('Mon 7 Jan 10:00')).toBeInTheDocument();
    expect(screen.getByText('EC-7K3QFM')).toBeInTheDocument();
    expect(screen.getByLabelText('Booking ticket')).toHaveTextContent('clinic time (Karachi) · 05:00 your time (London)');
    expect(screen.getByText('Bring your glasses.')).toBeInTheDocument();
  });
});

describe('the date-of-birth box', () => {
  it('W9. sends the date to /me/verify-dob only', async () => {
    const api = mockApi({ 'GET /me': { body: DEMO }, 'POST /me/verify-dob': { body: { verified: true } } });
    const verified = vi.fn();
    renderApp('/', <DobCard onVerified={verified} />);

    await userEvent.type(screen.getByLabelText('Date of birth'), '1990-01-15');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(verified).toHaveBeenCalled();
    const withDob = api.calls.filter((c) => JSON.stringify(c.body ?? {}).includes('1990-01-15'));
    expect(withDob.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /me/verify-dob']);
  });

  it('a wrong date says so; the fifth wrong one explains the logout', async () => {
    let attempts = 0;
    mockApi({
      'GET /me': { body: DEMO },
      'POST /me/verify-dob': () =>
        ++attempts < 5
          ? { status: 401, body: { error: 'DOB_MISMATCH', reasons: [] } }
          : { status: 401, body: { error: 'DOB_LOCKED', reasons: [] } },
    });
    renderApp('/', <DobCard onVerified={() => {}} />);

    await userEvent.type(screen.getByLabelText('Date of birth'), '1999-09-09');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("doesn't match");

    attempts = 4;
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('logged out');
  });
});
