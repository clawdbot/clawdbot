// Owns config snapshots, include boundaries, and recovery for plugin installation.
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { readConfigFileSnapshotForWrite } from "../config/config.js";
import type {
  ConfigFileSnapshot,
  ConfigValidationIssue,
  OpenClawConfig,
} from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";
import {
  resolveInstallConfigMutationPreflights,
  selectInstallMutationWriteOptions,
  supportsInstallConfigSingleTopLevelIncludeShape,
  type ConfigMutationPreflight,
  type ConfigSnapshotForInstallPersist,
} from "./install-persistence.js";
import {
  resolvePluginInstallInvalidConfigPolicy,
  type PluginInstallRequestContext,
} from "./install-request-context.js";
import { loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import { listPersistedBundledPluginRecoveryLocations } from "./location-bridges.js";
import { tracePluginLifecyclePhaseAsync } from "./plugin-lifecycle-trace.js";

export type ConfigSnapshotForInstallExecution = ConfigSnapshotForInstallPersist & {
  hookMutation: ConfigMutationPreflight;
  pluginMutation: ConfigMutationPreflight;
};

export function resolveFullyBlockedConfigMutationReason(
  snapshot: ConfigSnapshotForInstallExecution,
): string | null {
  if (snapshot.pluginMutation.mode !== "blocked" || snapshot.hookMutation.mode !== "blocked") {
    return null;
  }
  if (snapshot.pluginMutation.reason === snapshot.hookMutation.reason) {
    return snapshot.pluginMutation.reason;
  }
  return `Config plugin and hook mutations are both blocked. ${snapshot.pluginMutation.reason} ${snapshot.hookMutation.reason}`;
}

export class PluginInstallConfigError extends Error {
  readonly code = "INVALID_CONFIG";
  readonly #blockedSnapshot?: ConfigSnapshotForInstallExecution;

  constructor(message: string, blockedSnapshot?: ConfigSnapshotForInstallExecution) {
    super(message);
    this.#blockedSnapshot = blockedSnapshot;
  }

  get blockedSnapshot(): ConfigSnapshotForInstallExecution | undefined {
    return this.#blockedSnapshot;
  }
}

function extractMissingPluginLoadPath(issue: ConfigValidationIssue): string | null {
  if (issue.path !== "plugins.load.paths") {
    return null;
  }
  const marker = "plugin path not found:";
  const markerIndex = issue.message.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  const value = issue.message.slice(markerIndex + marker.length).trim();
  return value || null;
}

function isOwnedMissingPluginLoadPathIssue(
  issue: ConfigValidationIssue,
  ownedLoadPaths: ReadonlySet<string>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const missingPath = extractMissingPluginLoadPath(issue);
  return missingPath !== null && ownedLoadPaths.has(resolveUserPath(missingPath, env));
}

function isAllowedPluginRecoveryIssue(
  issue: ConfigValidationIssue,
  request: PluginInstallRequestContext,
  ownedLoadPaths: ReadonlySet<string>,
): boolean {
  const pluginId = request.bundledPluginId?.trim();
  if (!pluginId) {
    return false;
  }
  return (
    (issue.path === `channels.${pluginId}` &&
      issue.message === `unknown channel id: ${pluginId}`) ||
    // The outgoing schema must not block its replacement. The validator names
    // the schema owner; a plugin may own a channel whose id differs from its own.
    (issue.path.startsWith("channels.") &&
      issue.message.startsWith(`invalid config for plugin ${pluginId}:`)) ||
    isOwnedMissingPluginLoadPathIssue(issue, ownedLoadPaths) ||
    (issue.path === `plugins.entries.${pluginId}` &&
      issue.message.includes("requires compiled runtime output")) ||
    (issue.path === "tools.web.search.provider" && issue.message.includes(`plugin "${pluginId}"`))
  );
}

async function resolveRequestedPluginInstallPaths(
  cfg: OpenClawConfig,
  issues: readonly ConfigValidationIssue[],
  request: PluginInstallRequestContext,
  env: NodeJS.ProcessEnv,
): Promise<Set<string>> {
  const pluginId = request.bundledPluginId?.trim();
  if (!pluginId || !issues.some((issue) => extractMissingPluginLoadPath(issue) !== null)) {
    return new Set();
  }
  const installRecords = await loadInstalledPluginIndexInstallRecords();
  const record = installRecords[pluginId] ?? cfg.plugins?.installs?.[pluginId];
  const ownedLoadPaths = new Set<string>();
  for (const value of [record?.sourcePath, record?.installPath]) {
    if (typeof value === "string" && value.trim()) {
      ownedLoadPaths.add(resolveUserPath(value, env));
    }
  }
  const stillNeedsLocationBridge = issues.some(
    (issue) =>
      extractMissingPluginLoadPath(issue) !== null &&
      !isOwnedMissingPluginLoadPathIssue(issue, ownedLoadPaths, env),
  );
  if (stillNeedsLocationBridge) {
    // Registry ownership, not a matching requested id, authorizes repairing a removed path.
    const locations = await listPersistedBundledPluginRecoveryLocations({ env });
    const loadPaths = locations
      .filter((location) => location.pluginId === pluginId)
      .flatMap((location) => location.loadPaths);
    for (const loadPath of loadPaths) {
      ownedLoadPaths.add(resolveUserPath(loadPath, env));
    }
  }
  return ownedLoadPaths;
}

async function recoverPluginInstallConfig(
  request: PluginInstallRequestContext,
  snapshot: ConfigFileSnapshot,
): Promise<OpenClawConfig> {
  if (resolvePluginInstallInvalidConfigPolicy(request) !== "allow-plugin-recovery") {
    throw new PluginInstallConfigError(
      "Config invalid; run `openclaw doctor --fix` before installing plugins.",
    );
  }
  const parsed = asNonArrayRecord(snapshot.parsed);
  if (!snapshot.exists || Object.keys(parsed).length === 0) {
    throw new PluginInstallConfigError(
      "Config file could not be parsed; run `openclaw doctor` to repair it.",
    );
  }
  const ownedLoadPaths = await resolveRequestedPluginInstallPaths(
    snapshot.config,
    snapshot.issues,
    request,
    process.env,
  );
  if (
    snapshot.legacyIssues.length > 0 ||
    snapshot.issues.length === 0 ||
    snapshot.issues.some((issue) => !isAllowedPluginRecoveryIssue(issue, request, ownedLoadPaths))
  ) {
    const pluginLabel = request.bundledPluginId ?? "the requested plugin";
    throw new PluginInstallConfigError(
      `Config invalid outside the plugin recovery path for ${pluginLabel}; run \`openclaw doctor --fix\` before reinstalling it.`,
    );
  }
  if (
    Object.hasOwn(parsed, "$include") ||
    !supportsInstallConfigSingleTopLevelIncludeShape(parsed.plugins)
  ) {
    throw new PluginInstallConfigError(
      "Config plugin recovery uses an unsupported $include shape; use a single-file top-level plugins include or run `openclaw doctor --fix` before reinstalling it.",
    );
  }
  const missingPaths = new Set<string>();
  for (const issue of snapshot.issues) {
    const missingPath = extractMissingPluginLoadPath(issue);
    if (!missingPath) {
      continue;
    }
    const resolved = resolveUserPath(missingPath, process.env);
    if (ownedLoadPaths.has(resolved)) {
      missingPaths.add(resolved);
    }
  }
  const cfg = snapshot.config;
  const paths = cfg.plugins?.load?.paths;
  if (missingPaths.size === 0 || !Array.isArray(paths)) {
    return cfg;
  }
  const nextPaths = paths.filter(
    (entry) => typeof entry !== "string" || !missingPaths.has(resolveUserPath(entry, process.env)),
  );
  if (nextPaths.length === paths.length) {
    return cfg;
  }
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      load: {
        ...cfg.plugins?.load,
        paths: nextPaths,
      },
    },
  };
}

