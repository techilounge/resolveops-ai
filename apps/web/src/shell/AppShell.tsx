// The authenticated application shell (Blueprint §4.4): a header with the
// organization selector and account controls, and the Phase 1 nav subset —
// Incidents and Team are real Phase 1 routes; Devices, Audit, and Settings
// are §4 IA targets rendered as not-yet-available placeholders so no nav
// entry silently 404s. Live screens read only from the API via the session
// provider — the fixture-backed demo lives exclusively under /demo.
import { Workflow } from 'lucide-react';
import { Link, NavLink, Outlet } from 'react-router';
import { OrgSelector } from './OrgSelector';
import { useSession } from '../session/SessionProvider';

const NAV_PHASE_1 = [
  { to: '/app/incidents', label: 'Incidents' },
  { to: '/app/team', label: 'Team' },
] as const;

// §4 IA targets outside this phase's scope — placeholders prevent silent 404s.
const NAV_LATER_PHASES = [
  { to: '/app/devices', label: 'Devices' },
  { to: '/app/audit', label: 'Audit' },
  { to: '/app/settings', label: 'Settings' },
] as const;

export function AppShell() {
  const { me } = useSession();

  return (
    <div className="live-root">
      <header className="live-header">
        <div className="live-brand">
          <span className="live-brand-icon" aria-hidden="true">
            <Workflow size={18} />
          </span>
          <strong>
            ResolveOps<span> AI</span>
          </strong>
        </div>
        <OrgSelector />
        <div className="live-account">
          {me !== null ? <span className="live-user-email">{me.user.email}</span> : null}
          <Link className="live-button live-button-subtle" to="/auth/logout">
            Sign out
          </Link>
        </div>
      </header>
      <nav className="live-nav" aria-label="Application navigation">
        {NAV_PHASE_1.map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? 'active' : '')}>
            {item.label}
          </NavLink>
        ))}
        {NAV_LATER_PHASES.map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? 'active' : '')}>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <main className="live-main">
        <Outlet />
      </main>
    </div>
  );
}
