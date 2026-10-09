# Branch protection and rollback procedure

Anchored to repository state as of `a0f342b` (recorded 2026-10-09, PROD-001). Re-review after any workflow change.

**Repo facts these commands assume:** remote `origin` = `github.com/techilounge/resolveops-ai`; default branch `main`; PRs land via **squash merge** (each merged PR becomes one single-parent commit on `main` — this is what makes the plain `git revert` steps below exact); baseline tag `hackathon-baseline-2026-10-08` (annotated tag object `aa7a2726`) → commit `b99ed48`.

## 1. Branch-protection expectations

- `main` is the integration branch. All changes land through PRs from feature branches (`feat/*`, `docs/*`, `revert/*`), squash-merged — never by direct push.
- Never force-push `main`, never rewrite its history, and never delete, move, or retarget the baseline tag. The tag object must stay where it is: it anchors the revert procedures in §4.
- Every PR: CI green before merge (currently the verify job: `npm ci --no-audit --no-fund` + `npm run check`), the `.github/pull_request_template.md` safety checkboxes confirmed, and human approval before publishing the PR and separately before merging (per `AGENTS.md`).
- Protected content: `src/types.ts`, `src/data/incident.ts`, `src/lib/inventory.ts`, and `scripts/**` are expected to survive every change untouched — verify with §2 before and after risky merges.
- **Enforcement status (verified 2026-10-09):** GitHub branch protection rulesets are **not** configured on `main` (`protected: false`, no rulesets). The rules above are enforced as a working agreement plus the human publish/merge gates. Configuring machine-enforced rulesets is a deliberate later-phase decision, not part of this procedure.

## 2. Verify current state first

```bash
git fetch origin --tags
git log --oneline -5 origin/main
# Protected baseline intact? Expect EMPTY output:
git diff --stat hackathon-baseline-2026-10-08..origin/main -- src/types.ts src/data/incident.ts src/lib/inventory.ts scripts/
```

## 3. Roll back one merged PR

Squash merges produce single-parent commits, so a plain `git revert` removes exactly that PR's changes:

```bash
# Find the squash commit if you only know the PR number:
gh pr view <PR_NUMBER> --json mergeCommit --jq .mergeCommit.oid

git fetch origin
git checkout -b revert/<PR_NUMBER>-<short-slug> origin/main
git revert --no-edit <SQUASH_SHA>   # e.g. PR #3: git revert --no-edit a0f342b
git push -u origin revert/<PR_NUMBER>-<short-slug>
gh pr create --base main --head revert/<PR_NUMBER>-<short-slug> \
  --title "revert: roll back PR #<PR_NUMBER>" \
  --body "Reverts <SQUASH_SHA>. Reason: <why>. Verify protected files: git diff --stat hackathon-baseline-2026-10-08..HEAD -- src/types.ts src/data/incident.ts src/lib/inventory.ts scripts/"
```

- The revert lands through its own PR: CI green, human approval, squash merge. Do not force-push `main` to "undo" a commit.
- If the revert conflicts with later merges, resolve the conflict manually; for the protected files, prefer the baseline-tagged content.

## 4. Roll everything back to the baseline (emergency)

Reverts the full delta since the baseline tag into one commit, via PR — no history rewrite:

```bash
git fetch origin --tags
git checkout -b revert-to-baseline origin/main
git revert --no-commit b99ed48..origin/main
git commit -m "revert: restore hackathon-baseline-2026-10-08 (b99ed48) state"
git push -u origin revert-to-baseline
gh pr create --base main --head revert-to-baseline \
  --title "revert: restore hackathon baseline (b99ed48)" \
  --body "Emergency rollback to the hackathon-baseline-2026-10-08 tag. Requires CI green and human approval."
```

- The tag itself is never moved or re-pointed; rollback is forward-history reverts only.
- After this revert, later work re-lands PR-by-PR from the original branches/SHAs.

## 5. After any rollback

```bash
npm ci --no-audit --no-fund && npm run check   # expect 32/32 Vitest + clean strict typecheck + production build
```

Then re-check the §2 protected-files diff. CI must be green on the rollback PR before merge.
