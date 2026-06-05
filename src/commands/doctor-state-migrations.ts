/** Re-exports legacy state migration helpers used by doctor preflight. */
export type { LegacyStateDetection } from "../infra/state-migrations.js";
export {
  autoMigrateLegacyStateDir,
  autoMigrateLegacyTaskStateSidecars,
  autoMigrateLegacyAgentDir,
  autoMigrateLegacyState,
  detectLegacyStateMigrations,
  migrateLegacyAgentDir,
  resetAutoMigrateLegacyStateDirForTest,
  resetAutoMigrateLegacyTaskStateSidecarsForTest,
  resetAutoMigrateLegacyAgentDirForTest,
  resetAutoMigrateLegacyStateForTest,
  runLegacyStateMigrations,
} from "../infra/state-migrations.js";
