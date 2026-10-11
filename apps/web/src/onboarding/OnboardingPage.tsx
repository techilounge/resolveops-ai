// /onboarding — the post-login setup step (Blueprint §4.4). States:
// already-member (pick an organization or create one), create-org happy path
// (create → membership verification → switch → /app), API error (retryable),
// denied (403), and the membership-verification failure the acceptance cases
// name: the API said "created" but the membership is not visible on /me.
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { CreateOrganizationRequestSchema } from '@resolveops/shared';
import { ApiError } from '../api/client';
import { createOrganization, getMe, switchActiveOrganization } from '../api/endpoints';
import { POST_LOGIN_REDIRECT_KEY } from '../guard/RequireAuth';
import { useSession } from '../session/SessionProvider';
import { DeniedState, PanelError } from '../states/States';

type OnboardingFailure =
  | { kind: 'denied' }
  | { kind: 'error'; detail: string }
  | { kind: 'verification'; detail: string };

export function OnboardingPage() {
  const { me, currentOrg, refresh, switchOrg } = useSession();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<OnboardingFailure | null>(null);

  if (!me) {
    return null;
  }

  // Restore the guarded path that triggered sign-in (sessionStorage survives
  // the full-page OIDC round-trip); /app is the default landing spot.
  const destination = (): string => {
    const stored = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY);
    sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY);
    return stored !== null && stored.startsWith('/app') ? stored : '/app';
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = CreateOrganizationRequestSchema.safeParse({ name: name.trim() });
    if (!parsed.success) {
      setFieldError('Enter an organization name (1–200 characters).');
      return;
    }
    setFieldError(null);
    setSubmitting(true);
    setFailure(null);
    const membershipsBefore = new Set(me.memberships.map((membership) => membership.organizationId));
    createOrganization(parsed.data.name)
      .then(async (organization) => {
        // Membership verification: the new organization must be visible on
        // GET /me — either named in the create response or as a membership
        // delta. A missing delta means the create did not fully land.
        const after = await getMe();
        const newMembership =
          organization !== null
            ? after.memberships.find((membership) => membership.organizationId === organization.id)
            : after.memberships.find((membership) => !membershipsBefore.has(membership.organizationId));
        if (newMembership === undefined) {
          setFailure({
            kind: 'verification',
            detail: 'The organization was created, but your membership is not visible yet. Try refreshing.',
          });
          return;
        }
        await switchActiveOrganization(newMembership.organizationId);
        await refresh();
        navigate(destination(), { replace: true });
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'FORBIDDEN') {
          setFailure({ kind: 'denied' });
          return;
        }
        setFailure({
          kind: 'error',
          detail: error instanceof Error ? error.message : 'The organization could not be created.',
        });
      })
      .finally(() => setSubmitting(false));
  };

  const handleOpen = (organizationId: string) => {
    setSubmitting(true);
    switchOrg(organizationId)
      .then(() => navigate(destination(), { replace: true }))
      .catch((error: unknown) => {
        setFailure(
          error instanceof ApiError && error.code === 'FORBIDDEN'
            ? { kind: 'denied' }
            : { kind: 'error', detail: error instanceof Error ? error.message : 'The organization could not be opened.' },
        );
      })
      .finally(() => setSubmitting(false));
  };

  const hasMemberships = me.memberships.length > 0;

  return (
    <div className="live-onboarding">
      <section className="live-panel" aria-labelledby="onboarding-title">
        <span className="live-kicker">SETUP</span>
        <h1 id="onboarding-title">Set up your workspace</h1>
        <p className="live-lede">
          {hasMemberships
            ? 'You already belong to an organization. Open it, or create a new one.'
            : 'Create your organization to start using ResolveOps. You will be its first member.'}
        </p>

        {hasMemberships ? (
          <div className="live-onboarding-orgs">
            <h2>Your organizations</h2>
            <ul className="live-org-list">
              {me.memberships.map((membership) => (
                <li key={membership.organizationId}>
                  <button
                    type="button"
                    className="live-button live-button-subtle"
                    disabled={submitting}
                    onClick={() => handleOpen(membership.organizationId)}
                  >
                    {currentOrg?.id === membership.organizationId
                      ? `Continue as ${currentOrg.name} (${membership.role})`
                      : `Open ${membership.role} · ${membership.organizationId.slice(0, 8)}`}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <form className="live-form" onSubmit={handleSubmit}>
          <h2>{hasMemberships ? 'Create another organization' : 'Create your organization'}</h2>
          <label htmlFor="org-name">Organization name</label>
          <input
            id="org-name"
            name="org-name"
            type="text"
            value={name}
            maxLength={200}
            placeholder="e.g. City of Austin IT"
            autoComplete="organization"
            disabled={submitting}
            onChange={(event) => setName(event.target.value)}
          />
          {fieldError !== null ? (
            <p className="live-field-error" role="alert">
              {fieldError}
            </p>
          ) : null}
          <button type="submit" className="live-button" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create organization'}
          </button>
        </form>

        {failure !== null && failure.kind === 'denied' ? <DeniedState /> : null}
        {failure !== null && failure.kind === 'error' ? <PanelError detail={failure.detail} /> : null}
        {failure !== null && failure.kind === 'verification' ? (
          <PanelError detail={failure.detail} onRetry={() => void refresh()} />
        ) : null}
      </section>
    </div>
  );
}
