# ResolveOps AI — Autonomous IT Resolution Factory

A synthetic incident-operations demo for Windows 11 endpoint compliance: a responsive dashboard over 47 **synthetic** devices, a deterministic incident assessment engine, a read-only BitLocker diagnostic toolkit, and human-gated remediation proposals. The autonomous *software delivery factory* is built and observed in **Obvious**, not faked inside this app.

> **Status: delivered — post-hackathon, pre-SaaS.** Updated 2026-10-09 (PROD-001).
> Current `main`: `a0f342b` · Baseline tag: `hackathon-baseline-2026-10-08` → `b99ed48` (pre-delivery baseline; the protected domain files are bit-identical to it).

## Delivered work (TASK-01/02/03 — merged PRs #1–#3)

| Task | Deliverable | PR (squash-merged) | Merge SHA |
|---|---|---|---|
| TASK-01 | Evidence-backed incident assessment (`assessIncident`, dashboard view) | [#1](https://github.com/techilounge/resolveops-ai/pull/1) | `b2ab034` |
| TASK-02 | Read-only BitLocker diagnostic toolkit + Pester fixture suite | [#2](https://github.com/techilounge/resolveops-ai/pull/2) | `bd5ac6f` |
| TASK-03 | Human-gated draft remediation proposals (`buildRemediationProposal`) | [#3](https://github.com/techilounge/resolveops-ai/pull/3) | `a0f342b` |

Evidence — CI runs, independent review verdicts, test counts — is recorded in [`docs/EVIDENCE-LOG.md`](docs/EVIDENCE-LOG.md).

## What works now

- **Incident assessment engine** — pure `assessIncident(devices)` with grouped conditions, a unique impacted population, and severity-ranked, evidence-backed recommendations; rendered as a dashboard view.
- **Read-only diagnostics** — `scripts/Get-BitLockerDiagnostic.ps1` reports BitLocker volume/protection state as structured JSON; fixture mode calls zero OS cmdlets; it never suspends, decrypts, deletes, exports, or elevates.
- **Human-gated proposals** — `buildRemediationProposal()` emits output labeled `Draft — human approval required`; approval fields are structurally null until a human acts, and tests assert no executable device-modifying commands.
- **Demo dashboard** — 47 synthetic Windows 11 endpoints and incident `INC-2026-1047`; no network calls, no storage, no environment access.

## Verification status

- `npm run check` green on `main` (`a0f342b`): **32/32 Vitest** (`inventory` 3, `assessment` 11, `proposal` 18), strict `tsc -b`, production build.
- **Pester 17/17** fixture-only suite (documented run: PowerShell 7.4.6 + Pester 5.7.1 on Linux). By design, Node CI does not run PowerShell; see `docs/DIAGNOSTIC-RUNBOOK.md`.
- **Node compatibility:** CI pins **Node 22** (`.github/workflows/ci.yml`); the pre-event readiness validation ran on v24.19.0, and the full check is also verified green on v20.20.2. One deliberate version pin (`engines`/`.nvmrc`) is planned for PROD-005; until then Node 22 is the CI target and other versions are a compatibility note, not a supported matrix.
- CI history on `main`: all runs green through `a0f342b` (latest: [run 37974491047](https://github.com/techilounge/resolveops-ai/actions/runs/37974491047)).

## Start locally

```bash
npm ci --no-audit --no-fund && npm run check   # tests + strict typecheck + production build
npm run dev                                    # http://localhost:5173
```

The committed lockfile is the reproducibility pin; CI uses the same commands.

## Repository layout

- `src/main.tsx` — demo dashboard (frozen for Phase 0)
- `src/types.ts`, `src/data/incident.ts`, `src/lib/inventory.ts` — protected baseline domain files (bit-identical to `b99ed48`)
- `src/lib/assessment.ts` (+ tests) — TASK-01 assessment engine
- `src/lib/proposal.ts` (+ tests) — TASK-03 proposal generator
- `scripts/` — TASK-02 read-only diagnostic toolkit, fixtures, Pester suite
- `docs/` — runbooks, delivery evidence, and **archived** period documents (dated banners)
- `tasks/` — **archived** task specifications (all three delivered; dated banners)
- `.github/workflows/ci.yml` — verify job (`npm ci --no-audit --no-fund` + `npm run check`, Node 22)

## Safety boundaries

No Microsoft Graph or live device connections. Never execute device-modifying commands. This is a demonstration using entirely fictitious assets. `AGENTS.md` holds the binding boundaries for autonomous agents. The planned SaaS transition (Phase 0 onward) is separately gated: Phase 0 adds documentation, decision records, and repository structure only — no external services are contacted and no credentials are introduced.

## Branch protection and rollback

`main` is the integration branch: changes land only via squash-merged PRs; never force-push or rewrite history; the baseline tag object must never move. Per-PR rollback and baseline-anchored revert procedures: [`docs/ROLLBACK.md`](docs/ROLLBACK.md).
