// /app/incidents — the scoped incident queue (Blueprint §4.4). Every byte of
// data comes from the tenant-scoped API via the typed client; filters, search,
// and pagination are all server-side query parameters (spec §4.3), so the UI
// never filters a cached superset. States: loading, ready, error (retryable),
// denied (403), empty (unfiltered) and no-matches (filtered).
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { IncidentListResponse, IncidentSeverity, IncidentStatus, Member } from '@resolveops/shared';
import { ApiError } from '../../api/client';
import { listIncidents, listMembers } from '../../api/endpoints';
import { useCurrentRole } from '../../session/currentRole';
import { DeniedState, EmptyState, FullPageLoading, PanelError } from '../../states/States';
import {
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  SEVERITY_LABELS,
  STATUS_LABELS,
  formatDay,
  totalPages,
} from './labels';

const PAGE_SIZE = 25;
/** Roster page for the privileged assignee filter — one call, capped by the API. */
const ROSTER_PAGE_SIZE = 100;

interface IncidentFilters {
  status?: IncidentStatus;
  severity?: IncidentSeverity;
  /** A member UUID, or the literal 'unassigned' (shared contract). */
  assignee?: string;
  q?: string;
  page: number;
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; total: number }
  | { kind: 'error'; detail: string }
  | { kind: 'denied' };

function hasActiveFilters(filters: IncidentFilters): boolean {
  return (
    filters.status !== undefined ||
    filters.severity !== undefined ||
    filters.assignee !== undefined ||
    (filters.q !== undefined && filters.q.length > 0)
  );
}

