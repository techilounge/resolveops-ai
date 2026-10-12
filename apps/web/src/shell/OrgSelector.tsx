// Header organization selector: the session's active organization, switched
// via the D2 route (POST /api/v1/me/active-organization). Options come from
// the session's membership records; /me resolves organizationName server-side
// (RLS-legal self-visibility reads), so every option labels with its org name
// — the short id is the fallback for the degenerate null-name case. A 403
// renders the denied state; nothing about the target organization leaks either way.
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
            {membership.organizationName !== null
              ? `${membership.organizationName} (${membership.role})`
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