/** Read mutation ownership; only an explicit install request can authorize plugin recovery. */
export async function loadConfigForInstall(
  request?: PluginInstallRequestContext,
): Promise<ConfigSnapshotForInstallExecution> {
  const prepared = await tracePluginLifecyclePhaseAsync(
    "config read",
    () => readConfigFileSnapshotForWrite(),
    { command: "install" },
  );
  const { snapshot, writeOptions } = prepared;
  const mutationWriteOptions = selectInstallMutationWriteOptions(writeOptions);
  let config: OpenClawConfig = snapshot.sourceConfig;
  if (!snapshot.valid) {
    if (!request) {
      throw new PluginInstallConfigError(
        "Config invalid; run `openclaw doctor --fix` before managing plugins.",
      );
    }
    config = await recoverPluginInstallConfig(request, snapshot);
  }
  const parsed = asNonArrayRecord(snapshot.parsed);
  const { hookMutation, pluginMutation } = resolveInstallConfigMutationPreflights({
    parsed,
    snapshotPath: snapshot.path,
    writeOptions: mutationWriteOptions,
  });
  const result = {
    config,
    baseHash: snapshot.hash,
    writeOptions: mutationWriteOptions,
    hookMutation,
    pluginMutation,
  };
  if (
    pluginMutation.mode === "blocked" &&
    (!snapshot.valid || !request || request.installKind === "plugin")
  ) {
    // A valid snapshot can authorize a separate hook-only inspection, never a
    // plugin write or invalid-config recovery. Keep config out of error serialization.
    throw new PluginInstallConfigError(pluginMutation.reason, snapshot.valid ? result : undefined);
  }
  return result;
}
