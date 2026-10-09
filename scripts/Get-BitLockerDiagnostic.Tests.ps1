# Pester 5 fixture-only test suite for Get-BitLockerDiagnostic.ps1 (TASK-02).
#
# These tests never touch a real system: fixture mode is exercised directly,
# and live mode is exercised only through Pester mocks. They require
# PowerShell 7 + Pester 5 and run on any OS - no Windows dependency.
# Setup instructions: docs/DIAGNOSTIC-RUNBOOK.md
#
# Run:  pwsh -NoProfile -Command "Invoke-Pester -Path scripts/Get-BitLockerDiagnostic.Tests.ps1"
#       (or see the runbook for the full configuration)

BeforeAll {
    . (Join-Path -Path $PSScriptRoot -ChildPath 'Get-BitLockerDiagnostic.ps1')
    $scriptPath = Join-Path -Path $PSScriptRoot -ChildPath 'Get-BitLockerDiagnostic.ps1'
    $sampleFixturePath = Join-Path -Path $PSScriptRoot -ChildPath 'fixtures/lab-w11-sample.json'
    $injectedNow = [datetime] '2026-10-09T17:30:00Z'

    # Pester cannot mock a command that does not exist on this OS, so define
    # resolvable stubs for the Windows-only cmdlets when they are missing
    # (e.g. on Linux sandboxes). Every live-mode test Mocks these; a call that
    # reaches the real stub means a Mock was not applied and the test fails.
    if (-not (Get-Command Get-Volume -ErrorAction SilentlyContinue)) {
        function Get-Volume { throw 'Pester stub reached: Mock Get-Volume was not applied.' }
    }
    if (-not (Get-Command Get-BitLocker -ErrorAction SilentlyContinue)) {
        function Get-BitLocker { throw 'Pester stub reached: Mock Get-BitLocker was not applied.' }
    }
}

