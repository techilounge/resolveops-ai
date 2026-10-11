// Catch-all inside /app: §4 IA targets that are not in the Phase 1 subset and
// any unknown deep link render this instead of a silent 404 (spec §4.4).
import { Link, useLocation } from 'react-router';

function sectionTitle(pathname: string): string {
  const segment = pathname.split('/').filter(Boolean).pop() ?? 'page';
  const title = segment.replace(/[-_]/g, ' ');
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export function NotYetAvailable() {
  const location = useLocation();
  const title = sectionTitle(location.pathname);

  return (
    <section className="live-panel" aria-labelledby="unavailable-title">
      <span className="live-kicker">ROADMAP</span>
      <h1 id="unavailable-title">{title} is not yet available</h1>
      <p role="status">
        This area arrives in a later phase of the rollout. Head back to{' '}
        <Link to="/app/incidents">Incidents</Link> in the meantime.
      </p>
    </section>
  );
}
