import { z } from 'zod';

// Typed API error taxonomy — Blueprint §11: "400/401/403/404/409/429/5xx
// errors". One stable wire envelope; codes map to HTTP statuses. Contracts
// only: nothing here reads requests or produces responses.
export const API_ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);

// Wire envelope for every error response: { error: { code, message, ... } }.
export const ApiErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string().min(1),
    // Correlation id, attached by the API edge once request tracing exists.
    requestId: z.string().min(1).optional(),
    // Structured, non-sensitive context (e.g. which field failed validation).
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

// Single source of truth for code → HTTP status. INTERNAL covers the 5xx
// family at 500; more specific 5xx codes may be added later without changing
// the envelope.
export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export function apiErrorStatus(code: ApiErrorCode): number {
  return API_ERROR_STATUS[code];
}
