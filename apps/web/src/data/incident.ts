import type { Device, Incident, Evidence } from '../types';
export const incident: Incident = { id: 'INC-2026-1047', title: 'BitLocker policy compliance drift', description: '47 simulated Windows endpoints are reporting encryption-policy drift after a hypothetical configuration change. Investigate with synthetic records only.', severity: 'high', status: 'open', createdAt: '2026-10-09T09:05:00-05:00', affectedDevices: 47, tags: ['BitLocker', 'Windows 11', 'Compliance'] };
export const devices: Device[] = Array.from({length: 47}, (_, i) => ({ id: `DEV-${String(i+1).padStart(3,'0')}`, hostname: `LAB-W11-${String(i+1).padStart(3,'0')}`, os: 'Windows 11', compliance: i % 7 === 0 ? 'unknown' : 'noncompliant', encrypted: i % 4 !== 0, escrowed: i % 6 !== 0, lastSeen: '2026-10-09T08:30:00-05:00' }));
export const evidence: Evidence[] = [
{ taskId: 'TASK-01', status: 'not-started' },
{ taskId: 'TASK-02', status: 'not-started' },
{ taskId: 'TASK-03', status: 'not-started' }
];
