import { Button } from '../../components/Button';
import { fetchProfile } from '../../api/client';

export function ProfileCard() {
  return <Button label="Load profile" onClick={() => void fetchProfile()} />;
}
