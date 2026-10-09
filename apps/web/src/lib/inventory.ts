// Compatibility re-export (PROD-003): the pure chain moved to
// @resolveops/domain. src/main.tsx is content-frozen and keeps importing
// this relative path, so it resolves through this shim.
export * from '@resolveops/domain/lib/inventory';
