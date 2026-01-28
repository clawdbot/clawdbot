export type { LegacyStateDetection } from "../infra/state-migrations.js";
export {
  autoMigrateLegacyStateDir,
  autoMigrateLegacyAgentDir,
  autoMigrateLegacyState,
  detectLegacyStateMigrations,
  migrateLegacyAgentDir,
  resetAutoMigrateLegacyStateDirForTest,
  resetAutoMigrateLegacyAgentDirForTest,
  resetAutoMigrateLegacyStateForTest,
  runLegacyStateMigrations,
} from "../infra/state-migrations.js";