Describe 'Fixture mode' {

    Context 'happy path (sample fixture)' {

        # Guard rails around every fixture-mode test: if the implementation
        # ever calls an OS cmdlet in fixture mode, these mocks intercept it
        # and the guard assertions below fail.
        BeforeEach {
            Mock Get-Volume
            Mock Get-BitLocker
        }

        It 'returns a structured report matching the pinned schema' {
            $result = Invoke-BitLockerDiagnostic -InputFixturePath $sampleFixturePath -GeneratedAtUtc $injectedNow

            $result.schemaVersion | Should -Be '1.0'
            $result.source | Should -Be 'fixture'
            $result.machineLabel | Should -Be 'LAB-W11-001'
            $result.generatedAtUtc | Should -Be '2026-10-09T17:30:00Z'
            @($result.volumes).Count | Should -Be 3
            @($result.errors).Count | Should -Be 0
            $result.keyMaterialExposed | Should -Be $false
        }

        It 'normalizes volume state and sorts key-protector types' {
            $result = Invoke-BitLockerDiagnostic -InputFixturePath $sampleFixturePath -GeneratedAtUtc $injectedNow

            $os = $result.volumes | Where-Object { $_.driveLetter -eq 'C' }
            $os.volumeName | Should -Be 'OS'
            $os.encryptionStatus | Should -Be 'FullyEncrypted'
            $os.protectionStatus | Should -Be 'On'
            $os.keyProtectorTypes | Should -Be @('RecoveryPassword', 'Tpm')

            $data = $result.volumes | Where-Object { $_.driveLetter -eq 'D' }
            $data.encryptionStatus | Should -Be 'FullyDecrypted'
            $data.protectionStatus | Should -Be 'Off'
            $data.keyProtectorTypes | Should -Be @()

            $usb = $result.volumes | Where-Object { $_.driveLetter -eq 'E' }
            $usb.protectionStatus | Should -Be 'Unknown'
        }

        It 'carries fixture warnings plus the fixture-mode safety notice' {
            $result = Invoke-BitLockerDiagnostic -InputFixturePath $sampleFixturePath -GeneratedAtUtc $injectedNow

            ($result.warnings -join ' ') | Should -Match 'Synthetic fixture data'
            ($result.warnings -join ' ') | Should -Match 'no live system was contacted'
        }

        It 'serializes to parseable JSON when executed as a script (end-to-end)' {
            $output = & pwsh -NoProfile -File $scriptPath `
                -InputFixturePath $sampleFixturePath `
                -GeneratedAtUtc '2026-10-09T17:30:00Z'
            $LASTEXITCODE | Should -Be 0

            $parsed = ($output -join "`n") | ConvertFrom-Json
            $parsed.schemaVersion | Should -Be '1.0'
            $parsed.source | Should -Be 'fixture'
            $parsed.machineLabel | Should -Be 'LAB-W11-001'
            @($parsed.volumes).Count | Should -Be 3
            $parsed.keyMaterialExposed | Should -Be $false
        }

        It 'never calls OS cmdlets in fixture mode (guard test)' {
            Invoke-BitLockerDiagnostic -InputFixturePath $sampleFixturePath -GeneratedAtUtc $injectedNow | Out-Null

            Should -Invoke Get-Volume -Exactly -Times 0
            Should -Invoke Get-BitLocker -Exactly -Times 0
        }

        It 'preserves array shape for keyProtectorTypes through the JSON round-trip' {
            # PowerShell unrolls single-element/empty lists unless forced into
            # array semantics; consumers need a stable array shape.
            $result = Invoke-BitLockerDiagnostic -InputFixturePath $sampleFixturePath -GeneratedAtUtc $injectedNow
            $parsed = (ConvertTo-DiagnosticJson -Result $result) | ConvertFrom-Json

            foreach ($volume in $parsed.volumes) {
                $volume.keyProtectorTypes -is [array] | Should -Be $true
            }
            @($parsed.volumes | Where-Object { $_.driveLetter -eq 'D' }).keyProtectorTypes.Count | Should -Be 0
            @($parsed.volumes | Where-Object { $_.driveLetter -eq 'C' }).keyProtectorTypes.Count | Should -Be 2
        }
    }

    Context 'hostile fixture (key material must never leak)' {

        It 'emits only whitelisted key-protector types and no key material' {
            $tempFixture = Join-Path ([System.IO.Path]::GetTempPath()) "hostile-fixture-$([guid]::NewGuid()).json"
            @'
{
  "machineLabel": "LAB-W11-HOSTILE",
  "recoveryPassword": "5820-1111-2222-3333-4444-5555-6666-7777",
  "volumes": [
    {
      "driveLetter": "C",
      "volumeName": "OS",
      "encryptionStatus": "FullyEncrypted-5820-1111-2222-3333",
      "protectionStatus": "On",
      "recoveryPassword": "5820-1111-2222-3333-4444-5555-6666-7777",
      "key": "AAECAwQFBgcICQ==",
      "keyProtectorTypes": ["Tpm", "5820-1111-2222-3333"]
    }
  ]
}
'@ | Set-Content -LiteralPath $tempFixture -NoNewline
            try {
                $result = Invoke-BitLockerDiagnostic -InputFixturePath $tempFixture -GeneratedAtUtc $injectedNow
                $json = ConvertTo-DiagnosticJson -Result $result

                $json | Should -Not -Match '5820-1111'
                $json | Should -Not -Match 'AAECAwQFBgcICQ'
                $result.keyMaterialExposed | Should -Be $false

                $os = $result.volumes | Where-Object { $_.driveLetter -eq 'C' }
                $os.keyProtectorTypes | Should -Be @('Tpm')
                $os.encryptionStatus | Should -Be 'Unknown'
                ($result.warnings -join ' ') | Should -Match 'unrecognized key-protector type entry'
                ($result.warnings -join ' ') | Should -Match 'withheld'
            }
            finally {
                Remove-Item -LiteralPath $tempFixture -Force -ErrorAction SilentlyContinue
            }
        }
    }

    Context 'malformed and missing fixtures' {

        It 'reports FIXTURE_INVALID for a malformed fixture as structured JSON' {
            $tempFixture = Join-Path ([System.IO.Path]::GetTempPath()) "malformed-$([guid]::NewGuid()).json"
            '{ not valid json !!' | Set-Content -LiteralPath $tempFixture -NoNewline
            try {
                $result = Invoke-BitLockerDiagnostic -InputFixturePath $tempFixture -GeneratedAtUtc $injectedNow

                @($result.errors).Count | Should -Be 1
                $result.errors[0].code | Should -Be 'FIXTURE_INVALID'
                $result.errors[0].message | Should -Not -BeNullOrEmpty
                @($result.volumes).Count | Should -Be 0
            }
            finally {
                Remove-Item -LiteralPath $tempFixture -Force -ErrorAction SilentlyContinue
            }
        }

        It 'exits 1 with structured FIXTURE_INVALID output when executed as a script' {
            $tempFixture = Join-Path ([System.IO.Path]::GetTempPath()) "malformed-$([guid]::NewGuid()).json"
            '{ not valid json !!' | Set-Content -LiteralPath $tempFixture -NoNewline
            try {
                $output = & pwsh -NoProfile -File $scriptPath -InputFixturePath $tempFixture
                $LASTEXITCODE | Should -Be 1

                $parsed = ($output -join "`n") | ConvertFrom-Json
                $parsed.errors[0].code | Should -Be 'FIXTURE_INVALID'
            }
            finally {
                Remove-Item -LiteralPath $tempFixture -Force -ErrorAction SilentlyContinue
            }
        }

        It 'reports FIXTURE_NOT_FOUND when the fixture file does not exist' {
            $result = Invoke-BitLockerDiagnostic -InputFixturePath (Join-Path ([System.IO.Path]::GetTempPath()) "no-such-fixture-$([guid]::NewGuid()).json") -GeneratedAtUtc $injectedNow

            @($result.errors).Count | Should -Be 1
            $result.errors[0].code | Should -Be 'FIXTURE_NOT_FOUND'
        }

        It 'reports FIXTURE_INVALID when the fixture root is not an object' {
            $tempFixture = Join-Path ([System.IO.Path]::GetTempPath()) "array-root-$([guid]::NewGuid()).json"
            '[1, 2, 3]' | Set-Content -LiteralPath $tempFixture -NoNewline
            try {
                $result = Invoke-BitLockerDiagnostic -InputFixturePath $tempFixture -GeneratedAtUtc $injectedNow

                @($result.errors).Count | Should -Be 1
                $result.errors[0].code | Should -Be 'FIXTURE_INVALID'
            }
            finally {
                Remove-Item -LiteralPath $tempFixture -Force -ErrorAction SilentlyContinue
            }
        }

        It 'reports FIXTURE_INVALID when a volume entry lacks a driveLetter' {
            $tempFixture = Join-Path ([System.IO.Path]::GetTempPath()) "no-letter-$([guid]::NewGuid()).json"
            @'
{
  "machineLabel": "LAB-W11-BAD",
  "volumes": [ { "volumeName": "OS", "encryptionStatus": "FullyEncrypted" } ]
}
'@ | Set-Content -LiteralPath $tempFixture -NoNewline
            try {
                $result = Invoke-BitLockerDiagnostic -InputFixturePath $tempFixture -GeneratedAtUtc $injectedNow

                @($result.errors).Count | Should -Be 1
                $result.errors[0].code | Should -Be 'FIXTURE_INVALID'
                $result.errors[0].message | Should -Match "index 0"
            }
            finally {
                Remove-Item -LiteralPath $tempFixture -Force -ErrorAction SilentlyContinue
            }
        }
    }

    Context 'machine label override' {

        It 'lets -MachineLabel override the fixture label' {
            $result = Invoke-BitLockerDiagnostic -InputFixturePath $sampleFixturePath -MachineLabel 'OVERRIDE-LAB-9' -GeneratedAtUtc $injectedNow
            $result.machineLabel | Should -Be 'OVERRIDE-LAB-9'
        }
    }
}

