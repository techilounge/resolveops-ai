// Shared presentation helpers for the incident screens: human labels for the
// Blueprint §6 enums and pagination arithmetic. Pure functions — the screens
// stay free of inline mapping tables.
import type { IncidentSeverity, IncidentStatus } from '@resolveops/shared';

export const INCIDENT_STATUSES: readonly IncidentStatus[] = [
  'new',
  'triaged',
  'investigating',
  'awaiting_review',
  'resolved',
  'closed',
] as const;

export const INCIDENT_SEVERITIES: readonly IncidentSeverity[] = ['high', 'medium', 'low'] as const;

export const STATUS_LABELS: Record<IncidentStatus, string> = {
  new: 'New',
  triaged: 'Triaged',
  investigating: 'Investigating',
  awaiting_review: 'Awaiting review',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const SEVERITY_LABELS: Record<IncidentSeverity, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** Page count for the paginated envelope; never below one page. */
export function totalPages(pageTotal: number, pageSize: number): number {
  return Math.max(1, Math.ceil(pageTotal / pageSize));
}

/** Deterministic day rendering for audit columns (ISO date slice). */
export function formatDay(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}
