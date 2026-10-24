import { Route, Routes } from 'react-router';
import { AdminApp } from './admin/AdminApp';
import { Layout } from './components/Layout';
import { CalendarPage } from './pages/CalendarPage';
import { ChatPage } from './pages/ChatPage';
import { LoginPage } from './pages/LoginPage';
import { MyAppointmentsPage } from './pages/MyAppointmentsPage';
import { ProfilePage } from './pages/ProfilePage';
import { ResultsPage } from './pages/ResultsPage';

export function App() {
  return (
    <Routes>
      {/* The staff area has its own login and layout. */}
      <Route path="admin/*" element={<AdminApp />} />
      <Route element={<Layout />}>
        <Route index element={<ChatPage />} />
        <Route path="calendar" element={<CalendarPage />} />
        <Route path="my" element={<MyAppointmentsPage />} />
        <Route path="results" element={<ResultsPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="login" element={<LoginPage />} />
      </Route>
    </Routes>
  );
}
