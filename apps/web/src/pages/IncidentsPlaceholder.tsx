// /app/incidents — Phase 1 route slot for the incident workspace. P1-6 fills
// this with the real scoped list/detail screens; until then the honest empty
// state renders (never demo fixtures).
import { EmptyState } from '../states/States';

export function IncidentsPlaceholder() {
  return (
    <section className="live-panel" aria-labelledby="incidents-title">
      <span className="live-kicker">INCIDENTS</span>
      <h1 id="incidents-title">Incident workspace</h1>
      <EmptyState
        title="No incidents yet"
        detail="When your organization logs its first incident, the queue will appear here — scoped to your organization and isolated from every other."
      />
    </section>
  );
}
