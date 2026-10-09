import { describe, expect, it } from 'vitest';
import { devices } from '../data/incident';
import type { Device } from '../types';
import { assessIncident } from './assessment';
import type { IncidentAssessment } from './assessment';
import { buildRemediationProposal, DRAFT_STATUS } from './proposal';
import type { RemediationProposalInput } from './proposal';

const CLOCK = '2026-10-09T18:00:00.000Z';
const PROPOSER = 'ResolveOps Agent 3';

function device(overrides: Partial<Device> & { id: string }): Device {
  return {
    hostname: `LAB-W11-${overrides.id}`,
    os: 'Windows 11',
    compliance: 'noncompliant',
    encrypted: true,
    escrowed: true,
    lastSeen: '2026-10-09T08:30:00-05:00',
    ...overrides,
  };
}

function input(
  assessment: IncidentAssessment,
  overrides: Partial<Omit<RemediationProposalInput, 'assessment'>> = {},
): RemediationProposalInput {
  return { assessment, proposedBy: PROPOSER, createdAtIso: CLOCK, ...overrides };
}

// Deep-collect every string in the output so the denylist scan covers all fields.
function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(collectStrings);
  return [];
}

// Pinned by the TASK-03 brief: tokens that must never appear in generated output.
const DENYLIST = ['manage-bde', 'set-bitlocker', 'repair-bde', 'reg ', 'invoke-', '-executionpolicy'];
// Shell-command shapes: a known command name used as a word, pipes, redirects,
// chaining, command substitution, or backticks.
const SHELL_LINE = /(^|\s)(manage-bde|repair-bde|reg|regedit|pwsh|powershell|cmd|wmic|diskpart)\b(\.exe)?\s/i;
const SHELL_PUNCTUATION = ['&&', '||', ' | ', ' > ', '$(', '`'];

const CASES: [string, IncidentAssessment][] = [
  ['fixture', assessIncident(devices)],
  ['no-data', assessIncident([])],
  ['clean inventory', assessIncident([device({ id: 'DEV-101' })])],
  ['unknown-only', assessIncident([device({ id: 'DEV-102', compliance: 'unknown' })])],
];

// One proposal per case, plus two mixed-condition inputs, all sharing the denylist scans.
const ALL_OUTPUTS = [
  ...CASES.map(([, assessment]) => buildRemediationProposal(input(assessment))),
  buildRemediationProposal(
    input(assessIncident([device({ id: 'DEV-203', encrypted: false, escrowed: false, compliance: 'unknown' })])),
  ),
  buildRemediationProposal(input(assessIncident([device({ id: 'DEV-204', encrypted: false })]))),
];

describe('buildRemediationProposal — draft and approval invariants', () => {
  it('labels every proposal with the literal draft status', () => {
    expect(DRAFT_STATUS).toBe('Draft — human approval required');
    for (const [name, assessment] of CASES) {
      expect(buildRemediationProposal(input(assessment)).status, name).toBe(DRAFT_STATUS);
    }
  });

  it('records approval as required with null approver and approvedAtIso fields everywhere', () => {
    for (const [name, assessment] of CASES) {
      const p = buildRemediationProposal(input(assessment));
      expect(p.approval.required, name).toBe(true);
      expect(p.approval.approver, name).toBeNull();
      expect(p.approval.approvedAtIso, name).toBeNull();
      // The field is named 'approver' — never an 'approvedBy' alias.
      expect(Object.keys(p.approval).sort(), name).toEqual(['approvedAtIso', 'approver', 'required']);
    }
  });
});

describe('buildRemediationProposal — content from the 47-device fixture', () => {
  const a = assessIncident(devices);
  const p = buildRemediationProposal(input(a));

  it('mirrors the assessment population and groups', () => {
    expect(p.impactedPopulation.totalDevices).toBe(47);
    expect(p.impactedPopulation.totalDevices).toBe(a.totals.devices);
    expect(p.impactedPopulation.groups).toEqual(a.groups);
  });

  it('summarizes the audited issue counts', () => {
    expect(p.issueSummary).toMatch(/47 devices/);
    expect(p.issueSummary).toMatch(/found 20 impacted/);
    expect(p.issueSummary).toMatch(/\b12 unencrypted/);
    expect(p.issueSummary).toMatch(/\b8 missing recovery key escrow/);
    expect(p.issueSummary).toMatch(/\b7 with unknown compliance state/);
  });

  it('produces one ordered investigation step per populated condition group', () => {
    expect(p.investigationSteps.map((s) => s.order)).toEqual([1, 2, 3]);
    expect(p.investigationSteps.every((s) => s.title.length > 0 && s.detail.length > 0)).toBe(true);
  });

  it('flags every investigation step for manual investigation', () => {
    expect(p.investigationSteps.every((s) => s.requiresManualInvestigation === true)).toBe(true);
  });

  it('carries the correlation notice and the draft warning', () => {
    expect(p.warnings).toContain(a.correlationNotice);
    expect(p.warnings.some((w) => w.includes('authorizes nothing'))).toBe(true);
  });

  it('flags the unknown-state population for manual investigation with no automated path', () => {
    expect(p.warnings.some((w) => /unknown compliance state/.test(w) && /no automated action path/.test(w))).toBe(true);
    expect(p.preconditions.some((s) => /unknownStatus group/.test(s))).toBe(true);
    expect(p.potentialImpact.some((s) => /unknown compliance state/.test(s))).toBe(true);
  });
});

