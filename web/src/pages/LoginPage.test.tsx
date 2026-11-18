import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEMO, mockApi, renderApp } from '../test/render';

/** A fake API whose GET /me answers according to whether login has happened. */
type Answer = { status?: number; body?: unknown };
function loginApi(answers: { login?: Answer; setPassword?: Answer } = {}) {
  let loggedIn = false;
  const succeed =
    (answer: Answer = { body: { loggedIn: true } }) =>
    () => {
      if ((answer.status ?? 200) === 200) loggedIn = true;
      return answer;
    };
  const api = mockApi({
    'GET /me': () => (loggedIn ? { body: DEMO } : { status: 401, body: { error: 'UNAUTHENTICATED', reasons: [] } }),
    'POST /auth/login': succeed(answers.login),
    'POST /auth/request-code': { status: 202, body: { message: 'sent' } },
    'POST /auth/set-password': succeed(answers.setPassword),
    'POST /auth/demo': succeed(),
    'POST /chat': { body: { conversationId: 'c', reply: 'Hi', cards: [] } },
  });
  return api;
}

/** The login card (the header has its own "Log in" link). */
const card = () => screen.getByRole('heading', { level: 1 }).parentElement!;

describe('logging in', () => {
  it('W5. email and password, then logged in', async () => {
    const api = loginApi();
    renderApp('/login');

    await userEvent.type(screen.getByLabelText('Email'), 'demo.patient@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'my-password-1');
    await userEvent.click(within(card()).getByRole('button', { name: 'Log in' }));

    expect(await screen.findByRole('button', { name: 'Log out' })).toBeInTheDocument();
    expect(api.calls.find((c) => c.path === '/auth/login')?.body).toEqual({ email: 'demo.patient@example.com', password: 'my-password-1' });
  });

  it("W5b. a wrong password shows the API's message", async () => {
    loginApi({
      login: { status: 401, body: { error: 'INVALID_LOGIN', reasons: [{ code: 'INVALID_LOGIN', message: 'Email or password is incorrect.' }] } },
    });
    renderApp('/login');
    await userEvent.type(screen.getByLabelText('Email'), 'demo.patient@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password');
    await userEvent.click(within(card()).getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
  });

  it('W5c. too many failed logins are explained', async () => {
    loginApi({ login: { status: 429, body: { error: 'RATE_LIMITED', reasons: [] } } });
    renderApp('/login');
    await userEvent.type(screen.getByLabelText('Email'), 'demo.patient@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'whatever-1');
    await userEvent.click(within(card()).getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('wait a few minutes');
  });

  it('W5d. create an account: email, then the code and a password, then logged in', async () => {
    const api = loginApi();
    renderApp('/login');

    await userEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    await userEvent.type(screen.getByLabelText('Email'), 'new.person@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    await userEvent.type(await screen.findByLabelText('Code'), '123456');
    await userEvent.type(screen.getByLabelText(/Choose a password/), 'a-new-password');
    await userEvent.click(within(card()).getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('button', { name: 'Log out' })).toBeInTheDocument();
    expect(api.calls.find((c) => c.path === '/auth/request-code')?.body).toEqual({ email: 'new.person@example.com' });
    expect(api.calls.find((c) => c.path === '/auth/set-password')?.body).toEqual({
      email: 'new.person@example.com',
      code: '123456',
      password: 'a-new-password',
    });
  });

  it('W5e. forgot password uses the same code flow; a wrong code gets a friendly message', async () => {
    loginApi({ setPassword: { status: 401, body: { error: 'INVALID_CODE', reasons: [] } } });
    renderApp('/login');

    await userEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Email'), 'demo.patient@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    await userEvent.type(await screen.findByLabelText('Code'), '000000');
    await userEvent.type(screen.getByLabelText(/New password/), 'another-password');
    await userEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('wrong or has expired');
  });

  it('W5f. a new password must be at least 8 characters before it is sent', async () => {
    const api = loginApi();
    renderApp('/login');
    await userEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    await userEvent.type(screen.getByLabelText('Email'), 'new.person@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    await userEvent.type(await screen.findByLabelText('Code'), '123456');
    await userEvent.type(screen.getByLabelText(/Choose a password/), 'short');
    await userEvent.click(within(card()).getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('at least 8 characters');
    expect(api.calls.some((c) => c.path === '/auth/set-password')).toBe(false);
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
