import type { Device } from '../types';
export function summarizeInventory(devices: Device[]) {
 return { total: devices.length, noncompliant: devices.filter(d => d.compliance === 'noncompliant').length, unknown: devices.filter(d => d.compliance === 'unknown').length, unencrypted: devices.filter(d => !d.encrypted).length, missingEscrow: devices.filter(d => !d.escrowed).length };
}
// TASK-01: implement assessIncident in its own module; do not change this baseline summary.
