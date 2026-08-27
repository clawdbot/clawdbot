// Owns config snapshots, include boundaries, and recovery for plugin installation.
import { readConfigFileSnapshotForWrite } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveInstallConfigMutationPreflights,
  selectInstallMutationWriteOptions,
  supportsInstallConfigSingleTopLevelIncludeShape,
  type ConfigMutationPreflight,
  type ConfigSnapshotForInstallPersist,
} from "../plugins/install-persistence.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { tracePluginLifecyclePhaseAsync } from "../plugins/plugin-lifecycle-trace.js";
import { resolveUserPath } from "../utils.js";
import {
  resolvePluginInstallInvalidConfigPolicy,
  type PluginInstallRequestContext,
} from "./plugin-install-config-policy.js";
import { listPersistedBundledPluginRecoveryLocations } from "./plugins-location-bridges.js";

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

function buildInvalidPluginInstallConfigError(message: string): Error {
  const error = new Error(message);
  (error as { code?: string }).code = "INVALID_CONFIG";
  return error;
}

function assertPluginConfigMutationAllowed(preflight: ConfigMutationPreflight): void {
  if (preflight.mode === "blocked") {
    throw buildInvalidPluginInstallConfigError(preflight.reason);
  }
}

function supportsPluginRecoveryIncludeShape(parsed: Record<string, unknown>): boolean {
  if (Object.hasOwn(parsed, "$include")) {
    return false;
  }
  return supportsInstallConfigSingleTopLevelIncludeShape(parsed.plugins);
}

function extractMissingPluginLoadPath(issue: { path?: string; message?: string }): string | null {
  if (issue.path !== "plugins.load.paths" || typeof issue.message !== "string") {
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
  issue: { path?: string; message?: string },
  ownedLoadPaths: ReadonlySet<string>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const missingPath = extractMissingPluginLoadPath(issue);
  return missingPath !== null && ownedLoadPaths.has(resolveUserPath(missingPath, env));
}

function isAllowedPluginRecoveryIssue(
  issue: { path?: string; message?: string },
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
    isOwnedMissingPluginLoadPathIssue(issue, ownedLoadPaths) ||
    (issue.path === `plugins.entries.${pluginId}` &&
      typeof issue.message === "string" &&
      issue.message.includes("requires compiled runtime output")) ||
    (issue.path === "tools.web.search.provider" &&
      typeof issue.message === "string" &&
      issue.message.includes(`plugin "${pluginId}"`))
  );
}

function collectRequestedPluginInstallPaths(
  cfg: OpenClawConfig,
  installRecords: Awaited<ReturnType<typeof loadInstalledPluginIndexInstallRecords>>,
  request: PluginInstallRequestContext,
  env: NodeJS.ProcessEnv,
): Set<string> {
  const pluginId = request.bundledPluginId?.trim();
  if (!pluginId) {
    return new Set();
  }
  const paths = new Set<string>();
  const record = installRecords[pluginId] ?? cfg.plugins?.installs?.[pluginId];
  for (const value of [record?.sourcePath, record?.installPath]) {
    if (typeof value === "string" && value.trim()) {
      paths.add(resolveUserPath(value, env));
    }
  }
  return paths;
}

async function collectRequestedPluginLocationBridgePaths(
  request: PluginInstallRequestContext,
  env: NodeJS.ProcessEnv,
): Promise<Set<string>> {
  const pluginId = request.bundledPluginId?.trim();
  if (!pluginId) {
    return new Set();
  }
  const locations = await listPersistedBundledPluginRecoveryLocations({ env });
  return new Set(
    locations
      .filter((location) => location.pluginId === pluginId)
      .flatMap((location) => location.loadPaths.map((loadPath) => resolveUserPath(loadPath, env))),
  );
}

