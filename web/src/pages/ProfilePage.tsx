import { useApp } from '../app-context';
import { LoginNeeded } from '../components/Layout';
import { ProfileForm } from '../components/ProfileForm';
import { ZoneSelect } from '../components/ZoneSelect';

export function ProfilePage() {
  const { me } = useApp();
  if (me === null) return <LoginNeeded what="see your profile" />;
  if (!me) return null;

  return (
    <div className="max-w-md space-y-5">
      <h1 className="text-xl font-semibold">Your details</h1>
      <p className="text-sm text-slate-600">Email: {me.email}</p>
      <ProfileForm />
      {me.hasDateOfBirth && (
        <p className="text-xs text-slate-500">Your date of birth is set. To change it, please contact the clinic: it protects your results.</p>
      )}
      <ZoneSelect />
    </div>
  );
}
