# TASK-02 — Read-only PowerShell diagnostic toolkit
**Branch:** `feat/read-only-diagnostics`  
**Primary ownership:** `scripts/` and `docs/DIAGNOSTIC-RUNBOOK.md` only.

## Goal
Create a diagnostic PowerShell script usable on a *test machine only* to report BitLocker protection/volume state without making changes. Also support synthetic fixture testing.

## Acceptance criteria
- `scripts/Get-BitLockerDiagnostic.ps1` reads and normalizes BitLocker status; includes `-InputFixturePath` to load a JSON test fixture without calling OS cmdlets.
- Emit structured JSON with schema version, machine label, timestamp, encryption status, protection status, and warnings; do not output key material.
- Handle unavailable BitLocker cmdlets, access errors, and missing volumes gracefully with explicit structured error results.
- Write Pester tests for fixture-only mode with no Windows dependency. Provide setup instructions for PowerShell 7 + Pester 5 and a safe runbook.
- For a fixture run, collect actual executed command/output as PR verification evidence.
- Run `npm run check` to preserve the application baseline, alongside the separately executed fixture-only Pester tests. Record both commands and their results.
- Never run on production systems during the hackathon.

## Forbidden
Do NOT change encryption settings, delete protectors, suspend BitLocker, export recovery keys, change registry, or request admin elevation.
