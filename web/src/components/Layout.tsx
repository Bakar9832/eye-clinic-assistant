import { useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../api/client';
import { useApp } from '../app-context';
import { ZoneSelect } from './ZoneSelect';

const nav = [
  { to: '/', label: 'Chat' },
  { to: '/calendar', label: 'Book' },
  { to: '/my', label: 'My appointments' },
  { to: '/results', label: 'Results' },
];

export function Layout() {
  const { clinic, me } = useApp();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    queryClient.clear();
    navigate('/');
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link to="/" className="font-semibold text-brand-700">
            {clinic?.name ?? 'Eye Clinic'}
          </Link>
          <nav className="flex gap-4 text-sm">
            {nav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) => (isActive ? 'font-medium text-brand-700' : 'text-slate-600 hover:text-brand-700')}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-4">
            <ZoneSelect />
            {me ? (
              <span className="flex items-center gap-3 text-sm">
                <span className="text-slate-600">{me.fullName ?? me.email}</span>
                <NavLink
                  to="/profile"
                  className={({ isActive }) =>
                    `rounded border px-2 py-0.5 ${isActive ? 'border-brand-600 text-brand-700' : 'border-slate-300 text-slate-700 hover:border-brand-600 hover:text-brand-700'}`
                  }
                >
                  Your details
                </NavLink>
                <button onClick={logout} className="text-slate-500 hover:text-brand-700">
                  Log out
                </button>
              </span>
            ) : (
              me === null && (
                <Link to="/login" className="rounded bg-brand-600 px-3 py-1 text-sm text-white">
                  Log in
                </Link>
              )
            )}
          </div>
        </div>
      </header>
      <ProfileBanner />
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">
        <Outlet />
      </main>
      <footer className="border-t py-3 text-center text-xs text-slate-500">
        Demo project with made-up data only. Not a real clinic, and nothing here is medical advice.
      </footer>
    </div>
  );
}

/** Until a patient has a name and date of birth they can't book or see results, so say so everywhere. */
function ProfileBanner() {
  const { me } = useApp();
  const location = useLocation();
  if (!me || me.profileComplete || location.pathname === '/profile') return null;
  return (
    <div role="status" className="border-b border-amber-200 bg-amber-50">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm text-amber-900">
        <span>Add your name and date of birth to book appointments or see results.</span>
        <Link to={`/profile?next=${encodeURIComponent(location.pathname)}`} className="font-medium underline underline-offset-2">
          Complete your details →
        </Link>
      </div>
    </div>
  );
}

/** For pages that need a logged-in patient. */
export function LoginNeeded({ what }: { what: string }) {
  return (
    <div className="rounded-lg border bg-white p-6 text-center">
      <p className="mb-3">Please log in to {what}.</p>
      <Link to={`/login?next=${encodeURIComponent(location.pathname)}`} className="rounded bg-brand-600 px-4 py-2 text-white">
        Log in
      </Link>
    </div>
  );
}
