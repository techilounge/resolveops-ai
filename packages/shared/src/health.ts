import { z } from 'zod';

// GET /healthz — liveness contract (PROD-004). Service status only: no
// customer data, no tenant context, no configuration or environment surface.
export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string().min(1),
  version: z.string().min(1),
  timestamp: z.string().datetime(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