function removeOwnedMissingPluginLoadPaths(
  cfg: OpenClawConfig,
  issues: readonly { path?: string; message?: string }[],
  ownedLoadPaths: ReadonlySet<string>,
  env: NodeJS.ProcessEnv,
): OpenClawConfig {
  const missingPaths = new Set<string>();
  for (const issue of issues) {
    const missingPath = extractMissingPluginLoadPath(issue);
    if (!missingPath) {
      continue;
    }
    const resolved = resolveUserPath(missingPath, env);
    if (ownedLoadPaths.has(resolved)) {
      missingPaths.add(resolved);
    }
  }
  const paths = cfg.plugins?.load?.paths;
  if (missingPaths.size === 0 || !Array.isArray(paths)) {
    return cfg;
  }
  const nextPaths = paths.filter(
    (entry) => typeof entry !== "string" || !missingPaths.has(resolveUserPath(entry, env)),
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

async function resolveRequestedPluginInstallPaths(
  cfg: OpenClawConfig,
  issues: readonly { path?: string; message?: string }[],
  request: PluginInstallRequestContext,
  env: NodeJS.ProcessEnv,
): Promise<Set<string>> {
  if (!issues.some((issue) => extractMissingPluginLoadPath(issue) !== null)) {
    return new Set();
  }
  const installRecords = await loadInstalledPluginIndexInstallRecords();
  const ownedLoadPaths = collectRequestedPluginInstallPaths(cfg, installRecords, request, env);
  const stillNeedsLocationBridge = issues.some(
    (issue) =>
      extractMissingPluginLoadPath(issue) !== null &&
      !isOwnedMissingPluginLoadPathIssue(issue, ownedLoadPaths, env),
  );
  if (stillNeedsLocationBridge) {
    // Registry ownership, not a matching requested id, authorizes repairing a removed path.
    for (const loadPath of await collectRequestedPluginLocationBridgePaths(request, env)) {
      ownedLoadPaths.add(loadPath);
    }
  }
  return ownedLoadPaths;
}

async function loadConfigFromSnapshotForInstall(
  request: PluginInstallRequestContext,
  prepared: Awaited<ReturnType<typeof readConfigFileSnapshotForWrite>>,
): Promise<ConfigSnapshotForInstallExecution> {
  const { snapshot, writeOptions } = prepared;
  const mutationWriteOptions = selectInstallMutationWriteOptions(writeOptions);
  if (resolvePluginInstallInvalidConfigPolicy(request) !== "allow-plugin-recovery") {
    throw buildInvalidPluginInstallConfigError(
      "Config invalid; run `openclaw doctor --fix` before installing plugins.",
    );
  }
  const parsed = (snapshot.parsed ?? {}) as Record<string, unknown>;
  if (!snapshot.exists || Object.keys(parsed).length === 0) {
    throw buildInvalidPluginInstallConfigError(
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
    throw buildInvalidPluginInstallConfigError(
      `Config invalid outside the plugin recovery path for ${pluginLabel}; run \`openclaw doctor --fix\` before reinstalling it.`,
    );
  }
  if (!supportsPluginRecoveryIncludeShape(parsed)) {
    throw buildInvalidPluginInstallConfigError(
      "Config plugin recovery uses an unsupported $include shape; use a single-file top-level plugins include or run `openclaw doctor --fix` before reinstalling it.",
    );
  }
  const { hookMutation, pluginMutation } = resolveInstallConfigMutationPreflights({
    parsed,
    snapshotPath: snapshot.path,
    writeOptions: mutationWriteOptions,
  });
  assertPluginConfigMutationAllowed(pluginMutation);
  return {
    config: removeOwnedMissingPluginLoadPaths(
      snapshot.config,
      snapshot.issues,
      ownedLoadPaths,
      process.env,
    ),
    baseHash: snapshot.hash,
    writeOptions: mutationWriteOptions,
    hookMutation,
    pluginMutation,
  };
}

/** Read and authorize install configuration only after mutation-free request preflight. */
export async function loadConfigForInstall(
  request: PluginInstallRequestContext,
): Promise<ConfigSnapshotForInstallExecution> {
  const prepared = await tracePluginLifecyclePhaseAsync(
    "config read",
    () => readConfigFileSnapshotForWrite(),
    { command: "install" },
  );
  const { snapshot, writeOptions } = prepared;
  const mutationWriteOptions = selectInstallMutationWriteOptions(writeOptions);
  if (!snapshot.valid) {
    return await loadConfigFromSnapshotForInstall(request, prepared);
  }
  const parsed = (snapshot.parsed ?? {}) as Record<string, unknown>;
  const { hookMutation, pluginMutation } = resolveInstallConfigMutationPreflights({
    parsed,
    snapshotPath: snapshot.path,
    writeOptions: mutationWriteOptions,
  });
  if (request.installKind === "plugin") {
    assertPluginConfigMutationAllowed(pluginMutation);
  }
  return {
    config: snapshot.sourceConfig,
    baseHash: snapshot.hash,
    writeOptions: mutationWriteOptions,
    hookMutation,
    pluginMutation,
  };
}
