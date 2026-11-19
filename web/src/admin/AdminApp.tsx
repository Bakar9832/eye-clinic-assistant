import { useQueryClient } from '@tanstack/react-query';
import { NavLink, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router';
import { api } from '../api/client';
import { useApp } from '../app-context';
import { AdminLoginPage } from './AdminLoginPage';
import { GlassesPage } from './GlassesPage';
import { GuardrailsPage } from './GuardrailsPage';
import { HandoffsPage } from './HandoffsPage';
import { NewBookingPage } from './NewBookingPage';
import { SchedulePage } from './SchedulePage';
import { SettingsPage } from './SettingsPage';
import { useStaffMe, type StaffRole } from './staff-api';

/** Which sections each role sees. The API enforces the same rules; this just hides what won't work. */
const SECTIONS: { to: string; label: string; roles: StaffRole[] }[] = [
  { to: '/admin', label: 'Schedule', roles: ['DOCTOR', 'RECEPTION', 'ADMIN'] },
  { to: '/admin/handoffs', label: 'Handoffs', roles: ['DOCTOR', 'RECEPTION', 'ADMIN'] },
  { to: '/admin/guardrails', label: 'Guardrails', roles: ['DOCTOR', 'RECEPTION', 'ADMIN'] },
  { to: '/admin/glasses', label: 'Glasses', roles: ['DOCTOR', 'RECEPTION', 'ADMIN'] },
  { to: '/admin/book', label: 'New booking', roles: ['RECEPTION', 'ADMIN'] },
  { to: '/admin/settings', label: 'Settings', roles: ['ADMIN'] },
];

export function AdminApp() {
  return (
    <Routes>
      <Route path="login" element={<AdminLoginPage />} />
      <Route element={<AdminLayout />}>
        <Route index element={<SchedulePage />} />
        <Route path="handoffs" element={<HandoffsPage />} />
        <Route path="guardrails" element={<GuardrailsPage />} />
        <Route path="glasses" element={<GlassesPage />} />
        <Route path="book" element={<RoleOnly roles={['RECEPTION', 'ADMIN']}><NewBookingPage /></RoleOnly>} />
        <Route path="settings" element={<RoleOnly roles={['ADMIN']}><SettingsPage /></RoleOnly>} />
      </Route>
    </Routes>
  );
}

function AdminLayout() {
  const staff = useStaffMe();
  const { clinic } = useApp();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  if (staff === undefined) return <p className="p-6 text-ink-muted">Loading…</p>;
  if (staff === null) return <Navigate to="/admin/login" replace />;

  async function logout() {
    try {
      await api('/staff/auth/logout', { method: 'POST' });
    } catch {
      // A waking server or a lost connection: this browser still forgets the staff member.
    }
    queryClient.removeQueries({ queryKey: ['staff-me'] });
    navigate('/admin/login');
  }

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-line">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
          <span className="font-semibold tracking-tight whitespace-nowrap text-ink">{clinic?.name ?? 'Clinic'}</span>
          <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-ink-muted">Staff</span>
          <span className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden text-ink sm:inline">
              {staff.displayName} <span className="text-ink-muted">· {staff.role.toLowerCase()}</span>
            </span>
            <button onClick={logout} className="rounded-lg px-2.5 py-1.5 text-ink-muted hover:bg-slate-100 hover:text-ink">
              Log out
            </button>
          </span>
        </div>
        <nav className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-3 pb-2">
          {SECTIONS.filter((s) => s.roles.includes(staff.role)).map((s) => (
            <NavLink
              key={s.to}
              to={s.to}
              end
              className={({ isActive }) =>
                `rounded-lg px-3 py-1.5 text-sm whitespace-nowrap ${isActive ? 'bg-slate-100 font-medium text-ink' : 'text-ink-muted hover:bg-slate-50 hover:text-ink'}`
              }
            >
              {s.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}

function RoleOnly({ roles, children }: { roles: StaffRole[]; children: React.ReactNode }) {
  const staff = useStaffMe();
  if (!staff) return null;
  return roles.includes(staff.role) ? <>{children}</> : <p>This section is not available for your role.</p>;
}
