import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEMO, mockApi, renderApp } from '../test/render';
import { DOB_CONFIRMED_MESSAGE } from './ChatPage';

async function say(text: string) {
  await userEvent.type(screen.getByLabelText('Message'), text);
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
}

describe('the chat', () => {
  it('W7. sends the message with the viewer\'s zone, shows the reply, and continues the conversation', async () => {
    localStorage.setItem('viewerZone', 'Europe/London');
    const api = mockApi({
      'GET /me': { body: DEMO },
      'POST /chat': (call) => ({ body: { conversationId: 'conv-1', reply: `You said: ${call.body?.message}`, cards: [] } }),
    });
    renderApp('/');

    await say('Hello');
    expect(await screen.findByText('You said: Hello')).toBeInTheDocument();
    await say('Book me in');
    expect(await screen.findByText('You said: Book me in')).toBeInTheDocument();

    const chats = api.calls.filter((c) => c.path === '/chat');
    expect(chats[0].body).toEqual({ message: 'Hello', viewerTimezone: 'Europe/London' });
    expect(chats[1].body).toEqual({ message: 'Book me in', viewerTimezone: 'Europe/London', conversationId: 'conv-1' });
  });

  it('W9. the date-of-birth box in the chat goes to the API; the chat only hears a fixed sentence', async () => {
    const api = mockApi({
      'GET /me': { body: DEMO },
      'POST /me/verify-dob': { body: { verified: true } },
      'POST /chat': (call) =>
        call.body?.message === DOB_CONFIRMED_MESSAGE
          ? { body: { conversationId: 'c', reply: 'Thanks, your results are below.', cards: [] } }
          : { body: { conversationId: 'c', reply: 'Please confirm your date of birth in the box below.', cards: [{ type: 'dob_prompt' }] } },
    });
    renderApp('/');

    await say('Are my results in?');
    await userEvent.type(await screen.findByLabelText('Date of birth'), '1990-01-15');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Thanks, your results are below.')).toBeInTheDocument();

    const chatBodies = api.calls.filter((c) => c.path === '/chat').map((c) => c.body?.message);
    expect(chatBodies).toEqual(['Are my results in?', DOB_CONFIRMED_MESSAGE]);
    expect(JSON.stringify(api.calls.filter((c) => c.path === '/chat'))).not.toContain('1990-01-15');
  });

  it('W8. a doctor note card from a tool is shown exactly as written', async () => {
    const note = 'Line one.\nLine two 👓';
    mockApi({
      'GET /me': { body: DEMO },
      'POST /chat': {
        body: {
          conversationId: 'c',
          reply: 'Your results are in.',
          cards: [{ type: 'doctor_note', note, doctorName: 'Dr Ayesha', recordedAt: '2030-01-07T05:20:00.000Z', edited: false, editedAt: null }],
        },
      },
    });
    renderApp('/');

    await say('Results?');
    expect((await screen.findByTestId('doctor-note')).textContent).toBe(note);
  });

  it('W14. when the assistant is down, a friendly message instead of a crash', async () => {
    mockApi({ 'POST /chat': { status: 503, body: { error: 'AGENT_UNAVAILABLE', reasons: [] } } });
    renderApp('/');

    await say('Hello');
    expect(await screen.findByRole('alert')).toHaveTextContent('The assistant is busy right now');
    // The input still works afterwards.
    expect(screen.getByLabelText('Message')).toBeEnabled();
  });

  it('W14b. rate limiting is explained too', async () => {
    mockApi({ 'POST /chat': { status: 429, body: { error: 'RATE_LIMITED', reasons: [] } } });
    renderApp('/');
    await say('Hello');
    expect(await screen.findByRole('alert')).toHaveTextContent('wait a few minutes');
  });

  it('logged out: says the visitor is a guest and invites them to log in for bookings and results', async () => {
    mockApi({});
    renderApp('/');
    await waitFor(() => expect(screen.getByText('Chatting as a guest:')).toBeInTheDocument());
    // The note has its own "Log in" link (the header has another).
    const note = screen.getByText('Chatting as a guest:').closest('p')!;
    expect(note).toHaveTextContent('Chatting as a guest: ask about appointments and when doctors are free. Log in to book or see your results.');
    expect(within(note).getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
  });
});
