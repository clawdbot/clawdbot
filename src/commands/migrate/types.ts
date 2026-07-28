/** Shared option types for the migrate command family. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MigrationPlan } from "../../plugins/types.js";

/** Embedded migration mode that returns config patch details instead of persisting them. */
type MigrationConfigPatchMode = "return";

/** Common options accepted by migrate list, plan, apply, and default flows. */
export type MigrateCommonOptions = {
  provider?: string;
  source?: string;
  includeSecrets?: boolean;
  authCredentials?: boolean;
  overwrite?: boolean;
  skills?: string[];
  plugins?: string[];
  verifyPluginApps?: boolean;
  json?: boolean;
  // Suppress the formatted plan dump that `migrate plan` normally prints
  // before any interactive selection. Used by onboarding flows that have
  // already secured user consent and do not want to re-render the plan.
  // The interactive selection picker and apply confirmation still run.
  suppressPlanLog?: boolean;
  // Internal embedded migration source of truth. Standalone CLI callers should
  // omit this so migration uses the current runtime config from disk.
  configOverride?: OpenClawConfig;
  // Internal embedded mode for config patch items. Default CLI behavior persists
  // patches when this is omitted; onboarding can request returned patch details.
  configPatchMode?: MigrationConfigPatchMode;
  // Internal embedded target. Standalone CLI migrations use the configured default agent.
  targetAgentId?: string;
  // Internal embedded scope. Providers may skip unrelated discovery when this is set.
  itemKinds?: string[];
  // Internal exact item selection used by reviewed UI migration plans.
  itemIds?: string[];
};

/** Options for migrate apply, including backup and preflight-plan controls. */
export type MigrateApplyOptions = MigrateCommonOptions & {
  yes?: boolean;
  noBackup?: boolean;
  force?: boolean;
  backupOutput?: string;
  preflightPlan?: MigrationPlan;
  // Internal RPC mode: return item-level failures with recovery metadata.
  allowPartialResult?: boolean;
};

/** Options for the default migrate command that can plan, dry-run, or apply. */
export type MigrateDefaultOptions = MigrateApplyOptions & {
  dryRun?: boolean;
};
