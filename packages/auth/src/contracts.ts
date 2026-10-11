import { z } from 'zod';

/**
 * Response contracts for the Phase 1 auth surface. The shared package owns
 * the API-wide envelope; these are the auth-specific bodies (kept here so
 * P1-4 can own additions to packages/shared without coordination).
 */

export const CsrfTokenResponseSchema = z.object({
  csrfToken: z.string().min(1),
});
export type CsrfTokenResponse = z.infer<typeof CsrfTokenResponseSchema>;

/** Query the OIDC callback route accepts (error unless state+code present). */
export const AuthCallbackQuerySchema = z
  .object({
    state: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
  })
  .refine((query) => (query.code !== undefined && query.state !== undefined) || query.error !== undefined, {
    message: 'callback requires state and code',
  });

export const AuthErrorSchema = z.object({
  error: z.string().min(1),
  error_description: z.string().optional(),
});
