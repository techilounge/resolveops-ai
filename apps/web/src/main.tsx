// Entry point (P1-5): mounts the routed application. The Phase 0 demo is
// code-split behind a dynamic import and mounted at /demo; every other route
// is the live, API-backed app. The split is what keeps the demo's fixture
// data out of the live bundle's import graph.
import { lazy, Suspense, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { AppRoutes } from './routes';
import { SessionProvider } from './session/SessionProvider';
import { FullPageLoading } from './states/States';
import './live.css';

const DemoApp = lazy(() => import('./demo'));

const appElement = document.getElementById('root');
if (!appElement) {
  throw new Error('ResolveOps root element (#root) was not found.');
}

createRoot(appElement).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <AppRoutes
          demoSlot={
            <Suspense fallback={<FullPageLoading label="Loading the demo…" />}>
              <DemoApp />
            </Suspense>
          }
        />
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
