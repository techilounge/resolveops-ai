// The route table (P1-5). Composition roots pass `demoSlot` — the demo is
// rendered through a dynamically-imported chunk injected from main.tsx so
// this module (and everything it imports) has no import path to the demo's
// fixture data; the invariant is asserted by import-graph.test.ts.
import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { CallbackRoute } from './auth/CallbackRoute';
import { LoginRoute } from './auth/LoginRoute';
import { LogoutRoute } from './auth/LogoutRoute';
import { RequireAuth } from './guard/RequireAuth';
import { NotYetAvailable } from './pages/NotYetAvailable';
import { IncidentsPlaceholder } from './pages/IncidentsPlaceholder';
import { TeamPlaceholder } from './pages/TeamPlaceholder';
import { OnboardingPage } from './onboarding/OnboardingPage';
import { AppShell } from './shell/AppShell';
import { FullPageLoading } from './states/States';

export interface AppRoutesProps {
  /** The /demo element (lazy-loaded demo chunk) — supplied by the entry. */
  demoSlot?: ReactNode;
}

export function AppRoutes({ demoSlot = null }: AppRoutesProps) {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/app" replace />} />

      {/* Fixture-backed Phase 0 demo — its own chunk, its own data path. */}
      <Route path="/demo" element={demoSlot ?? <FullPageLoading label="Loading the demo…" />} />

      {/* Auth routes (Blueprint §4.4). */}
      <Route path="/auth/login" element={<LoginRoute />} />
      <Route path="/auth/callback" element={<CallbackRoute />} />
      <Route path="/auth/logout" element={<LogoutRoute />} />

      {/* Post-login setup, session-guarded. */}
      <Route
        path="/onboarding"
        element={
          <RequireAuth>
            <OnboardingPage />
          </RequireAuth>
        }
      />

      {/* Authenticated shell (Blueprint §4.4): Phase 1 subset + placeholders. */}
      <Route
        path="/app"
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/app/incidents" replace />} />
        <Route path="incidents" element={<IncidentsPlaceholder />} />
        <Route path="team" element={<TeamPlaceholder />} />
        {/* Later-phase IA targets and unknown deep links — no silent 404s. */}
        <Route path="*" element={<NotYetAvailable />} />
      </Route>

      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  );
}
