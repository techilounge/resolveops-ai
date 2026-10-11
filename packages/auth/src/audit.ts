import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export interface AuditEventInput {
  /** Org scope of the event; null for global events (login, logout). */
  organizationId: string | null;
  /** Acting user; null for system actions. */
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Appends an audit row. `audit_events` is append-only by GRANT (migration
 * 004: the app role has INSERT and SELECT only — UPDATE/DELETE are granted
 * to nobody), and RLS scopes org events to `app.org_id`: org-scoped events
 * must be written inside `withTenantContext` for that org (the tenant guard
 * does this for denials), while global events (login/logout) write with
 * organization_id NULL, which the WITH CHECK clause allows without context.
 *
 * Accepts a Pool (own transaction) or an in-transaction PoolClient.
 */
export async function writeAuditEvent(
  target: Pool | PoolClient,
  event: AuditEventInput,
): Promise<void> {
  const query = {
    text: `INSERT INTO audit_events
             (id, organization_id, actor_user_id, action, target_type, target_id, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    values: [
      randomUUID(),
      event.organizationId,
      event.actorUserId,
      event.action,
      event.targetType,
      event.targetId,
      JSON.stringify(event.metadata ?? {}),
    ],
  };
  await target.query(query);
}
