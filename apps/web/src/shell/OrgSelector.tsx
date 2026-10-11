// Header organization selector: the session's active organization, switched
// via the D2 route (POST /api/v1/me/active-organization). Options come from
// the session's membership records — /me carries ids and roles, not names, so
// the ACTIVE organization is labeled with its name (from
// GET /organizations/current) and the others show role + short id until the
// API exposes membership names. A 403 renders the denied state; nothing about
// the target organization leaks either way.
import { useState } from 'react';
import { ApiError } from '../api/client';
import { useSession } from '../session/SessionProvider';
import { DeniedState } from '../states/States';

type SelectorFailure = { denied: true } | { denied: false; detail: string };

export function OrgSelector() {
  const { me, currentOrg, switchOrg } = useSession();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<SelectorFailure | null>(null);

  if (!me) {
    return null;
  }

  const handleSwitch = (organizationId: string) => {
    if (organizationId === '' || organizationId === currentOrg?.id) {
      return;
    }
    setPending(true);
    setFailure(null);
    switchOrg(organizationId)
      .then(() => setPending(false))
      .catch((error: unknown) => {
        setPending(false);
        setFailure(
          error instanceof ApiError && error.code === 'FORBIDDEN'
            ? { denied: true }
            : {
                denied: false,
                detail: error instanceof Error ? error.message : 'The organization could not be switched.',
              },
        );
      });
  };

  const activeMembership: typeof me.memberships[number] | undefined =
    currentOrg === null
      ? undefined
      : me.memberships.find((membership) => membership.organizationId === currentOrg.id);

  return (
    <div className="live-org">
      <label className="live-org-label" htmlFor="org-selector">
        Organization
      </label>
      <select
        id="org-selector"
        value={currentOrg?.id ?? ''}
        disabled={pending || me.memberships.length === 0}
        onChange={(event) => handleSwitch(event.target.value)}
        aria-busy={pending}
      >
        {currentOrg === null ? <option value="">No active organization</option> : null}
        {me.memberships.map((membership) => (
          <option key={membership.organizationId} value={membership.organizationId}>
            {membership === activeMembership && currentOrg !== null
              ? `${currentOrg.name} (${membership.role})`
              : `${membership.role} · ${membership.organizationId.slice(0, 8)}`}
          </option>
        ))}
      </select>
      {pending ? (
        <span className="live-org-pending" role="status">
          Switching…
        </span>
      ) : null}
      {failure !== null ? (
        <div className="live-org-failure">
          {failure.denied ? (
            <DeniedState onDismiss={() => setFailure(null)} />
          ) : (
            <DeniedState detail={failure.detail} onDismiss={() => setFailure(null)} />
          )}
        </div>
      ) : null}
    </div>
  );
}
