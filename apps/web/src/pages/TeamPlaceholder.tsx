// /app/team — Phase 1 route slot for team administration. P1-6 fills this
// with the members list and invitations; until then the honest empty state
// renders (never demo fixtures).
import { EmptyState } from '../states/States';

export function TeamPlaceholder() {
  return (
    <section className="live-panel" aria-labelledby="team-title">
      <span className="live-kicker">TEAM</span>
      <h1 id="team-title">Team administration</h1>
      <EmptyState
        title="No teammates yet"
        detail="Member management and invitations arrive with the next phase. Your organization's role administration will live here."
      />
    </section>
  );
}
