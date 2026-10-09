# Diagnostic runbook — read-only BitLocker diagnostics (TASK-02)

**Tool:** `scripts/Get-BitLockerDiagnostic.ps1` (PowerShell 7 compatible)
**Status:** Read-only diagnostics only. **Never run against production systems.**
**Verified environment for the evidence below:** Linux sandbox, PowerShell 7.4.6, Pester 5.7.1. Fixture mode is OS-independent; live mode requires Windows.

## Safety envelope

This tool reports state. It never changes it.

- Read-only: fixture mode calls **zero OS cmdlets**; live mode only reads `Get-Volume` / `Get-BitLocker`.
- Forbidden everywhere (also enforced by repo `AGENTS.md`): no `manage-bde`, no suspending protection, no protector deletion, no key export, no registry changes, no admin elevation requests (the script deliberately has no `#Requires -RunAsAdministrator`).
- Key material never appears in output: only key-protector **types** are reported (`Tpm`, `RecoveryPassword`, …), `keyMaterialExposed` is structurally always `false`, and unrecognized string values in the source are withheld from warnings rather than echoed (a hostile fixture cannot smuggle a recovery password into the report through any string field).
- Every problem surfaces as a structured `errors[]` entry in a complete JSON document — never as thrown text or truncated output.

## Setup

### PowerShell 7

Windows: install from <https://aka.ms/powershell> (MSI) or `winget install Microsoft.PowerShell`.
Linux (the method used to produce the evidence in this runbook):

```bash
curl -sSL -o /tmp/powershell.tar.gz \
  https://github.com/PowerShell/PowerShell/releases/download/v7.4.6/powershell-7.4.6-linux-x64.tar.gz
mkdir -p ~/powershell7 && tar -xzf /tmp/powershell.tar.gz -C ~/powershell7
~/powershell7/pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
# → 7.4.6
```

### Pester 5

```powershell
Install-Module -Name Pester -RequiredVersion 5.7.1 -Scope CurrentUser -Force -SkipPublisherCheck -AllowClobber
```

## Fixture mode (safe on any OS)

Loads a synthetic JSON fixture and normalizes it into the report. No cmdlet is
invoked — guaranteed by construction and asserted by a guard test.

```bash
pwsh -NoProfile -File scripts/Get-BitLockerDiagnostic.ps1 \
  -InputFixturePath scripts/fixtures/lab-w11-sample.json \
  -GeneratedAtUtc '2026-10-09T17:30:00Z'
```

Actual output (executed in the verification sandbox, exit code `0`):

```json
{
  "schemaVersion": "1.0",
  "source": "fixture",
  "machineLabel": "LAB-W11-001",
  "generatedAtUtc": "2026-10-09T17:30:00Z",
  "volumes": [
    {
      "driveLetter": "C",
      "volumeName": "OS",
      "encryptionStatus": "FullyEncrypted",
      "protectionStatus": "On",
      "keyProtectorTypes": [ "RecoveryPassword", "Tpm" ]
    },
    {
      "driveLetter": "D",
      "volumeName": "Data",
      "encryptionStatus": "FullyDecrypted",
      "protectionStatus": "Off",
      "keyProtectorTypes": []
    },
    {
      "driveLetter": "E",
      "volumeName": "USB-TEST",
      "encryptionStatus": "Encrypted",
      "protectionStatus": "Unknown",
      "keyProtectorTypes": [ "ExternalKey" ]
    }
  ],
  "warnings": [
    "Synthetic fixture data created for TASK-02 testing. No live system was contacted.",
    "Volume E: unrecognized protectionStatus value (withheld); reported as 'Unknown'.",
    "Fixture mode: synthetic data only - no live system was contacted."
  ],
  "errors": [],
  "keyMaterialExposed": false
}
```

Notes:

- `-GeneratedAtUtc` is an injected clock for deterministic output; omit it for the current UTC time.
- `-MachineLabel` overrides the report label in both modes.
- The schema is versioned (`schemaVersion: 1.0`) so consumers can pin on it.

## Pester suite (fixture-only, no Windows dependency)

```bash
pwsh -NoProfile -Command '$cfg = New-PesterConfiguration; $cfg.Run.Exit = $true; $cfg.Run.Path = "scripts/Get-BitLockerDiagnostic.Tests.ps1"; $cfg.Output.Verbosity = "Detailed"; Invoke-Pester -Configuration $cfg'
```

