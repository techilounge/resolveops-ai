# ResolveOps AI — Autonomous IT Resolution Factory

A clean, intentionally small starter for **ATX Frontier Hackathon (October 9, 2026)**. Provides a functioning incident dashboard and 47 **synthetic** Windows 11 endpoint records. The autonomous *software delivery factory* is built and observed in **Obvious**, not faked inside this app.

## What works before the hackathon
- Responsive dashboard, inventory listing/search, three-task delivery board
- Real TypeScript inventory summary calculations
- Deterministic mock records and baseline unit tests
- GitHub Actions CI and PR template
- Explicit prompts/specifications and demo script

## What intentionally does NOT work yet
- No incident assessment engine, diagnostics generator, automated remediation, PR tracking connector, or external integrations.
- Any 'factory' progress shown in the UI is labeled not started; no fake agent telemetry.

## Start locally
Requires Node.js 22 and npm.
```bash
npm install
npm run check
npm run dev
```
Open the address Vite prints (typically http://localhost:5173).
The committed lockfile supports reproducible validation with `npm ci --no-audit --no-fund && npm run check`, matching GitHub Actions. `check` runs the existing unit tests, strict TypeScript check, and production build. See `docs/READINESS-REPORT.md` for pre-event validation evidence.

## Hackathon mission
1. In Obvious, connect the GitHub repository.
2. Give the agent `docs/OBVIOUS-LAUNCH-PROMPT.md`.
3. Assign `tasks/TASK-01.md`, `tasks/TASK-02.md`, `tasks/TASK-03.md` independently.
4. Capture real PR, test, and review evidence (see `docs/EVIDENCE-LOG.md`).
5. Demo one end-to-end factory cycle, not hypothetical status counts.

## Repository layout
- `src/data/incident.ts`: synthetic incident and 47 endpoint records
- `src/lib/inventory.ts`: baseline inventory summary
- `src/main.tsx`: functional dashboard
- `tasks/`: three bounded coding assignments
- `docs/`: Obvious kickoff, build strategy, and demo
- `scripts/`: reserved for safe PowerShell diagnostic from TASK-02

## Security
No Microsoft Graph or live device connections. Never execute device-modifying commands. This is a hackathon demonstration using entirely fictitious assets.

## Publishing to a new GitHub repo
Obtain human approval before publishing. Check `git status`, `git branch --show-current`, and `git remote -v` before committing or pushing an existing checkout. The commands below are for a new folder without Git history.

1. Create an empty GitHub repository named `resolveops-ai` (do not initialize with a README).
2. From this folder run:
```bash
git init
git add .
git commit -m "chore: scaffold ResolveOps AI hackathon starter"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/resolveops-ai.git
git push -u origin main
```
3. Confirm GitHub Actions runs green. Connect it in Obvious and use `docs/OBVIOUS-LAUNCH-PROMPT.md`.
