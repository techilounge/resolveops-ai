import type { Device } from '../types';

// TASK-01 output contract — pinned in the Three-Agent Delivery Spec (art_Nfh8EVvp, Deliverable 1).
// TASK-03's buildRemediationProposal consumes IncidentAssessment, so this shape must not drift.

export type ConditionKind = 'unencrypted' | 'missingEscrow' | 'unknownStatus';

export interface DeviceConditionGroup {
  kind: ConditionKind;
  description: string; // what the condition means, technician-readable
  deviceIds: string[]; // sorted, deduplicated
  count: number;
}

export interface AssessmentRecommendation {
  id: string; // 'REC-01'…'REC-03'
  title: string;
  severity: 'high' | 'medium' | 'low';
  evidence: string[]; // references to counts/groups, e.g. '12/47 devices unencrypted'
  rationale: string; // investigation-oriented, never a device command
}

export interface IncidentAssessment {
  outcome: 'no-data' | 'complete';
  totals: {
    devices: number;
    impacted: number; // devices in >= 1 condition group
    unencrypted: number;
    missingEscrow: number;
    unknownStatus: number;
  };
  groups: DeviceConditionGroup[]; // condition-based; one device may appear in several groups
  impactedDeviceIds: string[]; // union across groups, sorted, unique
  recommendations: AssessmentRecommendation[]; // exactly 3 when outcome === 'complete'
  correlationNotice: string; // states these are correlations, not a proven cause
}

const CORRELATION_NOTICE_COMPLETE =
  'These findings are correlations observed in a single point-in-time snapshot of device state. ' +
  'They do not prove that any policy change caused the reported conditions; investigation is required to establish cause.';

const CORRELATION_NOTICE_NO_DATA =
  'No device data was provided, so no findings exist. Any future findings would be correlations from a device snapshot, not proven causes.';

// Severity rule (deterministic): encryption off is a direct data-protection exposure -> high when present.
// Escrow and visibility gaps are recoverability/verification risks -> medium when present. Absent -> low.
function severityFor(conditionCount: number, high: boolean): 'high' | 'medium' | 'low' {
  if (conditionCount === 0) return 'low';
  return high ? 'high' : 'medium';
}

function sortedIds(ids: string[]): string[] {
  return [...ids].sort();
}

export function assessIncident(devices: Device[]): IncidentAssessment {
  const unencrypted = sortedIds(devices.filter((d) => !d.encrypted).map((d) => d.id));
  const missingEscrow = sortedIds(devices.filter((d) => !d.escrowed).map((d) => d.id));
  const unknownStatus = sortedIds(devices.filter((d) => d.compliance === 'unknown').map((d) => d.id));

  if (devices.length === 0) {
    return {
      outcome: 'no-data',
      totals: { devices: 0, impacted: 0, unencrypted: 0, missingEscrow: 0, unknownStatus: 0 },
      groups: [],
      impactedDeviceIds: [],
      recommendations: [],
      correlationNotice: CORRELATION_NOTICE_NO_DATA,
    };
  }

  // Groups always cover all three known conditions when outcome is 'complete', so consumers can
  // rely on the shape; a zero-count group is possible for other inventories. The fixture, with
  // zero compliant devices, populates all three.
  const groups: DeviceConditionGroup[] = [
    {
      kind: 'unencrypted',
      description: 'Devices whose reported encryption state is off; volume protection is not confirmed.',
      deviceIds: unencrypted,
      count: unencrypted.length,
    },
    {
      kind: 'missingEscrow',
      description: 'Devices whose BitLocker recovery key is not confirmed present in escrow.',
      deviceIds: missingEscrow,
      count: missingEscrow.length,
    },
    {
      kind: 'unknownStatus',
      description: 'Devices whose compliance state is unknown; manual verification is required.',
      deviceIds: unknownStatus,
      count: unknownStatus.length,
    },
  ];

  const impacted = sortedIds([...new Set([...unencrypted, ...missingEscrow, ...unknownStatus])]);
  const dualExposure = devices.filter((d) => !d.encrypted && !d.escrowed).length;
  const total = devices.length;

  const recommendations: AssessmentRecommendation[] = [
    {
      id: 'REC-01',
      title: 'Investigate devices reporting encryption off',
      severity: severityFor(unencrypted.length, true),
      evidence: [
        `${unencrypted.length} of ${total} devices report encrypted=false`,
        ...(dualExposure > 0
          ? [`${dualExposure} of them also report missing recovery key escrow`]
          : []),
      ],
      rationale:
        'Data protection is unconfirmed on these devices, so exposure cannot be ruled out. ' +
        'Correlate the device list with the policy-change timeline and gather read-only diagnostics to confirm actual volume state before drawing conclusions.',
    },
    {
      id: 'REC-02',
      title: 'Verify recovery key escrow coverage',
      severity: severityFor(missingEscrow.length, false),
      evidence: [
        `${missingEscrow.length} of ${total} devices report missing recovery key escrow`,
        ...(dualExposure > 0
          ? [`${dualExposure} devices are both unencrypted and missing escrow, compounding recovery risk`]
          : []),
      ],
      rationale:
        'Devices without confirmed escrow may be unrecoverable after a lockout, but a snapshot alone does not show why. ' +
        'Identify which devices never escrowed keys and confirm backup coverage with the key-management process owners.',
    },
    {
      id: 'REC-03',
      title: 'Resolve unknown compliance states through manual verification',
      severity: severityFor(unknownStatus.length, false),
      evidence: [
        `${unknownStatus.length} of ${total} devices report unknown compliance state`,
        'Manual verification is required; no automated state is available for these devices',
      ],
      rationale:
        'Unknown status blocks any conclusion for these devices; they are neither confirmed compliant nor noncompliant. ' +
        'Schedule manual verification and read-only diagnostics rather than assuming either state.',
    },
  ];

  return {
    outcome: 'complete',
    totals: {
      devices: total,
      impacted: impacted.length,
      unencrypted: unencrypted.length,
      missingEscrow: missingEscrow.length,
      unknownStatus: unknownStatus.length,
    },
    groups,
    impactedDeviceIds: impacted,
    recommendations,
    correlationNotice: CORRELATION_NOTICE_COMPLETE,
  };
}