Actual result (executed in the verification sandbox, exit code `0`):

```
Tests Passed: 17, Failed: 0, Skipped: 0, Inconclusive: 0, NotRun: 0
```

Coverage: fixture happy path (schema, normalization, sorted key-protector types), end-to-end
subprocess execution with parseable JSON, the no-OS-cmdlet guard test, hostile-fixture key-material
non-disclosure, malformed / missing / wrong-root / missing-driveLetter fixtures, `-MachineLabel`
override, and live-mode error paths via Pester mocks (`CMDLET_UNAVAILABLE`, per-volume
`ACCESS_DENIED`, `VOLUME_MISSING`, and key-property non-emission from simulated BitLocker objects).

## Structured error handling

Exit code is `0` when `errors` is empty, `1` when any error entry exists. The JSON document is
always complete and parseable.

| Code | Meaning |
|---|---|
| `CMDLET_UNAVAILABLE` | `Get-Volume` / `Get-BitLocker` does not exist on this host (live mode needs Windows). |
| `ACCESS_DENIED` | The OS refused access to volume or BitLocker state. |
| `VOLUME_MISSING` | No mounted drive-letter volumes found, or a volume's BitLocker state is absent. |
| `FIXTURE_NOT_FOUND` | The `-InputFixturePath` file does not exist. |
| `FIXTURE_INVALID` | The fixture is not valid JSON, is not an object, or has malformed volume entries. |
| `UNEXPECTED_ERROR` | Anything else; the `detail` field carries the raw exception message. |

Actual malformed-fixture output (exit code `1`):

```json
{
  "schemaVersion": "1.0",
  "source": "fixture",
  "machineLabel": null,
  "generatedAtUtc": "2026-10-09T16:57:31Z",
  "volumes": [],
  "warnings": [ "Fixture mode: synthetic data only - no live system was contacted." ],
  "errors": [
    {
      "code": "FIXTURE_INVALID",
      "message": "Fixture file '/tmp/bad-fixture.json' is not valid JSON.",
      "detail": "Conversion from JSON failed with error: Invalid character after parsing property name. Expected ':' but got: v. Path '', line 1, position 6."
    }
  ],
  "keyMaterialExposed": false
}
```

## Live mode (Windows test machines only)

```powershell
# On a Windows test machine:
./scripts/Get-BitLockerDiagnostic.ps1
```

Reads `Get-Volume`, then `Get-BitLocker -MountPoint <drive>:` per volume, normalizes statuses,
and emits the same JSON schema with `source: "live"`. Per-volume failures become `errors[]`
entries; the remaining volumes still report.

Reference — actual output when live mode runs where the Windows cmdlets do not exist
(executed on the Linux verification sandbox, exit code `1`):

```json
{
  "schemaVersion": "1.0",
  "source": "live",
  "machineLabel": "LINUX-SANDBOX-NO-WINDOWS",
  "generatedAtUtc": "2026-10-09T16:57:32Z",
  "volumes": [],
  "warnings": [],
  "errors": [
    {
      "code": "CMDLET_UNAVAILABLE",
      "message": "Could not enumerate volumes with 'Get-Volume'. Live mode requires a Windows test machine with the Storage module.",
      "detail": "The term 'Get-Volume' is not recognized as a name of a cmdlet, function, script file, or executable program.\nCheck the spelling of the name, or if a path was included, verify that the path is correct and try again."
    }
  ],
  "keyMaterialExposed": false
}
```

## Verification statement (honesty rule)

Executed for real in the verification sandbox: the full fixture-mode report above, the
malformed-fixture error path, the live-mode unavailability path, and the 17-test Pester suite
(all passing). **Not** executed: live mode against an actual Windows BitLocker volume — no
Windows machine was available in this environment; that path is covered by Pester mocks only and
must be exercised on a Windows test machine before production-adjacent use. `npm run check` is
run separately from Pester and does not exercise this script.

## Prohibition

This toolkit is for the synthetic hackathon incident and isolated Windows **test** machines only.
Do not run it against production systems, and do not extend it to change device state — remediation
in ResolveOps AI is proposal-only (TASK-03) and requires explicit human approval.
