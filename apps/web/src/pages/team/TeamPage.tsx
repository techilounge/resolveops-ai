// /app/team — members and invitations (Blueprint §4.4, delta D2). The roster
// route is owner/admin-gated server-side; the session's server-verified role
// decides the client-side surface so non-privileged members never fire a
// doomed request (the route audits denials): they get a graceful limited
// state instead. A privileged role that still receives 403 (role drift)
// renders the standard denied state.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { TENANT_ROLES, type MemberListResponse } from '@resolveops/shared';
import { ApiError } from '../../api/client';
import { createInvitation, listMembers } from '../../api/endpoints';
import { useCurrentRole } from '../../session/currentRole';
import { DeniedState, EmptyState, FullPageLoading, PanelError } from '../../states/States';
import { formatDay, totalPages } from '../incidents/labels';

const PAGE_SIZE = 25;

type TeamState =
  | { kind: 'loading' }
  | { kind: 'ready'; response: MemberListResponse }
  | { kind: 'error'; detail: string }
  | { kind: 'denied' };

type InviteFailure =
  | { kind: 'conflict'; detail: string }
  | { kind: 'denied' }
  | { kind: 'error'; detail: string };

const ROLE_LABELS: Record<(typeof TENANT_ROLES)[number], string> = {
  owner: 'Owner',
  admin: 'Admin',
  analyst: 'Analyst',
  technician: 'Technician',
  viewer: 'Viewer',
};

const STATUS_LABELS: Record<MemberListResponse['data'][number]['status'], string> = {
  active: 'Active',
  invited: 'Invited',
  revoked: 'Revoked',
};

