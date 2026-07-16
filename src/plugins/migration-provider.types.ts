import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginLogger } from "./logger-types.js";
import type { PluginRuntime } from "./runtime/types.js";

export type PluginConfigMigration = (config: OpenClawConfig) =>
  | {
      config: OpenClawConfig;
      changes: string[];
    }
  | null
  | undefined;

export type MigrationItemStatus =
  | "planned"
  | "migrated"
  | "skipped"
  | "warning"
  | "conflict"
  | "error";
export type MigrationItemKind =
  | "auth"
  | "config"
  | "secret"
  | "memory"
  | "skill"
  | "workspace"
  | "session"
  | "file"
  | "archive"
  | "manual";
export type MigrationItemAction =
  | "copy"
  | "create"
  | "update"
  | "merge"
  | "append"
  | "archive"
  | "skip"
  | "manual";

export type MigrationItem = {
  id: string;
  kind: MigrationItemKind | (string & {});
  action: MigrationItemAction | (string & {});
  status: MigrationItemStatus;
  source?: string;
  target?: string;
  message?: string;
  reason?: string;
  sensitive?: boolean;
  /** Core-owned source revision bound by reviewed embedded migration flows. */
  sourceRevision?: { algorithm: "sha256"; digest: string };
  details?: Record<string, unknown>;
};

export type MigrationSummary = {
  total: number;
  planned: number;
  migrated: number;
  skipped: number;
  conflicts: number;
  errors: number;
  sensitive: number;
};

export type MigrationDetection = {
  found: boolean;
  source?: string;
  label?: string;
  confidence?: "low" | "medium" | "high";
  message?: string;
};

export type MigrationPlan = {
  providerId: string;
  source: string;
  target?: string;
  summary: MigrationSummary;
  items: MigrationItem[];
  warnings?: string[];
  nextSteps?: string[];
  metadata?: Record<string, unknown>;
};

export type MigrationApplyResult = MigrationPlan & {
  backupPath?: string;
  reportDir?: string;
};

export type MigrationProviderPreparation = {
  dispose?: () => void | Promise<void>;
};

export type MigrationProviderContext = {
  config: OpenClawConfig;
  runtime?: PluginRuntime;
  logger: PluginLogger;
  stateDir: string;
  /** Explicit destination agent for embedded migration surfaces such as Control UI. */
  targetAgentId?: string;
  /** Optional item-kind scope used by embedded migration surfaces to avoid unrelated discovery. */
  itemKinds?: readonly string[];
  source?: string;
  includeSecrets?: boolean;
  overwrite?: boolean;
  providerOptions?: Record<string, unknown>;
  backupPath?: string;
  reportDir?: string;
  signal?: AbortSignal;
};

/** Migration source implemented by a plugin and orchestrated by `openclaw migrate`. */
export type MigrationProviderPlugin = {
  id: string;
  label: string;
  description?: string;
  /** Item kinds this provider can expose without requiring a full plan. */
  supportedItemKinds?: readonly string[];
  detect?: (ctx: MigrationProviderContext) => MigrationDetection | Promise<MigrationDetection>;
  prepareApply?: (
    ctx: MigrationProviderContext,
  ) => MigrationProviderPreparation | Promise<MigrationProviderPreparation | undefined> | undefined;
  plan: (ctx: MigrationProviderContext) => MigrationPlan | Promise<MigrationPlan>;
  apply: (
    ctx: MigrationProviderContext,
    plan?: MigrationPlan,
  ) => MigrationApplyResult | Promise<MigrationApplyResult>;
};

export type PluginSetupAutoEnableContext = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
};

export type PluginSetupAutoEnableProbe = (
  ctx: PluginSetupAutoEnableContext,
) => string | string[] | null | undefined;
