export type { LegacyStateDetection } from "../infra/state-migrations.js";
export {
  autoMigrateLegacyStateDir,
  autoMigrateLegacyAgentDir,
  autoMigrateLegacyState,
  detectLegacyStateMigrations,
  formatStateDirConflictMessage,
  migrateLegacyAgentDir,
  resetAutoMigrateLegacyStateDirForTest,
  resetAutoMigrateLegacyAgentDirForTest,
  resetAutoMigrateLegacyStateForTest,
  runLegacyStateMigrations,
  StateDirConflictError,
} from "../infra/state-migrations.js";
