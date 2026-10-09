<#
.SYNOPSIS
    Read-only BitLocker volume diagnostic reporter for ResolveOps AI (TASK-02).

.DESCRIPTION
    Reports BitLocker encryption/protection state as a single structured JSON
    document without modifying anything.

    Two modes:

      Fixture mode (-InputFixturePath):
        Loads a synthetic JSON fixture and never calls a single OS cmdlet.
        Runs on any OS that has PowerShell 7 - including Linux CI sandboxes.

      Live mode (no -InputFixturePath):
        Reads Get-Volume / Get-BitLocker state on a WINDOWS TEST MACHINE.
        Read-only: never suspends protection, never decrypts, never deletes
        protectors, never exports keys, never invokes manage-bde, and never
        requests elevation (there is deliberately no
        '#Requires -RunAsAdministrator' here).

    SAFETY ENVELOPE (repo AGENTS.md):
      - Diagnostics are read-only; no state-changing cmdlet is called.
      - Only key-protector TYPES are reported. Key material, recovery
        passwords, and key IDs are never copied into the output object, and
        'keyMaterialExposed' is structurally always false.
      - Never run against production systems.

.PARAMETER InputFixturePath
    Path to a synthetic JSON fixture. When supplied, the script runs in
    fixture mode and makes no OS cmdlet calls.

.PARAMETER MachineLabel
    Overrides the machine label in the report (both modes).

.PARAMETER GeneratedAtUtc
    Injected clock for deterministic output in tests. Defaults to the
    current UTC time.

.EXAMPLE
    ./scripts/Get-BitLockerDiagnostic.ps1 -InputFixturePath scripts/fixtures/lab-w11-sample.json

.EXAMPLE
    # Windows test machine only:
    ./scripts/Get-BitLockerDiagnostic.ps1
#>

[CmdletBinding()]
param(
    [string] $InputFixturePath,
    [string] $MachineLabel,
    [datetime] $GeneratedAtUtc
)

# ---------------------------------------------------------------------------
# Error construction
# ---------------------------------------------------------------------------

function New-DiagnosticError {
    param(
        [Parameter(Mandatory)] [string] $Code,
        [Parameter(Mandatory)] [string] $Message,
        [string] $Detail = ''
    )
    [pscustomobject] [ordered] @{
        code    = $Code
        message = $Message
        detail  = $Detail
    }
}

function Get-DiagnosticErrorCodeFromException {
    # Maps a caught PowerShell error to a stable error code for the report.
    # CommandNotFound -> the diagnostic cmdlet does not exist on this host;
    # access/authorization failures get their own code so technicians can
    # tell "wrong machine" from "unexpected problem".
    param(
        [Parameter(Mandatory)] [System.Management.Automation.ErrorRecord] $ErrorRecord
    )

    $ex = $ErrorRecord.Exception
    if ($ex -is [System.Management.Automation.CommandNotFoundException]) {
        return 'CMDLET_UNAVAILABLE'
    }
    if ($ex -is [System.UnauthorizedAccessException] -or $ex -is [System.Security.SecurityException]) {
        return 'ACCESS_DENIED'
    }
    if ($ErrorRecord.ToString() -match 'Access is denied|UnauthorizedAccess|0x80070005') {
        return 'ACCESS_DENIED'
    }
    if ($ErrorRecord.ToString() -match 'Cannot find|not found|No BitLocker volume') {
        return 'VOLUME_MISSING'
    }
    return 'UNEXPECTED_ERROR'
}

# ---------------------------------------------------------------------------
# Value normalization (fixture and live paths share this)
# ---------------------------------------------------------------------------

$script:KNOWN_ENCRYPTION_STATUSES = @('FullyEncrypted', 'FullyDecrypted', 'Encrypted')
$script:KNOWN_PROTECTION_STATUSES = @('On', 'Off')
# Canonical BitLocker key-protector TYPES. Anything outside this list is
# dropped with a warning so a hostile or corrupt fixture can never smuggle a
# string (e.g. a recovery password) into the report disguised as a type.
$script:KNOWN_KEY_PROTECTOR_TYPES = @(
    'Tpm', 'ExternalKey', 'NumericalPassword', 'TpmAndPin',
    'TpmAndStartupKey', 'TpmAndPinAndStartupKey', 'PublicKey', 'RecoveryPassword'
)

