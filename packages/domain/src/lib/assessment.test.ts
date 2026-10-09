import { describe, expect, it } from 'vitest';
import { devices } from '../data/incident';
import type { Device } from '../types';
import { assessIncident } from './assessment';
import type { IncidentAssessment } from './assessment';

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

// Audited fixture distribution (generator: i%7==0 -> unknown, i%4==0 -> unencrypted, i%6==0 -> missingEscrow).
const UNENCRYPTED_IDS = ['DEV-001', 'DEV-005', 'DEV-009', 'DEV-013', 'DEV-017', 'DEV-021', 'DEV-025', 'DEV-029', 'DEV-033', 'DEV-037', 'DEV-041', 'DEV-045'];
const MISSING_ESCROW_IDS = ['DEV-001', 'DEV-007', 'DEV-013', 'DEV-019', 'DEV-025', 'DEV-031', 'DEV-037', 'DEV-043'];
const UNKNOWN_IDS = ['DEV-001', 'DEV-008', 'DEV-015', 'DEV-022', 'DEV-029', 'DEV-036', 'DEV-043'];
const DUAL_IDS = ['DEV-001', 'DEV-013', 'DEV-025', 'DEV-037']; // i%12==0: unencrypted AND missing escrow
const IMPACTED_IDS = ['DEV-001', 'DEV-005', 'DEV-007', 'DEV-008', 'DEV-009', 'DEV-013', 'DEV-015', 'DEV-017', 'DEV-019', 'DEV-021', 'DEV-022', 'DEV-025', 'DEV-029', 'DEV-031', 'DEV-033', 'DEV-036', 'DEV-037', 'DEV-041', 'DEV-043', 'DEV-045'];

function allStrings(a: IncidentAssessment): string[] {
  return [
    a.correlationNotice,
    ...a.groups.map((g) => g.description),
    ...a.recommendations.flatMap((r) => [r.title, r.rationale, ...r.evidence]),
  ];
}

describe('assessIncident — 47-device fixture', () => {
  const a = assessIncident(devices);

  it('computes the audited totals', () => {
    expect(a.outcome).toBe('complete');
    expect(a.totals).toEqual({ devices: 47, impacted: 20, unencrypted: 12, missingEscrow: 8, unknownStatus: 7 });
  });

  it('populates all three condition groups with audited membership', () => {
    expect(a.groups.map((g) => g.kind)).toEqual(['unencrypted', 'missingEscrow', 'unknownStatus']);
    expect(a.groups.find((g) => g.kind === 'unencrypted')?.deviceIds).toEqual(UNENCRYPTED_IDS);
    expect(a.groups.find((g) => g.kind === 'missingEscrow')?.deviceIds).toEqual(MISSING_ESCROW_IDS);
    expect(a.groups.find((g) => g.kind === 'unknownStatus')?.deviceIds).toEqual(UNKNOWN_IDS);
    expect(a.groups.every((g) => g.count === g.deviceIds.length)).toBe(true);
  });

  it('counts overlapping devices in every applicable group', () => {
    const unencrypted = a.groups.find((g) => g.kind === 'unencrypted')!;
    const missingEscrow = a.groups.find((g) => g.kind === 'missingEscrow')!;
    const unknown = a.groups.find((g) => g.kind === 'unknownStatus')!;
    for (const id of DUAL_IDS) {
      expect(unencrypted.deviceIds).toContain(id);
      expect(missingEscrow.deviceIds).toContain(id);
    }
    for (const g of [unencrypted, missingEscrow, unknown]) expect(g.deviceIds).toContain('DEV-001');
  });

  it('builds a unique, sorted union of impacted devices', () => {
    expect(a.impactedDeviceIds).toEqual(IMPACTED_IDS);
    expect(new Set(a.impactedDeviceIds).size).toBe(a.impactedDeviceIds.length);
    expect(a.impactedDeviceIds).toEqual([...a.impactedDeviceIds].sort());
    for (const g of a.groups) for (const id of g.deviceIds) expect(a.impactedDeviceIds).toContain(id);
    expect(a.impactedDeviceIds.every((id) => a.groups.some((g) => g.deviceIds.includes(id)))).toBe(true);
  });

  it('provides exactly three evidence-backed recommendations with fixture severities', () => {
    expect(a.recommendations.map((r) => r.id)).toEqual(['REC-01', 'REC-02', 'REC-03']);
    expect(a.recommendations.every((r) => r.evidence.length > 0 && r.rationale.length > 0)).toBe(true);
    expect(a.recommendations.map((r) => r.severity)).toEqual(['high', 'medium', 'medium']);
  });

  it('states correlation without claiming cause', () => {
    expect(a.correlationNotice).toMatch(/correlation/i);
    expect(a.correlationNotice).toMatch(/do not prove/i);
  });

  it('keeps every output string investigation-oriented (no device commands)', () => {
    const denylist = /(manage-bde|set-bitlocker|repair-bde|invoke-|-executionpolicy|reg add|reg delete)/i;
    for (const s of allStrings(a)) expect(s).not.toMatch(denylist);
  });

  it('is deterministic and does not mutate its input', () => {
    const before = JSON.stringify(devices);
    expect(assessIncident(devices)).toEqual(a);
    expect(JSON.stringify(devices)).toBe(before);
  });
});

describe('assessIncident — empty input', () => {
  it('returns no-data with zeroed totals and empty collections', () => {
    const a = assessIncident([]);
    expect(a.outcome).toBe('no-data');
    expect(a.totals).toEqual({ devices: 0, impacted: 0, unencrypted: 0, missingEscrow: 0, unknownStatus: 0 });
    expect(a.groups).toEqual([]);
    expect(a.impactedDeviceIds).toEqual([]);
    expect(a.recommendations).toEqual([]);
  });
});

describe('assessIncident — constructed inventories', () => {
  it('reports zero impact and no high-severity recommendation for a compliant-only inventory', () => {
    const compliant = ['A', 'B', 'C'].map((s) => device({ id: `DEV-${s}` }));
    const a = assessIncident(compliant);
    expect(a.outcome).toBe('complete');
    expect(a.totals).toEqual({ devices: 3, impacted: 0, unencrypted: 0, missingEscrow: 0, unknownStatus: 0 });
    expect(a.impactedDeviceIds).toEqual([]);
    expect(a.groups.every((g) => g.count === 0 && g.deviceIds.length === 0)).toBe(true);
    expect(a.recommendations.some((r) => r.severity === 'high')).toBe(false);
  });

  it('never claims a device is impacted twice and treats absent conditions as low severity', () => {
    const mixed = [
      device({ id: 'DEV-A', encrypted: false }), // unencrypted only
      device({ id: 'DEV-B', escrowed: false }), // missing escrow only
      device({ id: 'DEV-C', encrypted: false, escrowed: false, compliance: 'unknown' }), // all three
    ];
    const a = assessIncident(mixed);
    expect(a.totals.impacted).toBe(3);
    expect(new Set(a.impactedDeviceIds).size).toBe(3);
    expect(a.groups.find((g) => g.kind === 'unencrypted')?.count).toBe(2);
    expect(a.groups.find((g) => g.kind === 'missingEscrow')?.count).toBe(2);
    expect(a.groups.find((g) => g.kind === 'unknownStatus')?.count).toBe(1);
    expect(a.recommendations.find((r) => r.id === 'REC-01')?.severity).toBe('high');
  });
});
