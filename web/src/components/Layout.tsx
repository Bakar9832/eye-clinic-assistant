import { useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../api/client';
import { useApp } from '../app-context';
import { ZoneSelect } from './ZoneSelect';

const nav = [
  { to: '/', label: 'Chat', hint: 'Ask the assistant' },
  { to: '/calendar', label: 'Book', hint: 'Free times by day' },
  { to: '/my', label: 'My appointments', hint: 'Move or cancel' },
  { to: '/results', label: 'Results', hint: "Your doctor's note" },
];

/**
 * Wide screens: a sidebar with the main sections and the clinic's details, and the page
 * beside it. Narrow screens: the sections move into the header.
 */
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
    <div className="flex h-dvh flex-col">
      <header className="shrink-0 border-b bg-white">
        <div className="mx-auto flex max-w-[112rem] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link to="/" className="text-lg font-semibold text-brand-700">
            {clinic?.name ?? 'Eye Clinic'}
          </Link>
          <nav aria-label="Sections" className="flex gap-4 lg:hidden">
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
          <div className="ml-auto flex flex-wrap items-center gap-4">
            <ZoneSelect />
            {me ? (
              <span className="flex items-center gap-3">
                <span className="text-slate-600">{me.fullName ?? me.email}</span>
                <NavLink
                  to="/profile"
                  className={({ isActive }) =>
                    `rounded border px-3 py-1 ${isActive ? 'border-brand-600 text-brand-700' : 'border-slate-300 text-slate-700 hover:border-brand-600 hover:text-brand-700'}`
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
                <Link to="/login" className="rounded bg-brand-600 px-4 py-1.5 text-white">
                  Log in
                </Link>
              )
            )}
          </div>
        </div>
      </header>
      <ProfileBanner />
      <div className="mx-auto flex min-h-0 w-full max-w-[112rem] flex-1 gap-6 px-4 py-4 lg:px-6">
        <aside className="hidden w-64 shrink-0 overflow-y-auto lg:block">
          <div className="space-y-6">
            <nav aria-label="Sections (sidebar)" className="space-y-1">
              {nav.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) =>
                    `block rounded-lg px-4 py-3 ${isActive ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-brand-50 hover:text-brand-800'}`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span className="block font-medium">{item.label}</span>
                      <span className={`block text-sm ${isActive ? 'text-brand-50' : 'text-slate-500'}`}>{item.hint}</span>
                    </>
                  )}
                </NavLink>
              ))}
            </nav>
            <ClinicCard />
          </div>
        </aside>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <footer className="shrink-0 border-t py-1.5 text-center text-xs text-slate-500">
        Demo project with made-up data only. Not a real clinic, and nothing here is medical advice.
      </footer>
    </div>
  );
}

/** The clinic's doctors and time zone: what a patient asks about before booking. */
function ClinicCard() {
  const { clinic } = useApp();
  if (!clinic) return null;
  const city = clinic.timezone.split('/').at(-1)?.replace(/_/g, ' ');
  return (
    <div className="space-y-2 rounded-lg border bg-white p-4 text-sm">
      <h2 className="font-medium text-slate-800">{clinic.name}</h2>
      <p className="text-slate-600">Times are shown in clinic time ({city}).</p>
      {clinic.doctors.length > 0 && (
        <div>
          <p className="text-slate-500">Doctors</p>
          <ul className="mt-1 space-y-0.5 text-slate-700">
            {clinic.doctors.map((d) => (
              <li key={d.id}>{d.displayName}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-slate-500">Sudden vision loss, severe pain or an eye injury? Go to emergency care now.</p>
    </div>
  );
}

/** Until a patient has a name and date of birth they can't book or see results, so say so everywhere. */
function ProfileBanner() {
  const { me } = useApp();
  const location = useLocation();
  if (!me || me.profileComplete || location.pathname === '/profile') return null;
  return (
    <div role="status" className="shrink-0 border-b border-amber-200 bg-amber-50">
      <div className="mx-auto flex max-w-[112rem] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-amber-900">
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
