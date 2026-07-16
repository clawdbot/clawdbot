import type fs from "node:fs";
import type JSON5 from "json5";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type {
  ConfigWriteAfterWrite,
  RuntimeConfigSnapshotRefreshOptions,
  RuntimeConfigWriteNotification,
} from "./runtime-snapshot.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

export type ParseConfigJson5Result = { ok: true; parsed: unknown } | { ok: false; error: string };

export type ConfigWriteResult = {
  persistedHash: string;
  persistedConfig: OpenClawConfig;
};

export const configWritePostCommitRollback = Symbol("configWritePostCommitRollback");

export type InternalConfigWriteResult = ConfigWriteResult & {
  [configWritePostCommitRollback]?: () => void;
};

export type ConfigWriteOptions = {
  /** Read-time env snapshot used to validate `${VAR}` restoration decisions. */
  envSnapshotForRestore?: Record<string, string | undefined>;
  /** Only use envSnapshotForRestore for the config path that produced it. */
  expectedConfigPath?: string;
  /** Internal write destination captured by readConfigFileSnapshotForWrite(). */
  ownedConfigPathForWrite?: string;
  /** Rechecks that the config path captured at mutation start is still active. */
  assertConfigPathForWrite?: () => void;
  /** Paths that must be removed from the persisted payload. */
  unsetPaths?: string[][];
  /** Caller-authored paths that stay persisted even when equal to defaults. */
  explicitSetPaths?: readonly (readonly string[])[];
  /** Source-shaped values paired with explicitSetPaths. */
  explicitSetValueSource?: OpenClawConfig;
  /** Fresh snapshot fast path for an immediate write. */
  baseSnapshot?: ConfigFileSnapshot;
  /** Plugin metadata paired with baseSnapshot. */
  basePluginMetadataSnapshot?: PluginMetadataSnapshot;
  /** Skip the runtime refresh tail when no runtime snapshot is active. */
  skipRuntimeSnapshotRefresh?: boolean;
  /** Controls for the active runtime snapshot refresh. */
  runtimeRefresh?: RuntimeConfigSnapshotRefreshOptions;
  /** Allow intentionally destructive full-config writes. */
  allowDestructiveWrite?: boolean;
  /** Allow an intentional size drop while retaining other destructive guards. */
  allowConfigSizeDrop?: boolean;
  /** Suppress human-readable overwrite and anomaly logs. */
  skipOutputLogs?: boolean;
  /** Runtime reload intent for committed-write observers. */
  afterWrite?: ConfigWriteAfterWrite;
  /** Doctor-only legacy root keys retained on disk but excluded from validation. */
  preservedLegacyRootKeys?: readonly string[];
  /** Skip plugin-aware validation for bounded repair migrations only. */
  skipPluginValidation?: boolean;
  /** Preserve an older writer version during update handoff writes. */
  lastTouchedVersionOverride?: string;
  /** Final async authority gate after runtime preflight and before commit. */
  preCommitRuntimePreflight?: (sourceConfig: OpenClawConfig) => Promise<unknown>;
  /** Snapshot-time hashes for include files that mutation writers may update. */
  includeFileHashesForWrite?: Record<string, string>;
  /** Snapshot-time canonical include targets that writers may update. */
  includeFileTargetsForWrite?: Record<string, string>;
};

export type ReadConfigFileSnapshotForWriteResult = {
  snapshot: ConfigFileSnapshot;
  writeOptions: ConfigWriteOptions;
};

export type ConfigWriteNotification = RuntimeConfigWriteNotification;
export type ConfigSnapshotReadMeasure = <T>(name: string, run: () => T | Promise<T>) => Promise<T>;

export class ConfigRuntimeRefreshError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigRuntimeRefreshError";
  }
}

export type ConfigIoDeps = {
  fs?: typeof fs;
  json5?: typeof JSON5;
  env?: NodeJS.ProcessEnv;
  lowerPrecedenceEnv?: Readonly<Record<string, string>>;
  homedir?: () => string;
  configPath?: string;
  logger?: Pick<typeof console, "error" | "warn">;
  measure?: ConfigSnapshotReadMeasure;
  suppressFutureVersionWarning?: boolean;
  observe?: boolean;
};

export type NormalizedConfigIoDeps = Required<ConfigIoDeps>;

export type ConfigIoFactoryOptions = ConfigIoDeps & {
  pluginValidation?: "full" | "skip";
  preservedLegacyRootKeys?: readonly string[];
  shellEnvFallback?: "load" | "defer";
};

export type ConfigSnapshotReadOptions = {
  measure?: ConfigSnapshotReadMeasure;
  observe?: boolean;
  isolateEnv?: boolean;
  lowerPrecedenceEnv?: Readonly<Record<string, string>>;
  recoverSuspicious?: boolean;
  allowSuspiciousRecovery?: (
    candidate: OpenClawConfig,
    current: OpenClawConfig,
  ) => boolean | Promise<boolean>;
  skipPluginValidation?: boolean;
  preservedLegacyRootKeys?: readonly string[];
  suppressFutureVersionWarning?: boolean;
};

export type ReadConfigFileSnapshotInternalResult = {
  snapshot: ConfigFileSnapshot;
  envSnapshotForRestore?: Record<string, string | undefined>;
  includeFileHashesForWrite?: Record<string, string>;
  includeFileTargetsForWrite?: Record<string, string>;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

export type ReadConfigFileSnapshotWithPluginMetadataResult = {
  snapshot: ConfigFileSnapshot;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

export type BestEffortConfigSnapshot = {
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
};

export type ShippedPluginInstallConfigWriteMigration = { migrated: false } | { migrated: true };

export type ShippedPluginInstallConfigReadMigration = {
  config: unknown;
  validationConfig?: unknown;
  persistedRootParsed?: unknown;
  persistedRootRaw?: string;
};
