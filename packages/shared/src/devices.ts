import { z } from 'zod';
import type { Device } from '@resolveops/domain/types';
import { MirrorWith } from './mirror';
import { PaginatedResponseSchema } from './pagination';

// Device DTO — mirrored from the domain Device contract (no duplication).
export const DeviceDtoSchema = z.object({
  id: z.string().min(1),
  hostname: z.string().min(1),
  os: z.string().min(1),
  compliance: z.enum(['noncompliant', 'compliant', 'unknown']),
  encrypted: z.boolean(),
  escrowed: z.boolean(),
  lastSeen: z.string().datetime(),
});
export type DeviceDto = z.infer<typeof DeviceDtoSchema>;

// GET /api/v1/devices — paginated scoped search (Blueprint §11). The routes
// stay reserved (route-map.ts); the wire shape is defined here because the
// brief includes inventory DTOs in the first contract set.
export const DeviceListResponseSchema = PaginatedResponseSchema(DeviceDtoSchema);
export type DeviceListResponse = z.infer<typeof DeviceListResponseSchema>;

// Inventory summary view — mirrors summarizeInventory() in
// @resolveops/domain. That baseline file is protected and exports no named
// type, so the mirror is enforced by test assignment (devices.test.ts)
// instead of a compile-time assertion.
export const InventorySummaryDtoSchema = z.object({
  total: z.number().int().min(0),
  noncompliant: z.number().int().min(0),
  unknown: z.number().int().min(0),
  unencrypted: z.number().int().min(0),
  missingEscrow: z.number().int().min(0),
});
export type InventorySummaryDto = z.infer<typeof InventorySummaryDtoSchema>;

// Compile-time mirror check: the DTO must stay mutually assignable with the
// domain contract. If domain types drift, this line stops compiling.
const _deviceMirrorsDomain: MirrorWith<DeviceDto, Device> = true;
