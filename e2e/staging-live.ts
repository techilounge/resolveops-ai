/**
 * Staging live E2E (Phase 1 Blueprint section 4.6 / section 7) — the Part B
 * close-the-task harness. Drives a RUNNING staging API (real Entra sign-in
 * done by a human in a browser; everything after is scripted and asserted):
 *
 *   1. Sign in twice in a browser against the staging origin (two test-tenant
 *      accounts). Copy the `resolveops.sid` cookie from each session.
 *   2. Run:  npx tsx e2e/staging-live.ts --base-url=$STAGING_BASE_URL \
 *             --cookie=<user A session cookie> --cookie-b=<user B session cookie>
 *   3. The harness onboards two independent orgs, runs the incident
 *      create/edit/comment/search flow, then re-runs the P1-7 cross-tenant
 *      matrix (enumerate/view/edit/comment/search/infer/switch/guessed-id)
 *      and the revocation check. Every expectation is asserted; exit code is
 *      non-zero on any violation.
 *
 * Secrets: this file contains NO credentials. Values arrive through the
 * operator's browser session and environment references only.
 *
 * The section-7 "matrix re-run against the managed Postgres" also has a
 * fully-automated tier: point the existing suites at the managed database —
 *   DATABASE_URL=<direct managed url> npx vitest run packages/database apps/api
 * (see docs/STAGING-RUNBOOK.md). This harness is the live, operator-in-the-
 * loop tier over the real issuer.
 */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { SESSION_COOKIE_NAME } from '@resolveops/auth';

interface HarnessOptions {
  baseUrl: string;
  cookieA: string;
  cookieB: string;
}

interface StepResult {
  name: string;
  passed: boolean;
  detail?: string;
}