describe('buildRemediationProposal — conditional content', () => {
  it('generates only the steps the populated groups need', () => {
    const a = assessIncident([device({ id: 'DEV-201', encrypted: false })]); // only unencrypted populated
    const p = buildRemediationProposal(input(a));
    expect(p.investigationSteps).toHaveLength(1);
    expect(p.investigationSteps[0].title).toMatch(/encryption state/i);
    expect(p.preconditions.some((s) => /unknownStatus/.test(s))).toBe(false);
    expect(p.warnings.some((w) => /no automated action path/.test(w))).toBe(false);
  });

  it('yields no steps and an explicit no-impact statement for a clean inventory', () => {
    const a = assessIncident([device({ id: 'DEV-202' })]);
    const p = buildRemediationProposal(input(a));
    expect(a.totals.impacted).toBe(0);
    expect(p.investigationSteps).toHaveLength(0);
    expect(p.potentialImpact).toEqual([
      'No adverse condition was found in the assessed population, so no remediation impact is expected.',
    ]);
    expect(p.status).toBe(DRAFT_STATUS);
    expect(p.approval).toEqual({ required: true, approver: null, approvedAtIso: null });
  });

  it('keeps a no-data proposal non-actionable: placeholder population, no device targets', () => {
    const p = buildRemediationProposal(input(assessIncident([])));
    expect(p.impactedPopulation.totalDevices).toBe(0);
    expect(p.impactedPopulation.groups).toEqual([]);
    expect(p.warnings.some((w) => /placeholder/i.test(w))).toBe(true);
    expect(p.potentialImpact.some((s) => /No impact can be determined/.test(s))).toBe(true);
    // No device id may be referenced anywhere: there is no population to act on.
    expect(collectStrings(p).some((s) => /DEV-\d+/.test(s))).toBe(false);
    // The only step is the human collect-inventory step.
    expect(p.investigationSteps).toHaveLength(1);
    expect(p.investigationSteps[0].requiresManualInvestigation).toBe(true);
  });
});

describe('buildRemediationProposal — no executable commands', () => {
  it('never contains a denylisted device-modifying token anywhere in the output', () => {
    for (const p of ALL_OUTPUTS) {
      const strings = collectStrings(p).map((s) => s.toLowerCase());
      const json = JSON.stringify(p).toLowerCase();
      for (const token of DENYLIST) {
        expect(strings.some((s) => s.includes(token)), `token '${token}'`).toBe(false);
        expect(json.includes(token), `token '${token}' in JSON`).toBe(false);
      }
    }
  });

  it('contains no shell command lines in investigation step details', () => {
    for (const p of ALL_OUTPUTS) {
      for (const step of p.investigationSteps) {
        expect(SHELL_LINE.test(step.detail), step.title).toBe(false);
        for (const punct of SHELL_PUNCTUATION) {
          expect(step.detail.includes(punct), `${step.title} contains '${punct}'`).toBe(false);
        }
      }
    }
  });

  it('contains no shell command shapes in any output string', () => {
    for (const p of ALL_OUTPUTS) {
      for (const s of collectStrings(p)) {
        expect(SHELL_LINE.test(s), s).toBe(false);
        for (const punct of SHELL_PUNCTUATION) {
          expect(s.includes(punct), `'${s}' contains '${punct}'`).toBe(false);
        }
      }
    }
  });
});

describe('buildRemediationProposal — determinism and purity', () => {
  const a = assessIncident(devices);

  it('returns identical output for identical input', () => {
    const p1 = buildRemediationProposal(input(a));
    const p2 = buildRemediationProposal(input(a));
    expect(p2).toEqual(p1);
    expect(JSON.stringify(p2)).toBe(JSON.stringify(p1));
  });

  it('changes only the injected clock when createdAtIso differs', () => {
    const p1 = buildRemediationProposal(input(a));
    const p2 = buildRemediationProposal(input(a, { createdAtIso: '2026-10-10T09:30:00.000Z' }));
    expect(p2.createdAtIso).toBe('2026-10-10T09:30:00.000Z');
    expect({ ...p2, createdAtIso: p1.createdAtIso }).toEqual(p1);
  });

  it('changes only the attribution when proposedBy differs', () => {
    const p1 = buildRemediationProposal(input(a));
    const p2 = buildRemediationProposal(input(a, { proposedBy: 'Other Agent' }));
    expect(p2.proposedBy).toBe('Other Agent');
    expect({ ...p2, proposedBy: p1.proposedBy }).toEqual(p1);
  });

  it('does not mutate its input assessment', () => {
    const snapshot = JSON.stringify(a);
    buildRemediationProposal(input(a));
    expect(JSON.stringify(a)).toBe(snapshot);
  });
});
