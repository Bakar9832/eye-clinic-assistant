import { useQueryClient } from '@tanstack/react-query';
import { NavLink, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router';
import { api } from '../api/client';
import { useApp } from '../app-context';
import { AdminLoginPage } from './AdminLoginPage';
import { HandoffsPage } from './HandoffsPage';
import { NewBookingPage } from './NewBookingPage';
import { SchedulePage } from './SchedulePage';
import { SettingsPage } from './SettingsPage';
import { useStaffMe, type StaffRole } from './staff-api';

/** Which sections each role sees. The API enforces the same rules; this just hides what won't work. */
const SECTIONS: { to: string; label: string; roles: StaffRole[] }[] = [
  { to: '/admin', label: 'Schedule', roles: ['DOCTOR', 'RECEPTION', 'ADMIN'] },
  { to: '/admin/handoffs', label: 'Handoffs', roles: ['DOCTOR', 'RECEPTION', 'ADMIN'] },
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

  if (staff === undefined) return <p className="p-6 text-slate-500">Loading…</p>;
  if (staff === null) return <Navigate to="/admin/login" replace />;

  async function logout() {
    await api('/staff/auth/logout', { method: 'POST' });
    queryClient.removeQueries({ queryKey: ['staff-me'] });
    navigate('/admin/login');
  }

  return (
    <div className="min-h-screen">
      <header className="border-b bg-slate-800 text-slate-100">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="font-semibold">{clinic?.name ?? 'Clinic'} · Staff</span>
          <nav className="flex gap-4 text-sm">
            {SECTIONS.filter((s) => s.roles.includes(staff.role)).map((s) => (
              <NavLink key={s.to} to={s.to} end className={({ isActive }) => (isActive ? 'font-medium text-white' : 'text-slate-300 hover:text-white')}>
                {s.label}
              </NavLink>
            ))}
          </nav>
          <span className="ml-auto flex items-center gap-3 text-sm">
            <span>
              {staff.displayName} <span className="text-slate-400">({staff.role.toLowerCase()})</span>
            </span>
            <button onClick={logout} className="text-slate-300 hover:text-white">
              Log out
            </button>
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
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
