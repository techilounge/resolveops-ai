// /app/incidents/new — the create form (Blueprint §4.4). Validated with the
// shared CreateIncidentRequestSchema before the POST (title required,
// description free-text, severity from the contract enum); a 201 navigates to
// the detail route. The server re-validates and may refine the failure —
// 403 renders the denied state, other errors the retryable panel.
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { CreateIncidentRequest } from '@resolveops/shared';
import { CreateIncidentRequestSchema } from '@resolveops/shared';
import { ApiError } from '../../api/client';
import { createIncident } from '../../api/endpoints';
import { DeniedState, PanelError } from '../../states/States';
import { INCIDENT_SEVERITIES, SEVERITY_LABELS } from './labels';

type CreateFailure =
  | { kind: 'denied' }
  | { kind: 'error'; detail: string };

export function NewIncidentPage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<CreateIncidentRequest['severity']>('medium');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<CreateFailure | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = CreateIncidentRequestSchema.safeParse({
      title: title.trim(),
      description,
      severity,
    });
    if (!parsed.success) {
      setFieldError('A title is required (1–200 characters).');
      return;
    }
    setFieldError(null);
    setSubmitting(true);
    setFailure(null);
    createIncident(parsed.data)
      .then((incident) => {
        navigate(`/app/incidents/${incident.id}`);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'FORBIDDEN') {
          setFailure({ kind: 'denied' });
          return;
        }
        setFailure({
          kind: 'error',
          detail: error instanceof Error ? error.message : 'The incident could not be created.',
        });
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <section className="live-panel" aria-labelledby="new-incident-title">
      <span className="live-kicker">INCIDENTS</span>
      <h1 id="new-incident-title">New incident</h1>
      <p className="live-lede">
        Log an incident for your organization. It starts in the New status and appears in the queue immediately.
      </p>

      <form className="live-form" onSubmit={handleSubmit}>
        <label htmlFor="incident-title">Title</label>
        <input
          id="incident-title"
          name="incident-title"
          type="text"
          value={title}
          maxLength={200}
          placeholder="e.g. BitLocker recovery prompt on kiosk-042"
          autoComplete="off"
          disabled={submitting}
          onChange={(event) => setTitle(event.target.value)}
        />

        <label htmlFor="incident-description">Description</label>
        <textarea
          id="incident-description"
          name="incident-description"
          rows={5}
          value={description}
          placeholder="What was observed, on which devices, and when…"
          disabled={submitting}
          onChange={(event) => setDescription(event.target.value)}
        />

        <label htmlFor="incident-severity">Severity</label>
        <select
          id="incident-severity"
          name="incident-severity"
          value={severity}
          disabled={submitting}
          onChange={(event) => setSeverity(event.target.value as CreateIncidentRequest['severity'])}
        >
          {INCIDENT_SEVERITIES.map((value) => (
            <option key={value} value={value}>
              {SEVERITY_LABELS[value]}
            </option>
          ))}
        </select>

        {fieldError !== null ? (
          <p className="live-field-error" role="alert">
            {fieldError}
          </p>
        ) : null}

        <div className="live-form-actions">
          <button type="submit" className="live-button" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create incident'}
          </button>
          <Link className="live-button live-button-subtle" to="/app/incidents">
            Cancel
          </Link>
        </div>
      </form>

      {failure !== null && failure.kind === 'denied' ? (
        <DeniedState detail="Incident creation is not available for your membership in this organization." />
      ) : null}
      {failure !== null && failure.kind === 'error' ? (
        <PanelError detail={failure.detail} onRetry={() => setFailure(null)} />
      ) : null}
      <p className="live-meta">
        Incidents are private to your organization. <Link to="/app/incidents">Back to the queue</Link>
      </p>
    </section>
  );
}
