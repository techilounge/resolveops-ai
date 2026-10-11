import type { Pool } from 'pg';
import { withTenantContext, writeAuditEvent } from '@resolveops/auth';
import { withSelfContext } from './self-context';

/**
 * The issuer provisioned for identities that exist only as invitations:
 * the invited email is known before the person ever signs in, so the member
 * row (and its pending user) is created up front — but no Entra/OIDC identity
 * is behind it yet (Phase 1 spec §4.3: "acceptance binds the invited email
 * to the Entra subject at first login"). Users are unique on (issuer,
 * subject); this sentinel issuer can never collide with a real identity
 * provider (real issuers are https:// URLs validated by the OIDC adapter).
 */
export const PENDING_INVITE_ISSUER = 'invite:pending';

export interface BindPendingInvitationsInput {
  /** The real, authenticated user row (from the server-side session only). */
  userId: string;
  /** The email asserted by the real identity at sign-in. */
  email: string;
}

/**
 * First-login invitation binding: find pending users provisioned for this
 * email, move each of their invited memberships to the real user, and audit
 * the acceptance. Runs on GET /me — after the session is authenticated and
 * before memberships are listed — so an invited user lands in their org on
 * their very first profile load. Idempotent: binding consumes the pending
 * row's memberships, so a second run finds nothing to move. Cross-user
 * hostile case (person B signs in with person A's invite email): B's real
 * identity has its own subject; the pending row matches only by email, and
 * binding grants whatever A was invited to — that is the invitation itself,
 * which is why invite emails must travel to the intended recipient (the same
 * trust the email round-trip in every invite product carries; audit rows
 * record the acceptance either way).
 */
export async function bindPendingInvitations(
  pool: Pool,
  input: BindPendingInvitationsInput,
): Promise<number> {
  const pendingUsers = await pool.query<{ id: string }>(
    `SELECT id
       FROM users
      WHERE entra_issuer = $1
        AND lower(entra_subject) = lower($2)`,
    [PENDING_INVITE_ISSUER, input.email],
  );

  let bound = 0;
  for (const pendingUser of pendingUsers.rows) {
    // The pending user's memberships are visible through the self-visibility
    // policy (migration 007) — the only RLS context a not-yet-real identity
    // can get. The actual reassignment runs inside the TARGET org's tenant
    // context, so every moved row satisfies the org-scoped isolation policy.
    const memberships = await withSelfContext(pool, pendingUser.id, (client) =>
      client.query<{ id: string; organization_id: string }>(
        `SELECT id, organization_id
           FROM memberships
          WHERE user_id = $1
            AND status = 'invited'`,
        [pendingUser.id],
      ),
    );

    for (const membership of memberships.rows) {
      bound += await withTenantContext(
        pool,
        { organizationId: membership.organization_id, userId: input.userId },
        async (client) => {
          const moved = await client.query(
            `UPDATE memberships
                SET user_id = $1,
                    updated_at = now()
              WHERE id = $2
                AND user_id = $3
                AND status = 'invited'`,
            [input.userId, membership.id, pendingUser.id],
          );
          if (moved.rowCount === 1) {
            await writeAuditEvent(client, {
              organizationId: membership.organization_id,
              actorUserId: input.userId,
              action: 'membership.invite_accepted',
              targetType: 'membership',
              targetId: membership.id,
              metadata: { fromPendingUserId: pendingUser.id },
            });
          }
          return moved.rowCount ?? 0;
        },
      );
    }
  }
  return bound;
}