/** Minimal cookie-aware API client: one browser session per identity. */
class ApiClient {
  private csrfToken: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private cookieValue: string,
    private readonly log: (line: string) => void,
  ) {}

  private headers(mutating: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      cookie: `${SESSION_COOKIE_NAME}=${this.cookieValue}`,
      'content-type': 'application/json',
    };
    if (mutating) {
      if (this.csrfToken === null) {
        throw new Error('csrf token not fetched — call fetchCsrf() before the first mutating call');
      }
      headers['x-csrf-token'] = this.csrfToken;
    }
    return headers;
  }

  async fetchCsrf(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/v1/auth/csrf`, { headers: this.headers(false) });
    if (response.status !== 200) {
      throw new Error(`csrf endpoint returned ${response.status}`);
    }
    const body = (await response.json()) as { csrfToken: string };
    this.csrfToken = body.csrfToken;
  }

  /**
   * Track session-id rotation: the API may Set-Cookie a fresh sid on any
   * authenticated response; the client must follow it or the next request
   * uses a dead session id.
   */
  private absorbSetCookie(response: Response): void {
    const setCookie = response.headers.get('set-cookie');
    if (setCookie === null) return;
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(setCookie);
    if (match !== null) this.cookieValue = match[1];
  }

  async call(method: string, path: string, body?: unknown): Promise<Response> {
    const mutating = method !== 'GET';
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(mutating),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.absorbSetCookie(response);
    return response;
  }
}

function parseArgs(argv: string[]): HarnessOptions {
  const args = new Map(argv.map((arg) => {
    const eq = arg.indexOf('=');
    return eq === -1 ? [arg.slice(2), ''] : [arg.slice(2, eq), arg.slice(eq + 1)];
  }));
  const baseUrl = args.get('base-url') ?? process.env.STAGING_BASE_URL ?? '';
  if (baseUrl.length === 0) {
    throw new Error('Missing --base-url=<staging base url> (or STAGING_BASE_URL).');
  }
  return { baseUrl, cookieA: args.get('cookie') ?? '', cookieB: args.get('cookie-b') ?? '' };
}

async function promptCookie(label: string): Promise<string> {
  // Non-interactive contexts (CI, piped stdin) must fail fast, not hang on a
  // prompt nobody can answer.
  if (stdin.isTTY !== true) {
    throw new Error(`No ${label} cookie supplied. Pass --cookie / --cookie-b, or run interactively to paste it.`);
  }
  const readline = createInterface({ input: stdin, output: stdout });
  const value = await readline.question(`Paste the ${SESSION_COOKIE_NAME} value for ${label} (or press Enter to abort): `);
  readline.close();
  if (value.trim().length === 0) {
    throw new Error(`No ${label} cookie supplied — sign in at the staging origin first, then copy the session cookie.`);
  }
  return value.trim();
}

const ORG_B_TOKEN = `orgb-${randomUUID()}`;

/** Org B incident description carries a string that exists nowhere else — the search-inference probe. */
function orgBDescription(): string {
  return `Managed-database staging incident. Marker: ${ORG_B_TOKEN}`;
}

export async function runStagingE2E(options: HarnessOptions, log: (line: string) => void): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const record = (name: string, passed: boolean, detail?: string): void => {
    results.push({ name, passed, detail });
    log(`[${passed ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  };

  const clientA = new ApiClient(options.baseUrl, options.cookieA, log);
  const clientB = new ApiClient(options.baseUrl, options.cookieB, log);

  // --- Liveness ---------------------------------------------------------
  {
    const health = await fetch(`${options.baseUrl}/healthz`);
    const body = (await health.json()) as { status?: string };
    record('healthz returns ok', health.status === 200 && body.status === 'ok', `status ${health.status}`);
  }

  // --- Identity A: onboard Org A, full incident flow ---------------------
  {
    const me = await clientA.call('GET', '/api/v1/me');
    record('user A session valid', me.status === 200, `GET /me ${me.status}`);
  }
  await clientA.fetchCsrf();
  const orgA = await clientA.call('POST', '/api/v1/organizations', { name: `Staging Org A ${Date.now()}` });
  const orgABody = orgA.status === 200 ? (await orgA.json()) as { organization: { id: string } } : null;
  record('user A creates Org A (owner membership in one transaction)', orgA.status === 200 && orgABody !== null, `POST /organizations ${orgA.status}`);

  const incidentA = await clientA.call('POST', '/api/v1/incidents', {
    title: 'Staging flow incident A',
    description: `Created by the staging E2E harness at ${new Date().toISOString()}`,
    severity: 'low',
  });
  const incidentABody = incidentA.status === 200 ? (await incidentA.json()) as { id: string; version: number } : null;
  record('Org A: incident created', incidentA.status === 200 && incidentABody !== null, `POST /incidents ${incidentA.status}`);

  if (incidentABody !== null) {
    const patched = await clientA.call('PATCH', `/api/v1/incidents/${incidentABody.id}`, {
      status: 'investigating',
      expectedVersion: incidentABody.version,
    });
    record('Org A: incident status transition (optimistic version)', patched.status === 200, `PATCH ${patched.status}`);

    const commented = await clientA.call('POST', `/api/v1/incidents/${incidentABody.id}/comments`, { body: 'Staging E2E comment.' });
    record('Org A: comment created', commented.status === 200, `POST comments ${commented.status}`);
  }

  // --- Identity B: onboard Org B with a unique marker --------------------
  {
    const me = await clientB.call('GET', '/api/v1/me');
    record('user B session valid', me.status === 200, `GET /me ${me.status}`);
  }
  await clientB.fetchCsrf();
  const orgB = await clientB.call('POST', '/api/v1/organizations', { name: `Staging Org B ${Date.now()}` });
  const orgBBody = orgB.status === 200 ? (await orgB.json()) as { organization: { id: string } } : null;
  record('user B creates Org B (independent org)', orgB.status === 200 && orgBBody !== null, `POST /organizations ${orgB.status}`);

  const incidentB = await clientB.call('POST', '/api/v1/incidents', {
    title: 'Staging flow incident B',
    description: orgBDescription(),
    severity: 'medium',
  });
  const incidentBBody = incidentB.status === 200 ? (await incidentB.json()) as { id: string } : null;
  record('Org B: incident created with unique marker', incidentB.status === 200 && incidentBBody !== null, `POST /incidents ${incidentB.status}`);

  // --- Cross-tenant matrix as user A (P1-7, against the managed DB) ------
  if (incidentBBody !== null && orgBBody !== null) {
    const list = await clientA.call('GET', '/api/v1/incidents?pageSize=100');
    const listBody = list.status === 200 ? (await list.json()) as { data: Array<{ id: string }> } : null;
    record(
      'Org A cannot enumerate Org B rows',
      list.status === 200 && listBody !== null && !listBody.data.some((incident) => incident.id === incidentBBody.id),
      `GET /incidents ${list.status}`,
    );

    const search = await clientA.call('GET', `/api/v1/incidents?q=${encodeURIComponent(ORG_B_TOKEN)}`);
    const searchBody = search.status === 200 ? (await search.json()) as { data: Array<{ id: string }> } : null;
    record(
      'Org A search for an Org-B-only string returns empty (no inference signal)',
      search.status === 200 && searchBody !== null && searchBody.data.length === 0,
      `GET /incidents?q=... ${search.status}`,
    );

    const foreignGet = await clientA.call('GET', `/api/v1/incidents/${incidentBBody.id}`);
    record('Org A cannot view Org B incident by id', foreignGet.status === 404, `GET ${foreignGet.status}`);

    const foreignPatch = await clientA.call('PATCH', `/api/v1/incidents/${incidentBBody.id}`, {
      status: 'resolved',
      expectedVersion: 1,
    });
    record('Org A cannot edit Org B incident', foreignPatch.status === 404, `PATCH ${foreignPatch.status}`);

    const foreignComment = await clientA.call('POST', `/api/v1/incidents/${incidentBBody.id}/comments`, { body: 'should not land' });
    record('Org A cannot comment on Org B incident', foreignComment.status === 404, `POST comments ${foreignComment.status}`);

    const guessed = await clientA.call('GET', `/api/v1/incidents/${randomUUID()}`);
    record('guessed UUID is indistinguishable from foreign (404)', guessed.status === 404, `GET ${guessed.status}`);

    const switchAttempt = await clientA.call('POST', '/api/v1/me/active-organization', { organizationId: orgBBody.organization.id });
    record('Org A user cannot switch into Org B (403 + audit)', switchAttempt.status === 403, `POST active-organization ${switchAttempt.status}`);
  }

  // --- Revocation (server-side session deletion) -------------------------
  {
    const logout = await clientA.call('POST', '/api/v1/auth/logout');
    record('user A logout succeeds', logout.status === 200 || logout.status === 204, `POST logout ${logout.status}`);

    const afterLogout = await clientA.call('GET', '/api/v1/me');
    record('revoked session is dead: same cookie now 401', afterLogout.status === 401, `GET /me ${afterLogout.status}`);

    if (options.cookieB.length > 0) {
      const bStillValid = await clientB.call('GET', '/api/v1/me');
      record('user B session unaffected (revocation is per-session)', bStillValid.status === 200, `GET /me ${bStillValid.status}`);
    }
  }

  return results;
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.cookieA.length === 0) options.cookieA = await promptCookie('user A');
  if (options.cookieB.length === 0) options.cookieB = await promptCookie('user B');

  console.log(`staging E2E against ${options.baseUrl}`);
  const results = await runStagingE2E(options, (line) => console.log(line));
  const failed = results.filter((result) => !result.passed);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
  if (failed.length > 0) {
    console.error(`FAILED (${failed.length}):`);
    for (const failure of failed) console.error(` - ${failure.name}${failure.detail === undefined ? '' : ` — ${failure.detail}`}`);
    process.exitCode = 1;
  }
}

const isEntry = process.argv[1] !== undefined && process.argv[1].includes('staging-live');
if (isEntry) {
  await run().catch((error: unknown) => {
    const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
    console.error(`staging E2E aborted: ${error instanceof Error ? error.message : String(error)}${cause}`);
    process.exitCode = 1;
  });
}