Describe 'Live mode (mocked - Windows cmdlets simulated)' {

    It 'reports CMDLET_UNAVAILABLE as a structured error when BitLocker cmdlets do not exist' {
        Mock Get-Volume {
            throw [System.Management.Automation.CommandNotFoundException]::new('The term ''Get-Volume'' is not recognized.')
        }

        $result = Invoke-BitLockerDiagnostic -MachineLabel 'LINUX-SANDBOX' -GeneratedAtUtc $injectedNow

        $result.source | Should -Be 'live'
        $result.machineLabel | Should -Be 'LINUX-SANDBOX'
        @($result.errors).Count | Should -Be 1
        $result.errors[0].code | Should -Be 'CMDLET_UNAVAILABLE'
        @($result.volumes).Count | Should -Be 0
    }

    It 'reports ACCESS_DENIED per volume when Get-BitLocker refuses access' {
        Mock Get-Volume {
            @(
                [pscustomobject] @{ DriveLetter = 'C'; FileSystemLabel = 'OS' },
                [pscustomobject] @{ DriveLetter = 'D'; FileSystemLabel = 'Data' }
            )
        }
        Mock Get-BitLocker {
            throw [System.UnauthorizedAccessException]::new('Access to the BitLocker WMI provider is denied.')
        }

        $result = Invoke-BitLockerDiagnostic -GeneratedAtUtc $injectedNow

        @($result.errors).Count | Should -Be 2
        $result.errors[0].code | Should -Be 'ACCESS_DENIED'
        $result.errors[0].message | Should -Match "volume 'C:'"
        $result.errors[1].code | Should -Be 'ACCESS_DENIED'
        $result.errors[1].message | Should -Match "volume 'D:'"
    }

    It 'reports VOLUME_MISSING when no drive-letter volumes are mounted' {
        Mock Get-Volume {
            @([pscustomobject] @{ DriveLetter = $null; FileSystemLabel = 'Recovery' })
        }

        $result = Invoke-BitLockerDiagnostic -GeneratedAtUtc $injectedNow

        @($result.errors).Count | Should -Be 1
        $result.errors[0].code | Should -Be 'VOLUME_MISSING'
        @($result.volumes).Count | Should -Be 0
    }

    It 'normalizes live BitLocker objects and never emits their key properties' {
        Mock Get-Volume {
            @([pscustomobject] @{ DriveLetter = 'C'; FileSystemLabel = 'OS' })
        }
        Mock Get-BitLocker {
            [pscustomobject] @{
                MountPoint       = 'C:'
                VolumeStatus     = 'FullyEncrypted'
                ProtectionStatus = 'On'
                KeyProtectors    = @(
                    [pscustomobject] @{ KeyProtectorType = 'Tpm'; Key = 'SIMULATED-KEY-MATERIAL' },
                    [pscustomobject] @{ KeyProtectorType = 'RecoveryPassword'; RecoveryPassword = '5820-9999-8888-7777' }
                )
            }
        }

        $result = Invoke-BitLockerDiagnostic -GeneratedAtUtc $injectedNow
        $json = ConvertTo-DiagnosticJson -Result $result

        @($result.volumes).Count | Should -Be 1
        $result.volumes[0].driveLetter | Should -Be 'C'
        $result.volumes[0].encryptionStatus | Should -Be 'FullyEncrypted'
        $result.volumes[0].protectionStatus | Should -Be 'On'
        $result.volumes[0].keyProtectorTypes | Should -Be @('RecoveryPassword', 'Tpm')
        $json | Should -Not -Match 'SIMULATED-KEY-MATERIAL'
        $json | Should -Not -Match '5820-9999'
        $result.keyMaterialExposed | Should -Be $false
    }
}