export function IncidentsListPage() {
  const [filters, setFilters] = useState<IncidentFilters>({ page: 1 });
  const [qDraft, setQDraft] = useState('');
  const [rows, setRows] = useState<IncidentListResponse['data']>([]);
  const [pageInfo, setPageInfo] = useState<IncidentListResponse['page'] | null>(null);
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  // Roster for the privileged assignee filter (owner/admin); null = not loaded.
  const [roster, setRoster] = useState<Member[] | null>(null);
  const role = useCurrentRole();
  const privileged = role === 'owner' || role === 'admin';
  // Race guard: only the latest issued request may commit state.
  const requestSeq = useRef(0);

  const load = useCallback((current: IncidentFilters) => {
    const seq = ++requestSeq.current;
    setState({ kind: 'loading' });
    listIncidents({
      page: current.page,
      pageSize: PAGE_SIZE,
      status: current.status,
      severity: current.severity,
      assignee: current.assignee,
      q: current.q,
    })
      .then((response) => {
        if (requestSeq.current !== seq) return;
        setRows(response.data);
        setPageInfo(response.page);
        setState({ kind: 'ready', total: response.page.total });
      })
      .catch((error: unknown) => {
        if (requestSeq.current !== seq) return;
        if (error instanceof ApiError && error.code === 'FORBIDDEN') {
          setState({ kind: 'denied' });
          return;
        }
        setState({
          kind: 'error',
          detail: error instanceof Error ? error.message : 'Incidents could not be loaded.',
        });
      });
  }, []);

  useEffect(() => {
    load(filters);
  }, [filters, load]);

  // One roster read per privileged session for the assignee filter labels.
  useEffect(() => {
    if (!privileged || roster !== null) {
      return;
    }
    let cancelled = false;
    listMembers({ page: 1, pageSize: ROSTER_PAGE_SIZE })
      .then((response) => {
        if (!cancelled) setRoster(response.data);
      })
      .catch(() => {
        // The queue itself is unaffected; the filter degrades to
        // all/unassigned and the UI says so — a failed roster must not
        // take the incident list down with it.
        if (!cancelled) setRoster([]);
      });
    return () => {
      cancelled = true;
    };
  }, [privileged, roster]);

  const applyFilter = (patch: Partial<IncidentFilters>) => {
    setFilters((current) => ({ ...current, page: 1, ...patch }));
  };

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const q = qDraft.trim();
    applyFilter({ q: q === '' ? undefined : q });
  };

  const handleStatus = (event: ChangeEvent<HTMLSelectElement>) => {
    applyFilter({ status: (event.target.value || undefined) as IncidentStatus | undefined });
  };
  const handleSeverity = (event: ChangeEvent<HTMLSelectElement>) => {
    applyFilter({ severity: (event.target.value || undefined) as IncidentSeverity | undefined });
  };
  const handleAssignee = (event: ChangeEvent<HTMLSelectElement>) => {
    applyFilter({ assignee: event.target.value || undefined });
  };

  const clearFilters = () => {
    setQDraft('');
    setFilters({ page: 1 });
  };

  const changePage = (page: number) => {
    setFilters((current) => ({ ...current, page }));
  };

  const pages = pageInfo === null ? 1 : totalPages(pageInfo.total, pageInfo.pageSize);
  const filtered = hasActiveFilters(filters);

  return (
    <section className="live-panel" aria-labelledby="incidents-title">
      <div className="live-panel-actions">
        <div>
          <span className="live-kicker">INCIDENTS</span>
          <h1 id="incidents-title">Incidents</h1>
          <p className="live-lede">Your organization's incident queue — scoped and isolated per organization.</p>
        </div>
        <Link className="live-button" to="/app/incidents/new">
          New incident
        </Link>
      </div>

      <form className="live-toolbar" role="search" aria-label="Incident filters" onSubmit={handleSearch}>
        <label>
          Status
          <select aria-label="Filter by status" value={filters.status ?? ''} onChange={handleStatus}>
            <option value="">All statuses</option>
            {INCIDENT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Severity
          <select aria-label="Filter by severity" value={filters.severity ?? ''} onChange={handleSeverity}>
            <option value="">All severities</option>
            {INCIDENT_SEVERITIES.map((value) => (
              <option key={value} value={value}>
                {SEVERITY_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Assignee
          <select aria-label="Filter by assignee" value={filters.assignee ?? ''} onChange={handleAssignee}>
            <option value="">All assignees</option>
            <option value="unassigned">Unassigned</option>
            {privileged && roster !== null
              ? roster
                  .filter((member) => member.status === 'active')
                  .map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.displayName}
                    </option>
                  ))
              : null}
          </select>
        </label>
        <label>
          Search
          <input
            type="search"
            aria-label="Search incidents"
            placeholder="Search title or description…"
            value={qDraft}
            maxLength={200}
            onChange={(event) => setQDraft(event.target.value)}
          />
        </label>
        <button type="submit" className="live-button">
          Search
        </button>
        {filtered ? (
          <button type="button" className="live-button live-button-subtle" onClick={clearFilters}>
            Clear filters
          </button>
        ) : null}
      </form>
      {privileged && roster !== null && roster.length === 0 ? (
        <p className="live-meta">The member roster is unavailable right now, so named-assignee filtering is limited to "unassigned".</p>
      ) : null}

      {state.kind === 'loading' ? <FullPageLoading label="Loading incidents…" /> : null}
      {state.kind === 'denied' ? (
        <DeniedState detail="Incident listing is not available for your membership in this organization." />
      ) : null}
      {state.kind === 'error' ? <PanelError detail={state.detail} onRetry={() => load(filters)} /> : null}
      {state.kind === 'ready' && rows.length === 0 ? (
        filtered ? (
          <EmptyState
            title="No incidents match"
            detail="No incidents in your organization match the current filters or search. Adjust them, or clear to see the full queue."
          >
            <button type="button" className="live-button live-button-subtle" onClick={clearFilters}>
              Clear filters
            </button>
          </EmptyState>
        ) : (
          <EmptyState
            title="No incidents yet"
            detail="When your organization logs its first incident, the queue will appear here — scoped to your organization and isolated from every other."
          >
            <Link className="live-button" to="/app/incidents/new">
              Create the first incident
            </Link>
          </EmptyState>
        )
      ) : null}
      {state.kind === 'ready' && rows.length > 0 ? (
        <>
          <p className="live-count" role="status">
            {pageInfo === null ? null : (
              <>
                Page {pageInfo.page} of {pages} · {pageInfo.total} {pageInfo.total === 1 ? 'incident' : 'incidents'}
              </>
            )}
          </p>
          <table className="live-table">
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Status</th>
                <th scope="col">Severity</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((incident) => (
                <tr key={incident.id}>
                  <td>
                    <Link to={`/app/incidents/${incident.id}`}>{incident.title}</Link>
                  </td>
                  <td>
                    <span className="live-badge live-badge-status" data-status={incident.status}>
                      {STATUS_LABELS[incident.status]}
                    </span>
                  </td>
                  <td>
                    <span className={`live-badge live-badge-${incident.severity}`}>{SEVERITY_LABELS[incident.severity]}</span>
                  </td>
                  <td>{formatDay(incident.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="live-pagination">
            <button
              type="button"
              className="live-button live-button-subtle"
              disabled={filters.page <= 1}
              onClick={() => changePage(filters.page - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              className="live-button live-button-subtle"
              disabled={filters.page >= pages}
              onClick={() => changePage(filters.page + 1)}
            >
              Next
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
