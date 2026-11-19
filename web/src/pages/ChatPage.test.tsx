import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEMO, mockApi, renderApp } from '../test/render';
import { DOB_CONFIRMED_MESSAGE, OTHER_TIME_MESSAGE } from './ChatPage';

async function say(text: string) {
  // The box is disabled until the login check answers, as for a real visitor.
  await waitFor(() => expect(screen.getByLabelText('Message')).toBeEnabled());
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

  it('W7b. a quick action sends its message; guests only see the ones that work without logging in', async () => {
    const api = mockApi({ 'POST /chat': { body: { conversationId: 'c', reply: 'Sure.', cards: [] } } });
    renderApp('/');

    // jsdom ignores the CSS that shows one set per screen size, so both sets are present.
    const book = await screen.findAllByRole('button', { name: 'Book an eye test' });
    expect(screen.queryByRole('button', { name: 'Are my results in?' })).not.toBeInTheDocument();
    await userEvent.click(book[0]);

    expect(await screen.findByText('Sure.')).toBeInTheDocument();
    expect(api.calls.find((c) => c.path === '/chat')?.body).toMatchObject({ message: "I'd like to book a routine eye test." });
  });

  it('W7c. logged in, the side panel shows the next booked visit', async () => {
    mockApi({
      'GET /me': { body: DEMO },
      'GET /me/appointments': {
        body: [
          { id: 'a1', reference: 'EC-NEXT01', status: 'BOOKED', start: '2099-01-05T05:00:00.000Z', end: '2099-01-05T05:30:00.000Z', type: { code: 'ROUTINE_EYE_TEST', name: 'Routine eye test', typicalMin: 25 }, doctor: { displayName: 'Dr Ayesha' }, prepInstructions: '' },
          { id: 'a2', reference: 'EC-OLD001', status: 'COMPLETED', start: '2020-01-05T05:00:00.000Z', end: '2020-01-05T05:30:00.000Z', type: { code: 'FOLLOW_UP', name: 'Follow-up visit', typicalMin: 15 }, doctor: null, prepInstructions: '' },
        ],
      },
    });
    renderApp('/');

    expect(await screen.findByText('EC-NEXT01')).toBeInTheDocument();
    expect(screen.getByText('with Dr Ayesha')).toBeInTheDocument();
    expect(screen.queryByText('EC-OLD001')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Are my results in?' }).length).toBeGreaterThan(0);
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

  describe('W-FIX. the first message, Enter, and tappable times', () => {
    it('while the login check is pending the box says Connecting… and nothing can be sent; then it works', async () => {
      let answer!: () => void;
      const loaded = new Promise<void>((resolve) => (answer = resolve));
      const api = mockApi({
        'GET /me': async () => {
          await loaded;
          return { body: DEMO };
        },
        'POST /chat': { body: { conversationId: 'c', reply: 'Hello!', cards: [] } },
      });
      renderApp('/');

      const box = await screen.findByPlaceholderText('Connecting…');
      expect(box).toBeDisabled();
      expect(api.calls.some((c) => c.path === '/chat')).toBe(false);

      answer();
      await say('Hi');
      expect(await screen.findByText('Hello!')).toBeInTheDocument();
      expect(screen.getByText('Hi')).toBeInTheDocument(); // the message stays: no reset after loading
    });

    it('Enter sends the message, the same as the Send button', async () => {
      const api = mockApi({ 'GET /me': { body: DEMO }, 'POST /chat': { body: { conversationId: 'c', reply: 'Got it.', cards: [] } } });
      renderApp('/');
      await waitFor(() => expect(screen.getByLabelText('Message')).toBeEnabled());
      await userEvent.type(screen.getByLabelText('Message'), 'Hello there{Enter}');

      expect(await screen.findByText('Got it.')).toBeInTheDocument();
      expect(api.calls.find((c) => c.path === '/chat')?.body).toMatchObject({ message: 'Hello there' });
    });

    it('opening the chat wakes the agent service', async () => {
      const api = mockApi({ 'GET /me': { body: DEMO } });
      renderApp('/');
      await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/chat/warm')).toBe(true));
    });

    it('free times come as buttons; a tap books that time through the API', async () => {
      const start = '2030-01-07T05:00:00.000Z';
      const api = mockApi({
        'GET /me': { body: DEMO },
        'POST /chat': {
          body: {
            conversationId: 'conv-1',
            reply: 'The closest are 10:00 AM and 10:30 AM.',
            cards: [{ type: 'slot_choices', typeCode: 'FOLLOW_UP', typeName: 'Follow-up visit', slots: [{ start, doctorId: 'doc-1', doctor: 'Dr Ayesha' }, { start: '2030-01-07T05:30:00.000Z', doctorId: 'doc-1', doctor: 'Dr Ayesha' }] }],
          },
        },
        'POST /chat/conv-1/book': {
          body: { conversationId: 'conv-1', reply: 'Booked. Your reference is EC-ABC123.', cards: [{ type: 'ticket', reference: 'EC-ABC123', start, doctor: 'Dr Ayesha', prepInstructions: '' }] },
        },
      });
      renderApp('/');

      await say('When can I see Dr Ayesha on Monday?');
      const times = await screen.findByRole('region', { name: 'Free times' });
      await userEvent.click(within(times).getAllByRole('button')[0]);

      expect(await screen.findByRole('region', { name: 'Booking ticket' })).toHaveTextContent('EC-ABC123');
      expect(api.calls.find((c) => c.path === '/chat/conv-1/book')?.body).toEqual({ typeCode: 'FOLLOW_UP', start, doctorId: 'doc-1' });
    });
  });

  describe('W-CB. a stalled chat offers a call back', () => {
    const stalled = (loggedIn: boolean) => ({
      body: { conversationId: 'conv-1', reply: "We've been going round a bit. Would a call from the clinic help?", cards: [{ type: 'callback_offer', loggedIn }] },
    });

    it('logged in: one click asks for the call back through the API, not the chat', async () => {
      const api = mockApi({
        'GET /me': { body: DEMO },
        'POST /chat': stalled(true),
        'POST /chat/conv-1/callback': { body: { conversationId: 'conv-1', reply: 'Done. A member of staff will contact you at demo.patient@example.com.', cards: [] } },
      });
      renderApp('/');

      await say('I still cannot find a time that works');
      const card = await screen.findByRole('region', { name: 'Call back offer' });
      await userEvent.click(within(card).getByRole('button', { name: 'Request a call back' }));

      expect(await screen.findByText(/A member of staff will contact you/)).toBeInTheDocument();
      expect(api.calls.some((c) => c.method === 'POST' && c.path === '/chat/conv-1/callback')).toBe(true);
      expect(api.calls.filter((c) => c.path === '/chat')).toHaveLength(1);
    });

    it('guests are asked to log in instead', async () => {
      mockApi({ 'POST /chat': stalled(false) });
      renderApp('/');

      await say('this is going nowhere');
      const card = await screen.findByRole('region', { name: 'Call back offer' });
      expect(within(card).queryByRole('button', { name: 'Request a call back' })).not.toBeInTheDocument();
      expect(within(card).getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
    });
  });

  describe('a booking offer: the patient answers with a button', () => {
    const OFFER = {
      type: 'booking_offer',
      typeCode: 'FOLLOW_UP',
      typeName: 'Follow-up',
      start: '2030-01-07T05:00:00Z',
      doctorId: 'doc-1',
      doctor: 'Dr Ayesha',
    };
    const offered = { body: { conversationId: 'conv-1', reply: 'Yes, 10:00 is free. Shall I confirm it, or would you like another time?', cards: [OFFER] } };

    it('W-O1. Confirm books through the API, not the chat, and shows the ticket', async () => {
      const api = mockApi({
        'GET /me': { body: DEMO },
        'POST /chat': offered,
        'POST /chat/conv-1/book': {
          body: {
            conversationId: 'conv-1',
            reply: 'Booked: Follow-up, Monday 7 January, 10:00 clinic time with Dr Ayesha. Your reference is EC-ABC123.',
            cards: [{ type: 'ticket', reference: 'EC-ABC123', start: OFFER.start, doctor: 'Dr Ayesha', prepInstructions: 'Bring your glasses.' }],
          },
        },
      });
      renderApp('/');

      await say('Can I book a follow-up Monday at 10?');
      const card = await screen.findByRole('region', { name: 'Booking offer' });
      await userEvent.click(within(card).getByRole('button', { name: 'Confirm' }));

      expect(await screen.findByRole('region', { name: 'Booking ticket' })).toHaveTextContent('EC-ABC123');
      const book = api.calls.find((c) => c.path === '/chat/conv-1/book');
      expect(book?.body).toEqual({ typeCode: 'FOLLOW_UP', start: OFFER.start, doctorId: 'doc-1' });
      expect(api.calls.filter((c) => c.path === '/chat')).toHaveLength(1);
      // The used offer can't be pressed again.
      expect(within(card).getByRole('button', { name: 'Confirm' })).toBeDisabled();
    });

    it('W-O2. "Choose another time" carries on the conversation and books nothing', async () => {
      const api = mockApi({
        'GET /me': { body: DEMO },
        'POST /chat': (call) =>
          call.body?.message === OTHER_TIME_MESSAGE ? { body: { conversationId: 'conv-1', reply: 'Which day suits you?', cards: [] } } : offered,
      });
      renderApp('/');

      await say('Can I book a follow-up Monday at 10?');
      const card = await screen.findByRole('region', { name: 'Booking offer' });
      await userEvent.click(within(card).getByRole('button', { name: 'Choose another time' }));

      expect(await screen.findByText('Which day suits you?')).toBeInTheDocument();
      expect(api.calls.some((c) => c.path.endsWith('/book'))).toBe(false);
    });

    it('W-O3. a taken time since the offer shows the reason', async () => {
      mockApi({
        'GET /me': { body: DEMO },
        'POST /chat': offered,
        'POST /chat/conv-1/book': { status: 422, body: { error: 'INVALID_SLOT', reasons: [{ code: 'NOT_FREE', message: 'That time is no longer free.' }] } },
      });
      renderApp('/');

      await say('Can I book a follow-up Monday at 10?');
      await userEvent.click(within(await screen.findByRole('region', { name: 'Booking offer' })).getByRole('button', { name: 'Confirm' }));

      expect(await screen.findByRole('alert')).toBeInTheDocument();
    });
  });
});
