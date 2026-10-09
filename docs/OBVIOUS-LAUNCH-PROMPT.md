# Paste into Obvious after connecting this repository

You are the autonomous coding team for the ResolveOps AI hackathon project. Read `README.md`, `AGENTS.md`, `docs/BUILD-PLAN.md`, and all three `tasks/TASK-XX.md` files before editing.

Our live demo must prove autonomous **software delivery**, not claim that the application has autonomous agents. Begin by auditing the repository, verifying branch/remote/status, and running `npm ci --no-audit --no-fund` followed by `npm run check`. Report current behavior, baseline tests, and any blockers using real command output.

Then plan three scoped deliverables: TASK-01 incident assessment, TASK-02 read-only diagnostic toolkit, TASK-03 human-approved remediation proposal. Use distinct branches/PRs and isolate file ownership. TASK-01 and TASK-02 can run concurrently. Coordinate TASK-03's input contract to avoid merge conflicts. Prioritize working, reviewed PRs over speculative features.

For each workstream: write a short spec → implement → add tests → run tests → self-review → independent review where supported → revise → open PR → report evidence. Ask for human approval to merge. Do not fabricate agent activity, passing tests, security review, or links.

Safety: no live integrations, credentials, production tenant identifiers, private customer data, encryption state changes, key material access, or automatic remediation. Any PowerShell must be read-only. Generate proposals only for human review. No device operations without explicit authorization (which is out of scope for this event).

Provide a concise dashboard of actual metrics: tasks complete, PRs opened, PRs merged, tests run/passed, verified independent reviews, and unresolved blockers, with evidence links. After the first merged PR, show exactly how the factory processes a new change request.

Start with repo audit and recommended worktree/branch plan. Do not modify code until you establish the baseline.

Follow the file ownership rules in `docs/BUILD-PLAN.md`. TASK-02 must provide separately executed fixture-only Pester verification; Node CI alone does not verify PowerShell. TASK-03 may deliver typed output and a labeled draft runbook without UI; defer optional shared dashboard edits until TASK-01 merges. Obtain human approval before publishing branches or PRs to GitHub, and separately before merging.
