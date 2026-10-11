// Reusable async-state components for live screens: loading, error (with
// retry), access-denied (403), and empty. Every async surface renders one of
// these instead of an unstyled blank — AGENTS.md requires useful status text
// and semantic status roles.
import type { ReactNode } from 'react';

export function FullPageLoading({ label }: { label: string }) {
  return (
    <div className="state-fullscreen" role="status">
      <span className="state-spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export function FullPageError({ title, detail, onRetry }: { title: string; detail: string; onRetry: () => void }) {
  return (
    <div className="state-fullscreen" role="alert">
      <div className="state-card state-error">
        <h1>{title}</h1>
        <p>{detail}</p>
        <button type="button" className="live-button" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}

/** In-panel error with an optional retry action. */
export function PanelError({ detail, onRetry }: { detail: string; onRetry?: () => void }) {
  return (
    <div className="state-card state-error" role="alert">
      <h2>Something went wrong</h2>
      <p>{detail}</p>
      {onRetry ? (
        <button type="button" className="live-button" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/**
 * The 403 surface: authorization was checked and refused. Rendered wherever
 * a call comes back FORBIDDEN — it states the refusal without leaking any
 * signal about the resource that was denied.
 */
export function DeniedState({ detail, onDismiss }: { detail?: string; onDismiss?: () => void }) {
  return (
    <div className="state-card state-denied" role="alert">
      <h2>Access denied</h2>
      <p>
        Your account does not have permission to do that in this organization.
        {detail ? ` ${detail}` : ''}
      </p>
      {onDismiss ? (
        <button type="button" className="live-button live-button-subtle" onClick={onDismiss}>
          Dismiss
        </button>
      ) : null}
    </div>
  );
}

/** In-panel empty state for real routes whose data is legitimately empty. */
export function EmptyState({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) {
  return (
    <div className="state-card state-empty" role="status">
      <h2>{title}</h2>
      <p>{detail}</p>
      {children}
    </div>
  );
}
