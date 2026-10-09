import type { ConditionKind, DeviceConditionGroup, IncidentAssessment } from './assessment';

// TASK-03 — proposal-only remediation. Nothing in this module may emit an
// executable device command: every string below is investigation/preparation
// guidance for a human reviewer, and the tests in proposal.test.ts enforce a
// denylist scan over the entire output.
//
// The literal draft status and the null approval fields are invariants, not
// states: no code path in this repository can produce an approved proposal.

export const DRAFT_STATUS = 'Draft — human approval required' as const;

export interface RemediationProposalInput {
  assessment: IncidentAssessment;
  proposedBy: string; // agent attribution, e.g. 'ResolveOps Agent 3'
  createdAtIso: string; // injected clock — no hidden Date.now()
}

export interface RemediationStep {
  order: number;
  title: string;
  detail: string; // investigation/preparation guidance only, never a command line
  requiresManualInvestigation: boolean; // true for every step: all work here is human work, which also satisfies the unknownStatus requirement
}

export interface RemediationApproval {
  required: true;
  approver: string | null; // set only by a human process outside this repository — never auto-filled
  approvedAtIso: string | null; // same; always null in generated output
}

export interface RemediationProposal {
  status: typeof DRAFT_STATUS; // literal, always
  issueSummary: string;
  impactedPopulation: { totalDevices: number; groups: DeviceConditionGroup[] };
  investigationSteps: RemediationStep[];
  preconditions: string[];
  potentialImpact: string[];
  validationPlan: string[];
  rollbackAndEscalation: string[];
  approval: RemediationApproval;
  warnings: string[];
  // Provenance passthrough from the input contract: who drafted this proposal and
  // when (the injected clock), so output stays fully deterministic.
  proposedBy: string;
  createdAtIso: string;
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

// Per-condition investigation guidance. Static strings per condition keep the
// output deterministic; counts live in the summary, impact, and warnings sections.
const STEP_GUIDANCE: Record<ConditionKind, { title: string; detail: string }> = {
  unencrypted: {
    title: 'Verify reported encryption state on unencrypted devices',
    detail:
      'For every device in the unencrypted group, confirm with the device owner whether the volume is actually protected. ' +
      'Compare the assessment snapshot with a fresh read-only diagnostic collected during an approved change window, ' +
      'and record the observed state per device before any conclusion is drawn.',
  },
  missingEscrow: {
    title: 'Confirm recovery key escrow coverage',
    detail:
      'For every device in the missingEscrow group, ask the key-management process owners whether a recovery key is present in escrow. ' +
      'Record only presence or absence; never generate, export, or disclose key material during verification.',
  },
  unknownStatus: {
    title: 'Investigate devices with unknown compliance state manually',
    detail:
      'Every device in the unknownStatus group must be examined by a person, because no automated verification path exists for an unknown state. ' +
      'Collect a read-only diagnostic per device, record what it reports, and keep the device treated as unverified until a human confirms its state.',
  },
};

function stepsFromGroups(groups: DeviceConditionGroup[]): RemediationStep[] {
  return groups
    .filter((g) => g.deviceIds.length > 0)
    .map((g, index) => {
      const guidance = STEP_GUIDANCE[g.kind];
      return { order: index + 1, ...guidance, requiresManualInvestigation: true };
    });
}

const NO_DATA_STEP: RemediationStep = {
  order: 1,
  title: 'Collect a device inventory and regenerate the assessment',
  detail:
    'This proposal was generated without device data. Produce a read-only inventory, generate an assessment from it, ' +
    'and rebuild this proposal before asking a human to review it. Do not treat this draft as evidence about any device.',
  requiresManualInvestigation: true,
};

export function buildRemediationProposal(input: RemediationProposalInput): RemediationProposal {
  const { assessment, proposedBy, createdAtIso } = input;
  const { devices, impacted, unencrypted, missingEscrow, unknownStatus } = assessment.totals;
  const noData = assessment.outcome === 'no-data';
  const hasUnknown = unknownStatus > 0;

  // Deep-copy the group list so the proposal owns its data and the input is never aliased.
  const groups = assessment.groups.map((g) => ({ ...g, deviceIds: [...g.deviceIds] }));

  const issueSummary = noData
    ? 'No device data was provided, so there is no impact to summarize. This proposal is a placeholder and must be regenerated from a real assessment before a human reviews it.'
    : `Assessment of ${devices} ${plural(devices, 'device')} found ${impacted} impacted by at least one condition: ` +
      `${unencrypted} unencrypted, ${missingEscrow} missing recovery key escrow, and ${unknownStatus} with unknown compliance state. ` +
      'The underlying assessment reports correlations from a single snapshot, not proven causes.';

  const investigationSteps = noData ? [NO_DATA_STEP] : stepsFromGroups(groups);

  const preconditions: string[] = [
    'A named human approver has reviewed this proposal and their approval (identity and time) is recorded before any activity beyond read-only verification.',
    'Any diagnostic collection happens during an approved change window and uses read-only tooling only.',
  ];
  if (hasUnknown) {
    preconditions.push(
      `The compliance state of every device in the unknownStatus group (${unknownStatus} ${plural(unknownStatus, 'device')}) has been confirmed by a person.`,
    );
  }
  if (missingEscrow > 0) {
    preconditions.push(
      'Escrow coverage for every device in the missingEscrow group has been confirmed with the key-management process owners.',
    );
  }
  if (noData) {
    preconditions.push(
      'A read-only device inventory has been collected and an assessment has been generated from it before this proposal is reviewed.',
    );
  }

  const potentialImpact: string[] = [];
  if (unencrypted > 0) {
    potentialImpact.push(
      `Devices that remain unencrypted (${unencrypted} in the assessment) have unconfirmed volume protection; data on them is exposed if a device is lost, stolen, or tampered with.`,
    );
  }
  if (missingEscrow > 0) {
    potentialImpact.push(
      `Devices without confirmed recovery key escrow (${missingEscrow} in the assessment) may be unrecoverable after a lockout.`,
    );
  }
  if (hasUnknown) {
    potentialImpact.push(
      `Devices with unknown compliance state (${unknownStatus} in the assessment) could be misread as safe or unsafe; acting on them without manual verification would act on unknown information.`,
    );
  }
  if (noData) {
    potentialImpact.push(
      'No impact can be determined without device data; this placeholder proposal must not be used to justify any action.',
    );
  } else if (impacted === 0) {
    potentialImpact.push('No adverse condition was found in the assessed population, so no remediation impact is expected.');
  }

  const validationPlan: string[] = [];
  if (noData) {
    validationPlan.push('Once a real inventory exists, regenerate the assessment and this proposal, then validate against the new data.');
  } else if (impacted === 0) {
    validationPlan.push(
      'Confirm with the incident owner that the clean result matches expectations and record that no further verification is required.',
    );
  } else {
    validationPlan.push(
      'Re-run the read-only assessment and the read-only diagnostic toolkit against the impacted population and compare every result with the original snapshot.',
    );
    if (missingEscrow > 0) {
      validationPlan.push('For each device flagged for escrow, record the escrow status confirmed by the key-management process owners.');
    }
    if (hasUnknown) {
      validationPlan.push('For each device with unknown compliance state, record the human-verified state and the evidence source.');
    }
    validationPlan.push(
      'Attach the collected evidence to the incident record and obtain written sign-off from the incident owner before closing the investigation.',
    );
  }

  const rollbackAndEscalation: string[] = [
    'This proposal performs no device change, so there is nothing to roll back from it; if any manual step was started, stop and preserve the read-only evidence already collected.',
    'Escalate to the incident owner immediately if any verification result disagrees with the assessment snapshot.',
    'Escalate to the security team if verification reveals evidence of unauthorized access, key disclosure, or data exfiltration.',
  ];
  if (hasUnknown) {
    rollbackAndEscalation.push(
      'Do not improvise changes for unknown-state devices; treat every surprise as an escalation trigger and wait for a human decision.',
    );
  }

  const warnings: string[] = [
    'Draft status: this proposal authorizes nothing; device action requires a recorded human approval that does not exist yet.',
  ];
  if (hasUnknown) {
    warnings.push(
      `${unknownStatus} ${plural(unknownStatus, 'device')} ${unknownStatus === 1 ? 'has' : 'have'} unknown compliance state; manual investigation is required and no automated action path exists for them.`,
    );
  }
  if (noData) {
    warnings.push('Generated without device data: this proposal is a placeholder and is not evidence about any device.');
  }
  warnings.push(assessment.correlationNotice);

  return {
    status: DRAFT_STATUS,
    issueSummary,
    impactedPopulation: { totalDevices: devices, groups },
    investigationSteps,
    preconditions,
    potentialImpact,
    validationPlan,
    rollbackAndEscalation,
    approval: { required: true, approver: null, approvedAtIso: null },
    warnings,
    proposedBy,
    createdAtIso,
  };
}
