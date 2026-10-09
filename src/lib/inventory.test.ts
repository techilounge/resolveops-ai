import { describe, expect, it } from 'vitest';
import { devices, incident } from '../data/incident';
import { summarizeInventory } from './inventory';
describe('safe starter fixtures', () => {
 it('contains exactly 47 synthetic devices', () => { expect(devices).toHaveLength(47); expect(incident.affectedDevices).toBe(devices.length); });
 it('uses non-production hostnames', () => { expect(devices.every(d => d.hostname.startsWith('LAB-W11-'))).toBe(true); });
 it('summarizes inventory consistently', () => { const s = summarizeInventory(devices); expect(s.total).toBe(47); expect(s.noncompliant+s.unknown).toBe(47); expect(s.unencrypted).toBeGreaterThan(0); });
});