export function TeamPage() {
  const role = useCurrentRole();
  const privileged = role === 'owner' || role === 'admin';

  const [state, setState] = useState<TeamState>({ kind: 'loading' });
  const [page, setPage] = useState(1);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<(typeof TENANT_ROLES)[number]>('analyst');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [inviteFailure, setInviteFailure] = useState<InviteFailure | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);

  const requestSeq = useRef(0);

  const load = useCallback((targetPage: number) => {
    const seq = ++requestSeq.current;
    setState({ kind: 'loading' });
    listMembers({ page: targetPage, pageSize: PAGE_SIZE })
      .then((response) => {
        if (requestSeq.current !== seq) return;
        setState({ kind: 'ready', response });
      })
      .catch((error: unknown) => {
        if (requestSeq.current !== seq) return;
        if (error instanceof ApiError && error.code === 'FORBIDDEN') {
          setState({ kind: 'denied' });
          return;
        }
        setState({
          kind: 'error',
          detail: error instanceof Error ? error.message : 'The member list could not be loaded.',
        });
      });
  }, []);

  useEffect(() => {
    if (!privileged) {
      return;
    }
    load(page);
  }, [privileged, page, load]);

  const handleInvite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (trimmed === '') {
      setFieldError('Enter an email address to invite.');
      return;
    }
    setFieldError(null);
    setInviteFailure(null);
    setInviteSuccess(null);
    setInviting(true);
    createInvitation({ email: trimmed, role: inviteRole })
      .then((member) => {
        setInviteSuccess(`Invitation saved — ${member.email} joins as ${ROLE_LABELS[member.role]} (status: invited).`);
        setEmail('');
        setInviteRole('analyst');
        // The roster shows pending invites; reload so the new row is visible.
        load(page);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'CONFLICT') {
          setInviteFailure({
            kind: 'conflict',
            detail: 'That email already has a membership in this organization.',
          });
          return;
        }
        if (error instanceof ApiError && error.code === 'FORBIDDEN') {
          setInviteFailure({ kind: 'denied' });
          return;
        }
        setInviteFailure({
          kind: 'error',
          detail: error instanceof Error ? error.message : 'The invitation could not be created.',
        });
      })
      .finally(() => setInviting(false));
  };

  // Session still resolving — the role is not known yet.
  if (role === null) {
    return (
      <section className="live-panel" aria-labelledby="team-title">
        <span className="live-kicker">TEAM</span>
        <h1 id="team-title">Team</h1>
        <FullPageLoading label="Checking your role…" />
      </section>
    );
  }

  // Least privilege (Blueprint §7): the roster is an owner/admin surface.
  // The client renders the limited state directly (no doomed request, no
  // audited denial noise); the server still enforces it for every caller.
  if (!privileged) {
    return (
      <section className="live-panel" aria-labelledby="team-title">
        <span className="live-kicker">TEAM</span>
        <h1 id="team-title">Team</h1>
        <div className="state-card state-empty" role="status">
          <h2>Limited view</h2>
          <p>
            The member roster and invitations are restricted to organization owners and admins. You are signed
            in with the <strong>{ROLE_LABELS[role]}</strong> role, so team administration is not available to
            you here.
          </p>
        </div>
      </section>
    );
  }

  const pages = state.kind === 'ready' ? totalPages(state.response.page.total, state.response.page.pageSize) : 1;

  return (
    <section className="live-panel" aria-labelledby="team-title">
      <span className="live-kicker">TEAM</span>
      <h1 id="team-title">Team</h1>
      <p className="live-lede">
        Members of your organization, their roles, and pending invitations. You are signed in as {ROLE_LABELS[role]}.
      </p>

      {state.kind === 'loading' ? <FullPageLoading label="Loading members…" /> : null}
      {state.kind === 'denied' ? (
        <DeniedState detail="The member roster is restricted to owners and admins." />
      ) : null}
      {state.kind === 'error' ? <PanelError detail={state.detail} onRetry={() => load(page)} /> : null}
      {state.kind === 'ready' ? (
        state.response.data.length === 0 ? (
          <EmptyState
            title="No members yet"
            detail="Your organization always has at least one member (its creator). If the list is empty, reload."
          />
        ) : (
          <>
            <p className="live-count" role="status">
              Page {state.response.page.page} of {pages} · {state.response.page.total}{' '}
              {state.response.page.total === 1 ? 'member' : 'members'}
            </p>
            <table className="live-table">
              <thead>
                <tr>
                  <th scope="col">Member</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Joined</th>
                </tr>
              </thead>
              <tbody>
                {state.response.data.map((member) => (
                  <tr key={member.userId}>
                    <td>{member.displayName}</td>
                    <td>{member.email}</td>
                    <td>
                      <span className="live-badge live-badge-role">{ROLE_LABELS[member.role]}</span>
                    </td>
                    <td>
                      <span className={`live-badge live-badge-${member.status}`} data-status={member.status}>
                        {STATUS_LABELS[member.status]}
                      </span>
                    </td>
                    <td>{formatDay(member.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="live-pagination">
              <button
                type="button"
                className="live-button live-button-subtle"
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Previous
              </button>
              <button
                type="button"
                className="live-button live-button-subtle"
                disabled={page >= pages}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </button>
            </div>
          </>
        )
      ) : null}

      <form className="live-form" aria-labelledby="invite-title" onSubmit={handleInvite}>
        <h2 id="invite-title">Invite a teammate</h2>
        <label htmlFor="invite-email">Email</label>
        <input
          id="invite-email"
          name="invite-email"
          type="email"
          value={email}
          maxLength={320}
          placeholder="teammate@example.com"
          autoComplete="off"
          disabled={inviting}
          onChange={(event) => setEmail(event.target.value)}
        />
        <label htmlFor="invite-role">Role</label>
        <select
          id="invite-role"
          name="invite-role"
          value={inviteRole}
          disabled={inviting}
          onChange={(event) => setInviteRole(event.target.value as (typeof TENANT_ROLES)[number])}
        >
          {/* Granting the owner role is owner-only (invitation escalation is
              a named acceptance case) — admins never see the option. */}
          {role === 'owner' ? <option value="owner">Owner</option> : null}
          {TENANT_ROLES.filter((candidate) => candidate !== 'owner').map((candidate) => (
            <option key={candidate} value={candidate}>
              {ROLE_LABELS[candidate]}
            </option>
          ))}
        </select>
        {fieldError !== null ? (
          <p className="live-field-error" role="alert">
            {fieldError}
          </p>
        ) : null}
        {inviteFailure !== null && inviteFailure.kind === 'conflict' ? (
          <p className="live-field-error" role="alert">
            {inviteFailure.detail}
          </p>
        ) : null}
        {inviteFailure !== null && inviteFailure.kind === 'denied' ? (
          <DeniedState detail="You are not allowed to invite members to this organization." />
        ) : null}
        {inviteFailure !== null && inviteFailure.kind === 'error' ? (
          <PanelError detail={inviteFailure.detail} />
        ) : null}
        {inviteSuccess !== null ? (
          <p className="live-success" role="status">
            {inviteSuccess}
          </p>
        ) : null}
        <button type="submit" className="live-button" disabled={inviting}>
          {inviting ? 'Inviting…' : 'Send invitation'}
        </button>
      </form>
    </section>
  );
}
