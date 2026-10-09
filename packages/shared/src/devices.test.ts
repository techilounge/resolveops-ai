import { describe, expect, it } from 'vitest';
import { summarizeInventory } from '@resolveops/domain/lib/inventory';
import type { Device } from '@resolveops/domain/types';
import {
  DeviceDtoSchema,
  DeviceListResponseSchema,
  InventorySummaryDtoSchema,
  type InventorySummaryDto,
} from './devices';

// Typed as the domain Device to prove the DTO accepts domain values as-is.
const validDevice: Device = {
  id: 'DEV-0001',
  hostname: 'LAB-W11-0001',
  os: 'Windows 11 Pro',
  compliance: 'compliant',
  encrypted: true,
  escrowed: true,
  lastSeen: '2026-10-09T08:30:00.000Z',
};

describe('DeviceDtoSchema', () => {
  it('parses a domain-shaped device unchanged', () => {
    expect(DeviceDtoSchema.parse(validDevice)).toEqual(validDevice);
  });

  it('rejects an invalid compliance state', () => {
    expect(() => DeviceDtoSchema.parse({ ...validDevice, compliance: 'probably-fine' })).toThrow();
  });
});

describe('InventorySummaryDtoSchema', () => {
  it('accepts summarizeInventory() output unchanged', () => {
    const second: Device = {
      ...validDevice,
      id: 'DEV-0002',
      hostname: 'LAB-W11-0002',
      compliance: 'unknown',
      encrypted: false,
    };
    // One-way structural check against the protected baseline function: it
    // exports no named type, so assignment is the mirror proof available.
    const summary: InventorySummaryDto = summarizeInventory([validDevice, second]);
    expect(summary).toEqual({ total: 2, noncompliant: 0, unknown: 1, unencrypted: 1, missingEscrow: 0 });
    expect(InventorySummaryDtoSchema.parse(summary)).toEqual(summary);
  });
});

describe('DeviceListResponseSchema', () => {
  it('parses a paginated envelope of devices', () => {
    const envelope = { data: [validDevice], page: { page: 1, pageSize: 25, total: 1 } };
    expect(DeviceListResponseSchema.parse(envelope)).toEqual(envelope);
  });
});
