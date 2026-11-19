import { useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, CalendarDays, CircleAlert, FileText, LogOut, MessageSquare, UserRound } from 'lucide-react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../api/client';
import { useApp } from '../app-context';
import { ZoneSelect } from './ZoneSelect';

const nav = [
  { to: '/', label: 'Chat', icon: MessageSquare },
  { to: '/calendar', label: 'Book', icon: CalendarDays },
  { to: '/my', label: 'My appointments', icon: CalendarCheck },
  { to: '/results', label: 'Results', icon: FileText },
];

const container = 'mx-auto w-full max-w-[112rem] px-4 lg:px-6';

/**
 * Wide screens: a light sidebar with the sections. Phones: a bottom tab bar. The header
 * draws at once and never waits for the login check (a sleeping server can take a minute).
 */
export function Layout() {
  const { clinic, me } = useApp();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  async function logout() {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      // A waking server or a lost connection: this browser still forgets the patient below.
    }
    // Set "me" to nobody outright: clear() alone left the header showing the old answer
    // until the next refetch. Drop everything personal; the clinic's details stay.
    queryClient.setQueryData(['me'], null);
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' && q.queryKey[0] !== 'clinic' });
    navigate('/');
  }

  return (
    <div className="flex h-dvh flex-col bg-white">
      <header className="shrink-0 border-b border-line">
        <div className={`${container} flex h-14 items-center gap-4`}>
          <Link to="/" className="shrink-0 font-semibold tracking-tight whitespace-nowrap text-ink">
            {clinic?.name ?? 'Eye Clinic'}
          </Link>
          <AssistantStatus />
          <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-4">
            <ZoneSelect />
            {me ? (
              <span className="flex items-center gap-1 sm:gap-3">
                <span className="hidden text-ink-muted md:inline">{me.fullName ?? me.email}</span>
                <NavLink
                  to="/profile"
                  className={({ isActive }) =>
                    `inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 ${isActive ? 'bg-slate-100 text-ink' : 'text-ink-muted hover:bg-slate-100 hover:text-ink'}`
                  }
                >
                  <UserRound aria-hidden className="size-4" />
                  <span className="max-sm:sr-only">Your details</span>
                </NavLink>
                <button onClick={logout} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-ink-muted hover:bg-slate-100 hover:text-ink">
                  <LogOut aria-hidden className="size-4" />
                  <span className="max-sm:sr-only">Log out</span>
                </button>
              </span>
            ) : (
              // Shown at once, also while it isn't known yet who is logged in.
              <span className="flex items-center gap-2">
                <Link to="/login" className="rounded-lg bg-ink px-3.5 py-1.5 font-medium whitespace-nowrap text-white hover:bg-slate-800">
                  Log in
                </Link>
                <Link to="/login?mode=signup" className="rounded-lg px-2 py-1.5 whitespace-nowrap text-ink hover:bg-slate-100">
                  Sign up
                </Link>
              </span>
            )}
          </div>
        </div>
      </header>
      <ConnectionNotice />
      <ProfileBanner />
      <div className={`${container} flex min-h-0 flex-1 gap-8`}>
        <aside className="hidden w-56 shrink-0 overflow-y-auto py-6 lg:block">
          <nav aria-label="Sections (sidebar)" className="space-y-0.5">
            {nav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-lg border-l-2 px-3 py-2 ${isActive ? 'border-accent bg-slate-100 font-medium text-ink' : 'border-transparent text-ink-muted hover:bg-slate-50 hover:text-ink'}`
                }
              >
                <item.icon aria-hidden className="size-4 shrink-0" />
                {item.label}
              </NavLink>
            ))}
          </nav>
        </aside>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto py-6">
          <Outlet />
        </main>
      </div>
      <p className="shrink-0 border-t border-line">
        <span className={`${container} flex items-center gap-2 py-2 text-sm text-ink-muted`}>
          <CircleAlert aria-hidden className="size-4 shrink-0 text-danger" />
          Sudden vision loss, severe pain or an eye injury? Go to emergency care now.
        </span>
      </p>
      <nav aria-label="Sections" className="shrink-0 border-t border-line bg-white lg:hidden">
        <div className="grid grid-cols-4">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex flex-col items-center gap-0.5 py-2 text-xs ${isActive ? 'text-accent' : 'text-ink-muted hover:text-ink'}`
              }
            >
              <item.icon aria-hidden className="size-5" />
              <span className="truncate">{item.label === 'My appointments' ? 'Appointments' : item.label}</span>
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}

/** A small dot: green when the clinic API answers, amber while it is waking up or unreachable. */
function AssistantStatus() {
  const { connection, clinic } = useApp();
  const online = connection === 'ok' && Boolean(clinic);
  return (
    <span className="hidden items-center gap-1.5 text-sm text-ink-muted sm:inline-flex">
      <span aria-hidden className={`size-2 rounded-full ${online ? 'bg-success' : 'bg-warning'}`} />
      {online ? 'Assistant online' : 'Waking up'}
    </span>
  );
}

/**
 * Says what's happening while the clinic API is slow to answer (a free-tier server waking
 * up) and offers Retry when it can't be reached. It keeps trying in the background either way.
 */
function ConnectionNotice() {
  const { connection, retryConnection } = useApp();
  if (connection === 'ok') return null;
  return (
    <div role="status" className="shrink-0 border-b border-line bg-surface">
      <div className={`${container} flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-ink-muted`}>
        {connection === 'waking' ? (
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className="size-2 animate-pulse rounded-full bg-warning" />
            Waking up the assistant, this can take up to a minute.
          </span>
        ) : (
          <>
            <span>Can't reach the clinic right now. We'll keep trying.</span>
            <button onClick={retryConnection} className="rounded-lg border border-line bg-white px-3 py-1 text-ink hover:border-slate-400">
              Retry
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Until a patient has a name and date of birth they can't book or see results, so say so everywhere. */
function ProfileBanner() {
  const { me } = useApp();
  const location = useLocation();
  if (!me || me.profileComplete || location.pathname === '/profile') return null;
  return (
    <div role="status" className="shrink-0 border-b border-amber-200 bg-warning-soft">
      <div className={`${container} flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-amber-900`}>
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
    <div className="mx-auto max-w-md rounded-lg border border-line p-8 text-center">
      <p className="mb-4 text-ink-muted">Please log in to {what}.</p>
      <Link to={`/login?next=${encodeURIComponent(location.pathname)}`} className="rounded-lg bg-ink px-4 py-2 font-medium text-white hover:bg-slate-800">
        Log in
      </Link>
    </div>
  );
}