function ConvertTo-NormalizedEncryptionStatus {
    param([string] $Value)
    $known = $script:KNOWN_ENCRYPTION_STATUSES | Where-Object { $_ -ieq $Value } | Select-Object -First 1
    if ($known) { $known } else { 'Unknown' }
}

function ConvertTo-NormalizedProtectionStatus {
    param([string] $Value)
    $known = $script:KNOWN_PROTECTION_STATUSES | Where-Object { $_ -ieq $Value } | Select-Object -First 1
    if ($known) { $known } else { 'Unknown' }
}

function ConvertTo-NormalizedKeyProtectorTypes {
    # Keep only known key-protector TYPES; drop anything else with a warning.
    param(
        [AllowNull()] $Values,
        # Not [Parameter(Mandatory)]: mandatory parameters reject EMPTY
        # collections in PowerShell, and an empty warnings list is the normal
        # starting state.
        [System.Collections.Generic.List[string]] $Warnings,
        [Parameter(Mandatory)] [string] $VolumeLabel
    )
    $result = [System.Collections.Generic.List[string]]::new()
    $dropped = 0
    foreach ($value in @($Values)) {
        if ([string]::IsNullOrWhiteSpace([string] $value)) { continue }
        $known = $script:KNOWN_KEY_PROTECTOR_TYPES | Where-Object { $_ -ieq [string] $value } | Select-Object -First 1
        if ($known) {
            if (-not ($result | Where-Object { $_ -ieq $known })) { $result.Add($known) | Out-Null }
        }
        else {
            # The unrecognized value is deliberately NOT echoed here: a hostile
            # or corrupt source can smuggle key material into any string field,
            # and repeating it in a warning would leak it into the report.
            $dropped++
        }
    }
    if ($dropped -gt 0) {
        $Warnings.Add("Volume $VolumeLabel`: dropped $dropped unrecognized key-protector type entry. Raw value(s) withheld - only known key-protector TYPES are reported, never key material.") | Out-Null
    }
    return @($result | Sort-Object)
}

# ---------------------------------------------------------------------------
# Fixture mode
# ---------------------------------------------------------------------------

