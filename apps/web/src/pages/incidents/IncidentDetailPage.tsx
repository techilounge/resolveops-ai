// /app/incidents/:id — incident detail (Blueprint §4.4): status transitions
// per the §6 enum, assignment via delta D1 (owner/admin picker; other roles
// see the current assignee read-only), and the delta-D4 comment surface —
// paginated list + create, EXACTLY as contracted in packages/shared
// comments.ts. PATCHes are version-aware: a 409 renders the conflict state
// and reloads the incident so the user works from the server's version.
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import type {
  IncidentCommentListResponse,
  IncidentResponse,
  Member,
  PatchIncidentRequest,
} from '@resolveops/shared';
import { IncidentIdParamsSchema } from '@resolveops/shared';
import { ApiError } from '../../api/client';
import {
  createIncidentComment,
  getIncident,
  listIncidentComments,
  listMembers,
  patchIncident,
} from '../../api/endpoints';
import { useCurrentRole } from '../../session/currentRole';
import { DeniedState, EmptyState, PanelError } from '../../states/States';
import { INCIDENT_STATUSES, SEVERITY_LABELS, STATUS_LABELS, formatDay, totalPages } from './labels';

const COMMENTS_PAGE_SIZE = 10;
const ROSTER_PAGE_SIZE = 100;

type DetailState =
  | { kind: 'loading' }
  | { kind: 'ready'; incident: IncidentResponse }
  | { kind: 'notfound'; detail: string }
  | { kind: 'denied' }
  | { kind: 'error'; detail: string };

type CommentsState =
  | { kind: 'loading' }
  | { kind: 'ready'; response: IncidentCommentListResponse }
  | { kind: 'error'; detail: string };

type MutationFailure = { kind: 'denied' } | { kind: 'error'; detail: string };

/** True when the identifier cannot be a valid incident id (never fetchable). */
function isMalformedId(id: string | undefined): boolean {
  return !IncidentIdParamsSchema.safeParse({ id: id ?? '' }).success;
}

/** Whether this roster row is the incident's current assignee. */
function isCurrentAssignee(member: Member, incident: IncidentResponse): boolean {
  return member.userId === incident.assigneeUserId;
}

