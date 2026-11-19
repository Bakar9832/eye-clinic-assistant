import { useNavigate, useSearchParams } from 'react-router';
import { useApp } from '../app-context';
import { LoginNeeded } from '../components/Layout';
import { ProfileForm } from '../components/ProfileForm';
import { ZoneSelect } from '../components/ZoneSelect';

export function ProfilePage() {
  const { me } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // Came from the "complete your details" banner: go back where they were once it's done.
  const next = params.get('next')?.startsWith('/') ? params.get('next') : null;
  if (me === null) return <LoginNeeded what="see your profile" />;
  if (!me) return null;

  return (
    <div className="max-w-lg space-y-5">
      <h1 className="text-2xl">Your details</h1>
      <p className="text-sm text-slate-600">Email: {me.email}</p>
      <ProfileForm onSaved={next ? () => navigate(next) : undefined} />
      {me.hasDateOfBirth && (
        <p className="text-xs text-slate-500">Your date of birth is set. To change it, please contact the clinic: it protects your results.</p>
      )}
      <ZoneSelect />
    </div>
  );
}