function Read-DiagnosticFixture {
    # Returns a pscustomobject { MachineLabel, Volumes } or $null when the
    # fixture could not be used (in which case an error was recorded).
    param(
        [Parameter(Mandatory)] [string] $Path,
        # Not [Parameter(Mandatory)]: mandatory parameters reject EMPTY
        # collections in PowerShell, and an empty warnings/errors list is the
        # normal starting state.
        [System.Collections.Generic.List[string]] $Warnings,
        [System.Collections.Generic.List[object]] $Errors
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        $Errors.Add((New-DiagnosticError -Code 'FIXTURE_NOT_FOUND' -Message "Fixture file not found: '$Path'." -Detail 'Fixture mode reads only the file you provide; nothing on this system was contacted.')) | Out-Null
        return $null
    }

    try {
        $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
        $parsed = $raw | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        $Errors.Add((New-DiagnosticError -Code 'FIXTURE_INVALID' -Message "Fixture file '$Path' is not valid JSON." -Detail $_.Exception.Message)) | Out-Null
        return $null
    }

    if ($null -eq $parsed -or -not $parsed.PSObject.Properties['volumes']) {
        $Errors.Add((New-DiagnosticError -Code 'FIXTURE_INVALID' -Message "Fixture file '$Path' must be a JSON object with a 'volumes' array." -Detail "Root JSON type found: $($parsed.GetType().Name).")) | Out-Null
        return $null
    }

    # Optional machineLabel / warnings passthrough from the fixture.
    $label = 'fixture'
    if ($parsed.PSObject.Properties['machineLabel'] -and -not [string]::IsNullOrWhiteSpace([string] $parsed.machineLabel)) {
        $label = [string] $parsed.machineLabel
    }
    if ($parsed.PSObject.Properties['warnings']) {
        foreach ($warning in @($parsed.warnings)) {
            if (-not [string]::IsNullOrWhiteSpace([string] $warning)) {
                $Warnings.Add([string] $warning) | Out-Null
            }
        }
    }

    $volumes = [System.Collections.Generic.List[object]]::new()
    $index = -1
    foreach ($entry in @($parsed.volumes)) {
        $index++

        if ($null -eq $entry -or -not $entry.PSObject.Properties['driveLetter'] -or [string]::IsNullOrWhiteSpace([string] $entry.driveLetter)) {
            $Errors.Add((New-DiagnosticError -Code 'FIXTURE_INVALID' -Message "Fixture volume at index $index has no 'driveLetter'." -Detail 'Every volume entry requires a non-empty driveLetter string.')) | Out-Null
            continue
        }

        $driveLetter = ([string] $entry.driveLetter).Trim().TrimEnd(':')

        $volumeName = ''
        if ($entry.PSObject.Properties['volumeName']) { $volumeName = [string] $entry.volumeName }

        $encryptionStatus = 'Unknown'
        if ($entry.PSObject.Properties['encryptionStatus']) {
            $rawEncryption = [string] $entry.encryptionStatus
            $encryptionStatus = ConvertTo-NormalizedEncryptionStatus -Value $rawEncryption
            if ($encryptionStatus -eq 'Unknown' -and -not [string]::IsNullOrWhiteSpace($rawEncryption)) {
                # Raw value withheld - never echo unrecognized strings, which
                # could carry key material.
                $Warnings.Add("Volume $driveLetter`: unrecognized encryptionStatus value (withheld); reported as 'Unknown'.") | Out-Null
            }
        }

        $protectionStatus = 'Unknown'
        if ($entry.PSObject.Properties['protectionStatus']) {
            $rawProtection = [string] $entry.protectionStatus
            $protectionStatus = ConvertTo-NormalizedProtectionStatus -Value $rawProtection
            if ($protectionStatus -eq 'Unknown' -and -not [string]::IsNullOrWhiteSpace($rawProtection)) {
                $Warnings.Add("Volume $driveLetter`: unrecognized protectionStatus value (withheld); reported as 'Unknown'.") | Out-Null
            }
        }

        $keyProtectorTypes = @()
        if ($entry.PSObject.Properties['keyProtectorTypes']) {
            $keyProtectorTypes = ConvertTo-NormalizedKeyProtectorTypes -Values $entry.keyProtectorTypes -Warnings $Warnings -VolumeLabel $driveLetter
        }

        # Field selection is the key-material guard: only these five fields
        # are ever copied from the fixture. Any other property (e.g. a rogue
        # 'recoveryPassword' field) is ignored by construction.
        $volumes.Add([pscustomobject] [ordered] @{
            driveLetter       = $driveLetter
            volumeName        = $volumeName
            encryptionStatus  = $encryptionStatus
            protectionStatus  = $protectionStatus
            # @() forces array semantics: without it, PowerShell unrolls a
            # single-element list to a scalar and an empty list to $null,
            # which would serialize as a string / null instead of an array.
            keyProtectorTypes = @($keyProtectorTypes)
        }) | Out-Null
    }

    if ($volumes.Count -eq 0 -and $Errors.Count -eq 0) {
        $Warnings.Add('Fixture contains no volumes.') | Out-Null
    }

    [pscustomobject] @{
        MachineLabel = $label
        Volumes      = @($volumes)
    }
}

# ---------------------------------------------------------------------------
# Live mode (Windows test machines only)
# ---------------------------------------------------------------------------

function Get-LiveDiagnostic {
    # Reads live BitLocker/volume state. Read-only: Get-Volume and
    # Get-BitLocker report state; nothing here changes it.
    param(
        # Same empty-collection rule as Read-DiagnosticFixture.
        [System.Collections.Generic.List[string]] $Warnings,
        [System.Collections.Generic.List[object]] $Errors
    )

    $volumes = [System.Collections.Generic.List[object]]::new()
    $rawVolumes = $null

    try {
        $rawVolumes = @(Get-Volume -ErrorAction Stop)
    }
    catch {
        $code = Get-DiagnosticErrorCodeFromException -ErrorRecord $_
        $Errors.Add((New-DiagnosticError -Code $code -Message "Could not enumerate volumes with 'Get-Volume'. Live mode requires a Windows test machine with the Storage module." -Detail $_.Exception.Message)) | Out-Null
        return @($volumes)
    }

    $letteredVolumes = @($rawVolumes | Where-Object { $_.DriveLetter })
    if ($letteredVolumes.Count -eq 0) {
        $Errors.Add((New-DiagnosticError -Code 'VOLUME_MISSING' -Message 'No mounted volumes with drive letters were found on this machine.' -Detail 'Get-Volume returned no drive-letter volumes.')) | Out-Null
        return @($volumes)
    }

    foreach ($volume in $letteredVolumes) {
        $mountPoint = "$($volume.DriveLetter):"
        try {
            # Get-BitLocker objects carry key material in properties we never
            # reference. Field selection below copies TYPES only.
            $bitLocker = Get-BitLocker -MountPoint $mountPoint -ErrorAction Stop

            $keyProtectorTypes = ConvertTo-NormalizedKeyProtectorTypes `
                -Values @($bitLocker.KeyProtectors | ForEach-Object { $_.KeyProtectorType }) `
                -Warnings $Warnings -VolumeLabel $volume.DriveLetter

            $volumes.Add([pscustomobject] [ordered] @{
                driveLetter       = [string] $volume.DriveLetter
                volumeName        = [string] $volume.FileSystemLabel
                encryptionStatus  = ConvertTo-NormalizedEncryptionStatus -Value ([string] $bitLocker.VolumeStatus)
                protectionStatus  = ConvertTo-NormalizedProtectionStatus -Value ([string] $bitLocker.ProtectionStatus)
                # @() forces array semantics - see the fixture-mode twin below.
                keyProtectorTypes = @($keyProtectorTypes)
            }) | Out-Null
        }
        catch {
            $code = Get-DiagnosticErrorCodeFromException -ErrorRecord $_
            $Errors.Add((New-DiagnosticError -Code $code -Message "Could not read BitLocker state for volume '$mountPoint'." -Detail $_.Exception.Message)) | Out-Null
        }
    }

    @($volumes)
}