export function IncidentDetailPage() {
  const { id } = useParams();
  const incidentId = id ?? '';
  const role = useCurrentRole();
  const privileged = role === 'owner' || role === 'admin';

  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  const [conflict, setConflict] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [mutationFailure, setMutationFailure] = useState<MutationFailure | null>(null);

  const [comments, setComments] = useState<CommentsState>({ kind: 'loading' });
  const [commentsPage, setCommentsPage] = useState(1);
  // Bumped alongside the page when a create must refetch the SAME page
  // (posting a comment can land on the page already shown).
  const [commentsRefresh, setCommentsRefresh] = useState(0);

  const [roster, setRoster] = useState<Member[] | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);

  const requestSeq = useRef(0);

  const validId = !isMalformedId(incidentId);

  const loadIncident = useCallback(() => {
    const seq = ++requestSeq.current;
    setState({ kind: 'loading' });
    getIncident(incidentId)
      .then((incident) => {
        if (requestSeq.current !== seq) return;
        setState({ kind: 'ready', incident });
      })
      .catch((error: unknown) => {
        if (requestSeq.current !== seq) return;
        if (error instanceof ApiError && error.code === 'NOT_FOUND') {
          setState({ kind: 'notfound', detail: error.message });
          return;
        }
        if (error instanceof ApiError && error.code === 'FORBIDDEN') {
          setState({ kind: 'denied' });
          return;
        }
        setState({
          kind: 'error',
          detail: error instanceof Error ? error.message : 'The incident could not be loaded.',
        });
      });
  }, [incidentId]);

  useEffect(() => {
    if (!validId) {
      setState({ kind: 'notfound', detail: 'The address does not name a valid incident.' });
      return;
    }
    loadIncident();
  }, [validId, loadIncident]);

  // Roster for the privileged assignee picker; one read per privileged visit.
  useEffect(() => {
    if (!privileged || !validId || roster !== null) {
      return;
    }
    let cancelled = false;
    setRosterError(null);
    listMembers({ page: 1, pageSize: ROSTER_PAGE_SIZE })
      .then((response) => {
        if (!cancelled) setRoster(response.data);
      })
      .catch(() => {
        // Assignment degrades to unavailable (with a stated reason and a
        // retry); the incident view itself stays up.
        if (!cancelled) {
          setRoster([]);
          setRosterError('The member roster could not be loaded, so assignment is unavailable right now.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [privileged, validId, roster]);

  const loadComments = useCallback(
    (page: number) => {
      setComments({ kind: 'loading' });
      listIncidentComments(incidentId, { page, pageSize: COMMENTS_PAGE_SIZE })
        .then((response) => setComments({ kind: 'ready', response }))
        .catch((error: unknown) => {
          setComments({
            kind: 'error',
            detail: error instanceof Error ? error.message : 'Comments could not be loaded.',
          });
        });
    },
    [incidentId],
  );

  useEffect(() => {
    if (!validId) {
      return;
    }
    loadComments(commentsPage);
  }, [validId, commentsPage, commentsRefresh, loadComments]);

  const runPatch = (patch: Omit<PatchIncidentRequest, 'expectedVersion'>, incident: IncidentResponse) => {
    setMutating(true);
    setMutationFailure(null);
    patchIncident(incidentId, { ...patch, expectedVersion: incident.version })
      .then((updated) => {
        setConflict(false);
        setState({ kind: 'ready', incident: updated });
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'CONFLICT') {
          // Someone updated the incident first: surface the conflict state,
          // then reload so the user works from the server's version.
          setConflict(true);
          loadIncident();
          return;
        }
        if (error instanceof ApiError && error.code === 'FORBIDDEN') {
          setMutationFailure({ kind: 'denied' });
          return;
        }
        setMutationFailure({
          kind: 'error',
          detail: error instanceof Error ? error.message : 'The change could not be saved.',
        });
      })
      .finally(() => setMutating(false));
  };

  const submitComment = (event: FormEvent<HTMLFormElement>, total: number) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = String(new FormData(form).get('body') ?? '').trim();
    if (body === '') {
      setComments({ kind: 'error', detail: 'Write a comment before posting.' });
      return;
    }
    setMutating(true);
    createIncidentComment(incidentId, { body })
      .then(() => {
        // Newest comments append at the end (ASC ordering) — jump to the
        // last page so the just-posted comment is visible, and force a
        // refetch even when that is the page already shown.
        setCommentsPage(totalPages(total + 1, COMMENTS_PAGE_SIZE));
        setCommentsRefresh((tick) => tick + 1);
      })
      .catch((error: unknown) => {
        setComments({
          kind: 'error',
          detail: error instanceof Error ? error.message : 'The comment could not be posted.',
        });
      })
      .finally(() => setMutating(false));
  };

  if (state.kind === 'loading') {
    return (
      <section className="live-panel" aria-labelledby="incident-detail-title">
        <span className="live-kicker">INCIDENTS</span>
        <h1 id="incident-detail-title">Loading incident…</h1>
        <p className="live-loading" role="status">
          <span className="state-spinner" aria-hidden="true" /> Fetching the incident for your organization…
        </p>
      </section>
    );
  }
  if (state.kind === 'notfound') {
    return (
      <section className="live-panel" aria-labelledby="incident-detail-title">
        <span className="live-kicker">INCIDENTS</span>
        <h1 id="incident-detail-title">Incident not found</h1>
        <EmptyState
          title="Nothing here"
          detail="This incident does not exist in your organization — or the link is malformed. Nothing about other organizations is revealed either way."
        >
          <Link className="live-button" to="/app/incidents">
            Back to incidents
          </Link>
        </EmptyState>
        <p className="live-meta">{state.detail}</p>
      </section>
    );
  }
  if (state.kind === 'denied') {
    return (
      <section className="live-panel" aria-labelledby="incident-detail-title">
        <span className="live-kicker">INCIDENTS</span>
        <h1 id="incident-detail-title">Incident</h1>
        <DeniedState detail="This incident is not available for your membership in this organization." />
        <p className="live-meta">
          <Link to="/app/incidents">Back to incidents</Link>
        </p>
      </section>
    );
  }
  if (state.kind === 'error') {
    return (
      <section className="live-panel" aria-labelledby="incident-detail-title">
        <span className="live-kicker">INCIDENTS</span>
        <h1 id="incident-detail-title">Incident</h1>
        <PanelError detail={state.detail} onRetry={loadIncident} />
      </section>
    );
  }

  const incident = state.incident;

  return (
    <section className="live-panel" aria-labelledby="incident-detail-title">
      <p className="live-meta">
        <Link to="/app/incidents">← All incidents</Link>
      </p>
      <span className="live-kicker">INCIDENTS</span>
      <h1 id="incident-detail-title">{incident.title}</h1>
      <div className="live-badges">
        <span className="live-badge live-badge-status" data-status={incident.status}>
          {STATUS_LABELS[incident.status]}
        </span>
        <span className={`live-badge live-badge-${incident.severity}`}>{SEVERITY_LABELS[incident.severity]}</span>
      </div>
      <p className="live-meta">
        Created {formatDay(incident.createdAt)} · Updated {formatDay(incident.updatedAt)} · Version {incident.version}
      </p>
      {incident.description !== '' ? <p className="live-description">{incident.description}</p> : null}

      {conflict ? (
        <div className="live-conflict" role="alert">
          <strong>This incident changed while you were working.</strong>
          <p>
            Someone else saved an update first, so your change was not applied. The view below now shows the
            latest version — re-apply your change if it is still needed.
          </p>
          <button type="button" className="live-button live-button-subtle" onClick={() => setConflict(false)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {mutationFailure !== null && mutationFailure.kind === 'denied' ? (
        <DeniedState
          detail="You are not allowed to modify this incident."
          onDismiss={() => setMutationFailure(null)}
        />
      ) : null}
      {mutationFailure !== null && mutationFailure.kind === 'error' ? (
        <PanelError detail={mutationFailure.detail} onRetry={() => setMutationFailure(null)} />
      ) : null}

      <IncidentDetailReady
        key={`${incident.id}:${incident.version}`}
        incident={incident}
        privileged={privileged}
        roster={roster}
        rosterError={rosterError}
        onReloadRoster={() => setRoster(null)}
        mutating={mutating}
        onStatusChange={(status) => runPatch({ status }, incident)}
        onAssign={(assigneeUserId) => runPatch({ assigneeUserId }, incident)}
      />

      <IncidentComments
        state={comments}
        page={commentsPage}
        onPageChange={setCommentsPage}
        mutating={mutating}
        onSubmitComment={(event, total) => submitComment(event, total)}
      />
    </section>
  );
}

/**
 * The transition + assignment controls. Keyed by incident version upstream so
 * a server-side update (success or conflict reload) resets any in-flight
 * drafts to the fresh server values.
 */
function IncidentDetailReady(props: {
  incident: IncidentResponse;
  privileged: boolean;
  roster: Member[] | null;
  rosterError: string | null;
  onReloadRoster: () => void;
  mutating: boolean;
  onStatusChange: (status: IncidentResponse['status']) => void;
  onAssign: (assigneeUserId: string | null) => void;
}) {
  const { incident, privileged, roster, rosterError, onReloadRoster, mutating, onStatusChange, onAssign } = props;
  const [statusDraft, setStatusDraft] = useState<IncidentResponse['status']>(incident.status);
  const [assignDraft, setAssignDraft] = useState<string>(incident.assigneeUserId ?? '');

  const activeMembers = (roster ?? []).filter((member) => member.status === 'active');
  const currentAssigneeMissing =
    incident.assigneeUserId !== null && !activeMembers.some((member) => isCurrentAssignee(member, incident));

  const handleStatus = (event: ChangeEvent<HTMLSelectElement>) => {
    setStatusDraft(event.target.value as IncidentResponse['status']);
  };
  const handleAssign = (event: ChangeEvent<HTMLSelectElement>) => {
    setAssignDraft(event.target.value);
  };

  return (
    <>
      <form
        className="live-subcard"
        aria-labelledby="status-transition-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (statusDraft !== incident.status) onStatusChange(statusDraft);
        }}
      >
        <h2 id="status-transition-title">Status</h2>
        <label htmlFor="incident-status">Change status</label>
        <select id="incident-status" value={statusDraft} disabled={mutating} onChange={handleStatus}>
          {INCIDENT_STATUSES.map((value) => (
            <option key={value} value={value}>
              {STATUS_LABELS[value]}
            </option>
          ))}
        </select>
        <button type="submit" className="live-button" disabled={mutating || statusDraft === incident.status}>
          {mutating ? 'Saving…' : 'Update status'}
        </button>
      </form>

      {privileged ? (
        <form
          className="live-subcard"
          aria-labelledby="assignment-title"
          onSubmit={(event) => {
            event.preventDefault();
            const next = assignDraft === '' ? null : assignDraft;
            if (next !== incident.assigneeUserId) onAssign(next);
          }}
        >
          <h2 id="assignment-title">Assignment</h2>
          {roster === null && rosterError === null ? (
            <p className="live-meta" role="status">
              Loading members…
            </p>
          ) : null}
          {rosterError !== null ? <PanelError detail={rosterError} onRetry={onReloadRoster} /> : null}
          {roster !== null ? (
            <>
              <label htmlFor="incident-assignee">Assignee</label>
              <select id="incident-assignee" value={assignDraft} disabled={mutating} onChange={handleAssign}>
                <option value="">Unassigned</option>
                {currentAssigneeMissing ? (
                  <option value={incident.assigneeUserId ?? ''}>
                    {incident.assigneeUserId?.slice(0, 8)}… (current)
                  </option>
                ) : null}
                {activeMembers.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.displayName}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="live-button"
                disabled={mutating || (assignDraft === '' ? null : assignDraft) === incident.assigneeUserId}
              >
                {mutating ? 'Saving…' : incident.assigneeUserId === null ? 'Assign' : 'Update assignment'}
              </button>
            </>
          ) : null}
        </form>
      ) : (
        <div className="live-subcard" aria-labelledby="assignment-title">
          <h2 id="assignment-title">Assignment</h2>
          <p className="live-readout">
            {incident.assigneeUserId === null
              ? 'Unassigned'
              : `Assigned to ${incident.assigneeUserId.slice(0, 8)}…`}
          </p>
          <p className="live-meta">
            Assignment changes are limited to owners and admins. If you need a reassignment, ask someone with
            that role.
          </p>
        </div>
      )}
    </>
  );
}

/** The delta-D4 discussion surface: paginated list + create form. */
function IncidentComments(props: {
  state: CommentsState;
  page: number;
  onPageChange: (page: number) => void;
  mutating: boolean;
  onSubmitComment: (event: FormEvent<HTMLFormElement>, total: number) => void;
}) {
  const { state, page, onPageChange, mutating, onSubmitComment } = props;

  return (
    <div className="live-subcard" aria-labelledby="comments-title">
      <h2 id="comments-title">Comments</h2>
      {state.kind === 'loading' ? (
        <p className="live-meta" role="status">
          Loading comments…
        </p>
      ) : null}
      {state.kind === 'error' ? <PanelError detail={state.detail} /> : null}
      {state.kind === 'ready' ? (
        <>
          {state.response.data.length === 0 ? (
            <EmptyState
              title="No comments yet"
              detail="Add the first note below — observations, triage steps, or links to evidence. Comments are visible to everyone in your organization."
            />
          ) : (
            <>
              <p className="live-count" role="status">
                Page {state.response.page.page} of{' '}
                {totalPages(state.response.page.total, state.response.page.pageSize)} · {state.response.page.total}{' '}
                {state.response.page.total === 1 ? 'comment' : 'comments'}
              </p>
              <ul className="live-comments">
                {state.response.data.map((comment) => (
                  <li key={comment.id} className="live-comment">
                    <header>
                      <strong>{comment.authorDisplayName}</strong>
                      <span>{formatDay(comment.createdAt)}</span>
                    </header>
                    <p>{comment.body}</p>
                  </li>
                ))}
              </ul>
              <div className="live-pagination">
                <button
                  type="button"
                  className="live-button live-button-subtle"
                  disabled={page <= 1}
                  onClick={() => onPageChange(page - 1)}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="live-button live-button-subtle"
                  disabled={page >= totalPages(state.response.page.total, state.response.page.pageSize)}
                  onClick={() => onPageChange(page + 1)}
                >
                  Next
                </button>
              </div>
            </>
          )}
          <form className="live-form" onSubmit={(event) => onSubmitComment(event, state.response.page.total)}>
            <label htmlFor="comment-body">Add a comment</label>
            <textarea id="comment-body" name="body" rows={3} maxLength={10000} disabled={mutating} />
            <button type="submit" className="live-button" disabled={mutating}>
              {mutating ? 'Posting…' : 'Post comment'}
            </button>
          </form>
        </>
      ) : null}
    </div>
  );
}
