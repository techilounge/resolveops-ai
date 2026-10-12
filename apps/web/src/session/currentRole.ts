// The active organization's server-verified role (Blueprint §7 role matrix).
// The session's /me memberships carry the role per organization — resolved
// server-side from the membership row, never from a client claim — so the
// privilege gates on the Team and incident-assignment surfaces read it from
// here instead of re-deriving it from anything user-editable.
import type { MeResponse, Organization, TenantRole } from '@resolveops/shared';
import { useSession } from './SessionProvider';

export function currentRoleFrom(me: MeResponse | null, currentOrg: Organization | null): TenantRole | null {
  if (me === null || currentOrg === null) {
    return null;
  }
  return me.memberships.find((m) => m.organizationId === currentOrg.id && m.status === 'active')?.role ?? null;
}

export function useCurrentRole(): TenantRole | null {
  const { me, currentOrg } = useSession();
  return currentRoleFrom(me, currentOrg);
}
