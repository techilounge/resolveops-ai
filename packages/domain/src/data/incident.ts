// Compatibility re-export (PROD-003): the synthetic demo dataset stays
// app-level at apps/web/src/data/incident.ts, but the content-frozen domain
// tests import ../data/incident from packages/domain/src/lib/, so they
// resolve through this shim to the @resolveops/web source export.
export * from '@resolveops/web/data/incident';
