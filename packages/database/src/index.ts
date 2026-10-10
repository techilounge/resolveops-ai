// @resolveops/database — schema and migration layer (Phase 1 Blueprint §4.1).
// Numbered plain-SQL migrations under migrations/, a checksummed runner,
// least-privilege roles, and FORCE row-level security on every tenant-owned
// table. The API derives tenant context only from server-side sessions and
// sets it per transaction via `SET LOCAL app.org_id` (§4.2).
export {
  MIGRATIONS_DIR,
  MigrationChecksumError,
  type MigrationFile,
  type RunMigrationsOptions,
  type RunMigrationsResult,
  computeChecksum,
  createPool,
  loadMigrationFiles,
  orderMigrations,
  runMigrations,
} from './run';
