import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEMO, mockApi, renderApp } from '../test/render';

/** A fake API whose GET /me answers according to whether login has happened. */
function loginApi(verify: { status?: number; body?: unknown } = { body: { loggedIn: true } }) {
  let loggedIn = false;
  const api = mockApi({
    'GET /me': () => (loggedIn ? { body: DEMO } : { status: 401, body: { error: 'UNAUTHENTICATED', reasons: [] } }),
    'POST /auth/request-code': { status: 202, body: { message: 'sent' } },
    'POST /auth/verify': () => {
      if ((verify.status ?? 200) === 200) loggedIn = true;
      return verify;
    },
    'POST /auth/demo': () => {
      loggedIn = true;
      return { body: { loggedIn: true } };
    },
    'POST /chat': { body: { conversationId: 'c', reply: 'Hi', cards: [] } },
  });
  return api;
}

describe('logging in', () => {
  it('W5. email, then the 6-digit code, then logged in', async () => {
    const api = loginApi();
    renderApp('/login');

    await userEvent.type(screen.getByLabelText('Email'), 'demo.patient@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    await userEvent.type(await screen.findByLabelText('Code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByRole('button', { name: 'Log out' })).toBeInTheDocument();
    expect(api.calls.find((c) => c.path === '/auth/verify')?.body).toEqual({ email: 'demo.patient@example.com', code: '123456' });
  });

  it('W5b. a wrong code and rate limiting get friendly messages', async () => {
    loginApi({ status: 401, body: { error: 'INVALID_CODE', reasons: [] } });
    renderApp('/login');
    await userEvent.type(screen.getByLabelText('Email'), 'demo.patient@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    await userEvent.type(await screen.findByLabelText('Code'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('wrong or has expired');
  });

  it('W5c. too many code requests are explained', async () => {
    mockApi({ 'POST /auth/request-code': { status: 429, body: { error: 'RATE_LIMITED', reasons: [] } } });
    renderApp('/login');
    await userEvent.type(screen.getByLabelText('Email'), 'demo.patient@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('wait a few minutes');
  });

  it('W6. "Try as demo patient" logs in and opens the chat', async () => {
    const api = loginApi();
    renderApp('/login');

    await userEvent.click(screen.getByRole('button', { name: 'Try as demo patient' }));

    expect(await screen.findByLabelText('Message')).toBeInTheDocument();
    expect(await screen.findByText('Demo Patient')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/auth/demo')).toBe(true);
  });
});

describe('W4. the time-zone choice', () => {
  it('is remembered in this browser and saved to the profile when logged in', async () => {
    const api = mockApi({ 'GET /me': { body: DEMO }, 'PATCH /me': { body: { ...DEMO, timezone: 'Europe/London' } } });
    renderApp('/profile');

    const select = (await screen.findAllByLabelText('Your time zone'))[0];
    await userEvent.selectOptions(select, 'Europe/London');

    expect(localStorage.getItem('viewerZone')).toBe('Europe/London');
    expect(api.calls.find((c) => c.method === 'PATCH' && c.path === '/me')?.body).toEqual({ timezone: 'Europe/London' });
  });

  it('logged out, it is only remembered in the browser', async () => {
    const api = mockApi({});
    renderApp('/');

    await userEvent.selectOptions(await screen.findByLabelText('Your time zone'), 'Europe/London');

    expect(localStorage.getItem('viewerZone')).toBe('Europe/London');
    expect(api.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it("a logged-in patient's saved zone follows them to a new browser", async () => {
    mockApi({ 'GET /me': { body: { ...DEMO, timezone: 'Pacific/Auckland' } } });
    renderApp('/');
    expect(await screen.findByDisplayValue(/Auckland/)).toBeInTheDocument();
  });
});
