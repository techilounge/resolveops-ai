# Diagnostic tooling landing zone

This directory holds the TASK-02 read-only diagnostic toolkit:

- [`Get-BitLockerDiagnostic.ps1`](./Get-BitLockerDiagnostic.ps1) — read-only BitLocker
  volume diagnostic reporter. Fixture mode (`-InputFixturePath`, no OS cmdlets) and
  live mode (Windows test machines only). Emits structured JSON; never changes device
  state and never reports key material. See
  [`../docs/DIAGNOSTIC-RUNBOOK.md`](../docs/DIAGNOSTIC-RUNBOOK.md) before running anything.
- [`fixtures/`](./fixtures/) — synthetic JSON fixtures shaped like diagnostic data.

No script in this directory may change device state, request elevation, or be run
against production systems.