# ---------------------------------------------------------------------------
# Public entry point and serialization
# ---------------------------------------------------------------------------

function Invoke-BitLockerDiagnostic {
    [CmdletBinding()]
    param(
        [string] $InputFixturePath,
        [string] $MachineLabel,
        [datetime] $GeneratedAtUtc
    )

    $warnings = [System.Collections.Generic.List[string]]::new()
    $errors = [System.Collections.Generic.List[object]]::new()
    $volumes = @()
    $source = 'live'
    # NOTE: PowerShell variable names are case-insensitive, so this must not
    # be named $machineLabel - that would collide with the $MachineLabel
    # parameter and clobber the override before it is applied.
    $resolvedMachineLabel = $null

    if ($PSBoundParameters.ContainsKey('InputFixturePath')) {
        # Fixture mode: zero OS cmdlet calls, guaranteed by construction and
        # asserted by the guard test in Get-BitLockerDiagnostic.Tests.ps1.
        $source = 'fixture'
        $fixture = Read-DiagnosticFixture -Path $InputFixturePath -Warnings $warnings -Errors $errors
        if ($null -ne $fixture) {
            $resolvedMachineLabel = $fixture.MachineLabel
            $volumes = $fixture.Volumes
        }
        $warnings.Add('Fixture mode: synthetic data only - no live system was contacted.') | Out-Null
    }
    else {
        $volumes = Get-LiveDiagnostic -Warnings $warnings -Errors $errors
        $resolvedMachineLabel = [System.Environment]::MachineName
        if ([string]::IsNullOrWhiteSpace($resolvedMachineLabel)) { $resolvedMachineLabel = 'unknown' }
    }

    if ($PSBoundParameters.ContainsKey('MachineLabel') -and -not [string]::IsNullOrWhiteSpace($MachineLabel)) {
        $resolvedMachineLabel = $MachineLabel
    }

    $timestamp = $null
    if ($PSBoundParameters.ContainsKey('GeneratedAtUtc')) {
        $timestamp = $GeneratedAtUtc.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
    }
    else {
        $timestamp = [System.DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
    }

    [pscustomobject] [ordered] @{
        schemaVersion      = '1.0'
        source             = $source
        machineLabel       = $resolvedMachineLabel
        generatedAtUtc    = $timestamp
        volumes            = @($volumes)
        warnings           = @($warnings)
        errors             = @($errors)
        # Structural invariant, not a measurement: this script never reads
        # key material, so this field is always false.
        keyMaterialExposed = $false
    }
}

function ConvertTo-DiagnosticJson {
    param(
        [Parameter(Mandatory)] [pscustomobject] $Result
    )
    ConvertTo-Json -InputObject $Result -Depth 8
}

# ---------------------------------------------------------------------------
# Main - runs only when executed as a script, never when dot-sourced for
# testing (Pester dot-sources this file to load the functions above).
# ---------------------------------------------------------------------------

if ($MyInvocation.InvocationName -ne '.') {
    $result = Invoke-BitLockerDiagnostic @PSBoundParameters
    Write-Output (ConvertTo-DiagnosticJson -Result $result)
    if (@($result.errors).Count -gt 0) {
        exit 1
    }
    exit 0
}
