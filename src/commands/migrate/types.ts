import type { MigrationPlan } from "../../plugins/types.js";

export type MigrateCommonOptions = {
  provider?: string;
  source?: string;
  includeSecrets?: boolean;
  overwrite?: boolean;
  skills?: string[];
  json?: boolean;
};

export type MigrateApplyOptions = MigrateCommonOptions & {
  yes?: boolean;
  noBackup?: boolean;
  force?: boolean;
  backupOutput?: string;
  preflightPlan?: MigrationPlan;
};

export type MigrateDefaultOptions = MigrateApplyOptions & {
  dryRun?: boolean;
};
