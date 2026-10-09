// Compatibility re-export (PROD-003): the domain types moved to
// @resolveops/domain. apps/web/src/data/incident.ts is content-frozen and
// keeps importing this relative path, so it resolves through this shim.
export * from '@resolveops/domain/types';
