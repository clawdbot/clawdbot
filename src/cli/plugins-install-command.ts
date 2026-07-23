// Plugin install command implementation for bundled, npm, path, git, ClawHub, and hook packs.
import fs from "node:fs";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshotForWrite,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  installHooksFromNpmSpec,
  installHooksFromPath,
  type InstallHooksResult,
} from "../hooks/install.js";
import { resolveArchiveKind } from "../infra/archive.js";
import { parseClawHubPluginSpec, reportClawHubPluginInstallTelemetry } from "../infra/clawhub.js";
import { formatErrorMessage } from "../infra/errors.js";
import { installBundledPluginSource } from "../plugins/bundled-install.js";
import { findBundledPluginSource } from "../plugins/bundled-sources.js";
import { buildClawHubPluginInstallRecordFields } from "../plugins/clawhub-install-records.js";
import { CLAWHUB_INSTALL_ERROR_CODE, installPluginFromClawHub } from "../plugins/clawhub.js";
import { installPluginFromGitSpec, parseGitPluginSpec } from "../plugins/git-install.js";
import { resolveDefaultPluginExtensionsDir } from "../plugins/install-paths.js";
import {
  persistPluginInstall,
  resolveInstallConfigMutationPreflights,
  selectInstallMutationWriteOptions,
  supportsInstallConfigSingleTopLevelIncludeShape,
  type ConfigMutationPreflight,
  type ConfigSnapshotForInstallPersist,
} from "../plugins/install-persistence.js";
import { resolveOpenClawTrustedNpmPackageInstall } from "../plugins/install-provenance.js";
import type { InstallSafetyOverrides } from "../plugins/install-security-scan.js";
import {
  PLUGIN_INSTALL_ERROR_CODE,
  installPluginFromNpmPackArchive,
  installPluginFromNpmSpec,
  installPluginFromPath,
} from "../plugins/install.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import {
  installPluginFromMarketplace,
  resolveMarketplaceInstallShortcut,
} from "../plugins/marketplace.js";
import { resolveCatalogOfficialExternalInstallPlan } from "../plugins/official-external-install-trust.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { tracePluginLifecyclePhaseAsync } from "../plugins/plugin-lifecycle-trace.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { markClawPackageIndependentlyOwned } from "../state/claw-package-adoption.js";
import { withClawPackageLifecycleLease } from "../state/claw-package-lifecycle-lease.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { resolveClawHubRiskAcknowledgementCliOptions } from "./clawhub-risk-acknowledgement.js";
import { formatCliCommand } from "./command-format.js";
import { persistHookPackInstall } from "./hook-install-persistence.js";
import { looksLikeLocalInstallSpec } from "./install-spec.js";
import {
  confirmNonClawHubInstall,
  NON_CLAWHUB_INSTALL_FORCE_FLAG,
  type NonClawHubInstallSourceClass,
} from "./non-clawhub-install-acknowledgement.js";
import { resolvePinnedNpmInstallRecordForCli } from "./npm-resolution.js";
import {
  resolvePluginInstallInvalidConfigPolicy,
  resolvePluginInstallRequestContext,
  type PluginInstallRequestContext,
} from "./plugin-install-config-policy.js";
import {
  resolveBundledInstallPlanBeforeNpm,
  resolveBundledInstallPlanForNpmFailure,
} from "./plugin-install-plan.js";
import {
  createHookPackInstallLogger,
  createPluginInstallLogger,
  formatPluginInstallWithHookFallbackError,
  parseNpmPackPrefixPath,
  parseNpmPrefixSpec,
} from "./plugins-command-helpers.js";
import { listPersistedBundledPluginRecoveryLocations } from "./plugins-location-bridges.js";

type ConfigSnapshotForInstallExecution = ConfigSnapshotForInstallPersist & {
  hookMutation: ConfigMutationPreflight;
  pluginMutation: ConfigMutationPreflight;
};

function isClawHubBlockedCliFailure(result: { code?: string; warning?: string }): boolean {
  return (
    result.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED &&
    typeof result.warning === "string" &&
    result.warning.trim().length > 0
  );
}

function resolveInstallMode(force?: boolean): "install" | "update" {
  return force ? "update" : "install";
}

function resolveInstallSafetyOverrides(overrides: InstallSafetyOverrides): InstallSafetyOverrides {
  return {
    config: overrides.config,
    dangerouslyForceUnsafeInstall: overrides.dangerouslyForceUnsafeInstall,
    trustedSourceLinkedOfficialInstall: overrides.trustedSourceLinkedOfficialInstall,
  };
}

async function probeHookPackFromNpmSpec(
  params: Parameters<typeof installHooksFromNpmSpec>[0],
): Promise<InstallHooksResult> {
  try {
    return await installHooksFromNpmSpec(params);
  } catch (error) {
    return { ok: false, error: formatErrorMessage(error) };
  }
}

async function probeHookPackFromPath(
  params: Parameters<typeof installHooksFromPath>[0],
): Promise<InstallHooksResult> {
  try {
    return await installHooksFromPath(params);
  } catch (error) {
    return { ok: false, error: formatErrorMessage(error) };
  }
}

const DEPRECATED_DANGEROUS_FORCE_UNSAFE_INSTALL_WARNING =
  "--dangerously-force-unsafe-install is deprecated and no longer affects plugin installs because built-in install-time dangerous-code scanning has been removed. Configure security.installPolicy for operator-owned install decisions.";

function supportsPluginRecoveryIncludeShape(parsed: Record<string, unknown>): boolean {
  if (Object.hasOwn(parsed, "$include")) {
    return false;
  }
  return supportsInstallConfigSingleTopLevelIncludeShape(parsed.plugins);
}

function resolveFullyBlockedConfigMutationReason(
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

function assertPluginConfigMutationAllowed(preflight: ConfigMutationPreflight): void {
  if (preflight.mode === "blocked") {
    throw buildInvalidPluginInstallConfigError(preflight.reason);
  }
}

async function tryInstallHookPackFromLocalPath(params: {
  snapshot: ConfigSnapshotForInstallExecution;
  resolvedPath: string;
  installMode: "install" | "update";
  safetyOverrides?: InstallSafetyOverrides;
  link?: boolean;
  expectedPackageKind?: "hook-only";
  runtime?: RuntimeEnv;
}): Promise<{ ok: true } | Extract<InstallHooksResult, { ok: false }>> {
  if (params.snapshot.hookMutation.mode === "blocked") {
    return { ok: false, error: params.snapshot.hookMutation.reason };
  }
  if (params.link) {
    const stat = fs.statSync(params.resolvedPath);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        error: "Linked hook pack paths must be directories.",
      };
    }

    const probe = await installHooksFromPath({
      ...resolveInstallSafetyOverrides(params.safetyOverrides ?? {}),
      path: params.resolvedPath,
      dryRun: true,
      ...(params.expectedPackageKind ? { expectedPackageKind: params.expectedPackageKind } : {}),
    });
    if (!probe.ok) {
      return probe;
    }

    const existing = params.snapshot.config.hooks?.internal?.load?.extraDirs ?? [];
    const merged = uniqueStrings([...existing, params.resolvedPath]);
    await persistHookPackInstall({
      snapshot: {
        ...params.snapshot,
        config: {
          ...params.snapshot.config,
          hooks: {
            ...params.snapshot.config.hooks,
            internal: {
              ...params.snapshot.config.hooks?.internal,
              enabled: true,
              load: {
                ...params.snapshot.config.hooks?.internal?.load,
                extraDirs: merged,
              },
            },
          },
        },
      },
      hookPackId: probe.hookPackId,
      hooks: probe.hooks,
      install: {
        source: "path",
        sourcePath: params.resolvedPath,
        installPath: params.resolvedPath,
        version: probe.version,
      },
      successMessage: `Linked hook pack path: ${shortenHomePath(params.resolvedPath)}`,
      runtime: params.runtime,
    });
    return { ok: true };
  }

  const result = await installHooksFromPath({
    ...resolveInstallSafetyOverrides(params.safetyOverrides ?? {}),
    path: params.resolvedPath,
    mode: params.installMode,
    ...(params.expectedPackageKind ? { expectedPackageKind: params.expectedPackageKind } : {}),
    logger: createHookPackInstallLogger(params.runtime),
  });
  if (!result.ok) {
    return result;
  }

  const source: "archive" | "path" = resolveArchiveKind(params.resolvedPath) ? "archive" : "path";
  await persistHookPackInstall({
    snapshot: params.snapshot,
    hookPackId: result.hookPackId,
    hooks: result.hooks,
    install: {
      source,
      sourcePath: params.resolvedPath,
      installPath: result.targetDir,
      version: result.version,
    },
    runtime: params.runtime,
  });
  return { ok: true };
}

async function tryInstallHookPackFromNpmSpec(params: {
  snapshot: ConfigSnapshotForInstallExecution;
  installMode: "install" | "update";
  spec: string;
  pin?: boolean;
  expectedIntegrity?: string;
  expectedPackageKind?: "hook-only";
  runtime?: RuntimeEnv;
}): Promise<{ ok: true } | Extract<InstallHooksResult, { ok: false }>> {
  if (params.snapshot.hookMutation.mode === "blocked") {
    return { ok: false, error: params.snapshot.hookMutation.reason };
  }
  const result = await installHooksFromNpmSpec({
    config: params.snapshot.config,
    spec: params.spec,
    mode: params.installMode,
    ...(params.expectedIntegrity ? { expectedIntegrity: params.expectedIntegrity } : {}),
    ...(params.expectedPackageKind ? { expectedPackageKind: params.expectedPackageKind } : {}),
    logger: createHookPackInstallLogger(params.runtime),
  });
  if (!result.ok) {
    return result;
  }

  const installRecord = resolvePinnedNpmInstallRecordForCli(
    params.spec,
    Boolean(params.pin),
    result.targetDir,
    result.version,
    result.npmResolution,
    params.runtime?.log ?? defaultRuntime.log,
    theme.warn,
  );
  await persistHookPackInstall({
    snapshot: params.snapshot,
    hookPackId: result.hookPackId,
    hooks: result.hooks,
    install: installRecord,
    runtime: params.runtime,
  });
  return { ok: true };
}

async function tryInstallPluginOrHookPackFromNpmSpec(params: {
  snapshot: ConfigSnapshotForInstallExecution;
  installMode: "install" | "update";
  spec: string;
  pin?: boolean;
  safetyOverrides: InstallSafetyOverrides;
  allowBundledFallback: boolean;
  extensionsDir: string;
  expectedPluginId?: string;
  expectedIntegrity?: string;
  trustedSourceLinkedOfficialInstall?: boolean;
  invalidateRuntimeCache?: boolean;
  runtime?: RuntimeEnv;
}): Promise<{ ok: true } | { ok: false }> {
  const fullyBlockedReason = resolveFullyBlockedConfigMutationReason(params.snapshot);
  if (fullyBlockedReason) {
    (params.runtime ?? defaultRuntime).error(fullyBlockedReason);
    return { ok: false };
  }
  if (
    params.snapshot.pluginMutation.mode === "blocked" ||
    params.snapshot.hookMutation.mode === "blocked"
  ) {
    const hookProbe = await probeHookPackFromNpmSpec({
      config: params.snapshot.config,
      spec: params.spec,
      mode: params.installMode,
      inspection: "package-kind",
      ...(params.expectedIntegrity ? { expectedIntegrity: params.expectedIntegrity } : {}),
      logger: createHookPackInstallLogger(params.runtime),
    });
    if (hookProbe.ok && hookProbe.packageKind === "hook-only") {
      if (params.snapshot.hookMutation.mode === "blocked") {
        (params.runtime ?? defaultRuntime).error(params.snapshot.hookMutation.reason);
        return { ok: false };
      }
      const hookFallback = await tryInstallHookPackFromNpmSpec({
        snapshot: params.snapshot,
        installMode: params.installMode,
        spec: params.spec,
        pin: params.pin,
        expectedIntegrity: hookProbe.npmResolution?.integrity ?? params.expectedIntegrity,
        expectedPackageKind: "hook-only",
        runtime: params.runtime,
      });
      if (hookFallback.ok) {
        return { ok: true };
      }
      (params.runtime ?? defaultRuntime).error(hookFallback.error);
      return { ok: false };
    }
    if (params.snapshot.pluginMutation.mode === "blocked") {
      (params.runtime ?? defaultRuntime).error(params.snapshot.pluginMutation.reason);
      return { ok: false };
    }
  }

  const result = await installPluginFromNpmSpec({
    ...params.safetyOverrides,
    mode: params.installMode,
    spec: params.spec,
    ...(params.expectedPluginId ? { expectedPluginId: params.expectedPluginId } : {}),
    ...(params.expectedIntegrity ? { expectedIntegrity: params.expectedIntegrity } : {}),
    ...(params.trustedSourceLinkedOfficialInstall
      ? { trustedSourceLinkedOfficialInstall: true }
      : {}),
    extensionsDir: params.extensionsDir,
    logger: createPluginInstallLogger(params.runtime),
  });
  if (!result.ok) {
    if (isTerminalPluginInstallFailure(result.code)) {
      (params.runtime ?? defaultRuntime).error(result.error);
      return { ok: false };
    }
    if (params.allowBundledFallback) {
      const bundledFallbackPlan = resolveBundledInstallPlanForNpmFailure({
        rawSpec: params.spec,
        code: result.code,
        findBundledSource: (lookup) => findBundledPluginSource({ lookup }),
      });
      if (bundledFallbackPlan) {
        await installBundledPluginSource({
          snapshot: params.snapshot,
          rawSpec: params.spec,
          bundledSource: bundledFallbackPlan.bundledSource,
          warning: bundledFallbackPlan.warning,
          invalidateRuntimeCache: params.invalidateRuntimeCache,
          runtime: params.runtime,
        });
        return { ok: true };
      }
    }
    const hookFallback = await tryInstallHookPackFromNpmSpec({
      snapshot: params.snapshot,
      installMode: params.installMode,
      spec: params.spec,
      pin: params.pin,
      expectedIntegrity: params.expectedIntegrity,
      runtime: params.runtime,
    });
    if (hookFallback.ok) {
      return { ok: true };
    }
    (params.runtime ?? defaultRuntime).error(
      formatPluginInstallWithHookFallbackError(result.error, hookFallback),
    );
    return { ok: false };
  }

  const installRecord = resolvePinnedNpmInstallRecordForCli(
    params.spec,
    Boolean(params.pin),
    result.targetDir,
    result.version,
    result.npmResolution,
    params.runtime?.log ?? defaultRuntime.log,
    theme.warn,
  );
  await persistPluginInstall({
    snapshot: params.snapshot,
    pluginId: result.pluginId,
    install: installRecord,
    invalidateRuntimeCache: params.invalidateRuntimeCache,
    runtime: params.runtime,
  });
  return { ok: true };
}

async function tryInstallPluginFromNpmPackArchive(params: {
  snapshot: ConfigSnapshotForInstallExecution;
  installMode: "install" | "update";
  archivePath: string;
  safetyOverrides: InstallSafetyOverrides;
  extensionsDir: string;
  invalidateRuntimeCache?: boolean;
  runtime?: RuntimeEnv;
}): Promise<{ ok: true } | { ok: false }> {
  const result = await installPluginFromNpmPackArchive({
    ...params.safetyOverrides,
    mode: params.installMode,
    archivePath: params.archivePath,
    extensionsDir: params.extensionsDir,
    logger: createPluginInstallLogger(params.runtime),
  });
  if (!result.ok) {
    (params.runtime ?? defaultRuntime).error(result.error);
    return { ok: false };
  }

  await persistPluginInstall({
    snapshot: params.snapshot,
    pluginId: result.pluginId,
    install: {
      source: "npm",
      spec: result.npmResolution?.resolvedSpec ?? result.manifestName ?? result.pluginId,
      sourcePath: params.archivePath,
      installPath: result.targetDir,
      ...(result.version ? { version: result.version } : {}),
      ...(result.npmResolution?.name ? { resolvedName: result.npmResolution.name } : {}),
      ...(result.npmResolution?.version ? { resolvedVersion: result.npmResolution.version } : {}),
      ...(result.npmResolution?.resolvedSpec
        ? { resolvedSpec: result.npmResolution.resolvedSpec }
        : {}),
      ...(result.npmResolution?.integrity ? { integrity: result.npmResolution.integrity } : {}),
      ...(result.npmResolution?.shasum ? { shasum: result.npmResolution.shasum } : {}),
      ...(result.npmResolution?.resolvedAt ? { resolvedAt: result.npmResolution.resolvedAt } : {}),
      artifactKind: "npm-pack",
      artifactFormat: "tgz",
      ...(result.npmResolution?.integrity ? { npmIntegrity: result.npmResolution.integrity } : {}),
      ...(result.npmResolution?.shasum ? { npmShasum: result.npmResolution.shasum } : {}),
      ...(result.npmTarballName ? { npmTarballName: result.npmTarballName } : {}),
    },
    invalidateRuntimeCache: params.invalidateRuntimeCache,
    runtime: params.runtime,
  });
  return { ok: true };
}

async function tryInstallPluginFromGitSpec(params: {
  snapshot: ConfigSnapshotForInstallExecution;
  installMode: "install" | "update";
  spec: string;
  safetyOverrides: InstallSafetyOverrides;
  extensionsDir: string;
  invalidateRuntimeCache?: boolean;
  runtime?: RuntimeEnv;
}): Promise<{ ok: true } | { ok: false }> {
  const result = await installPluginFromGitSpec({
    ...params.safetyOverrides,
    mode: params.installMode,
    spec: params.spec,
    extensionsDir: params.extensionsDir,
    logger: createPluginInstallLogger(params.runtime),
  });
  if (!result.ok) {
    (params.runtime ?? defaultRuntime).error(result.error);
    return { ok: false };
  }

  await persistPluginInstall({
    snapshot: params.snapshot,
    pluginId: result.pluginId,
    install: {
      source: "git",
      spec: params.spec,
      installPath: result.targetDir,
      version: result.version,
      resolvedAt: result.git.resolvedAt,
      gitUrl: result.git.url,
      gitRef: result.git.ref,
      gitCommit: result.git.commit,
    },
    invalidateRuntimeCache: params.invalidateRuntimeCache,
    runtime: params.runtime,
  });
  return { ok: true };
}

function isTerminalPluginInstallFailure(code?: string): boolean {
  return (
    code === PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED ||
    code === PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_FAILED ||
    code === PLUGIN_INSTALL_ERROR_CODE.UNSUPPORTED_PLAIN_FILE_PLUGIN
  );
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

function buildInvalidPluginInstallConfigError(message: string): Error {
  const error = new Error(message);
  (error as { code?: string }).code = "INVALID_CONFIG";
  return error;
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

function collectRequestedPluginInstallPaths(
  cfg: OpenClawConfig,
  installRecords: Awaited<ReturnType<typeof loadInstalledPluginIndexInstallRecords>>,
  request: PluginInstallRequestContext,
  env: NodeJS.ProcessEnv = process.env,
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

function isOwnedMissingPluginLoadPathIssue(
  issue: { path?: string; message?: string },
  ownedLoadPaths: ReadonlySet<string>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const missingPath = extractMissingPluginLoadPath(issue);
  return missingPath !== null && ownedLoadPaths.has(resolveUserPath(missingPath, env));
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
  env: NodeJS.ProcessEnv = process.env,
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
  env: NodeJS.ProcessEnv = process.env,
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
    // The persisted bundled registry proves this plugin previously owned its
    // removed core path; do not infer ownership from the requested id alone.
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
  const nextConfig = removeOwnedMissingPluginLoadPaths(
    snapshot.config,
    snapshot.issues,
    ownedLoadPaths,
    process.env,
  );
  return {
    config: nextConfig,
    baseHash: snapshot.hash,
    writeOptions: mutationWriteOptions,
    hookMutation,
    pluginMutation,
  };
}

async function loadConfigForInstall(
  request: PluginInstallRequestContext,
): Promise<ConfigSnapshotForInstallExecution> {
  const prepared = await tracePluginLifecyclePhaseAsync(
    "config read",
    () => readConfigFileSnapshotForWrite(),
    { command: "install" },
  );
  const { snapshot, writeOptions } = prepared;
  const mutationWriteOptions = selectInstallMutationWriteOptions(writeOptions);
  if (snapshot.valid) {
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
  return loadConfigFromSnapshotForInstall(request, prepared);
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.pluginsInstallCommandTestApi")
  ] = { loadConfigForInstall };
}

type RunPluginInstallCommandParams = {
  raw: string;
  opts: InstallSafetyOverrides & {
    acknowledgeClawHubRisk?: boolean;
    expectedIntegrity?: string;
    expectedPluginId?: string;
    force?: boolean;
    link?: boolean;
    pin?: boolean;
    marketplace?: string;
  };
  invalidateRuntimeCache?: boolean;
  clawManaged?: boolean;
  runtime?: RuntimeEnv;
};

class DeferredPluginInstallExit extends Error {
  constructor(readonly code: number) {
    super(`plugin install requested exit ${code}`);
    this.name = "DeferredPluginInstallExit";
  }
}

function deferPluginInstallRuntimeExit(runtime: RuntimeEnv): RuntimeEnv {
  return {
    ...runtime,
    // Process exit must happen after the lifecycle lease unwinds; otherwise the
    // persisted lease survives until expiry and blocks the next plugin mutation.
    exit: (code) => {
      throw new DeferredPluginInstallExit(code);
    },
  };
}

export async function runPluginInstallCommand(params: RunPluginInstallCommandParams) {
  assertConfigWriteAllowedInCurrentMode();
  const runtime = params.runtime ?? defaultRuntime;
  try {
    return await withPluginLifecycleLease(
      {},
      async () =>
        await runPluginInstallCommandUnlocked({
          ...params,
          runtime: deferPluginInstallRuntimeExit(runtime),
        }),
    );
  } catch (error) {
    if (!(error instanceof DeferredPluginInstallExit)) {
      throw error;
    }
    return runtime.exit(error.code);
  }
}

async function runPluginInstallCommandUnlocked(params: RunPluginInstallCommandParams) {
  assertConfigWriteAllowedInCurrentMode();

  const runtime = params.runtime ?? defaultRuntime;
  const invalidateRuntimeCache = params.invalidateRuntimeCache ?? true;
  const shorthand = !params.opts.marketplace
    ? await tracePluginLifecyclePhaseAsync(
        "marketplace shortcut resolution",
        () => resolveMarketplaceInstallShortcut(params.raw),
        { command: "install" },
      )
    : null;
  if (shorthand?.ok === false) {
    runtime.error(shorthand.error);
    return runtime.exit(1);
  }

  const raw = shorthand?.ok ? shorthand.plugin : params.raw;
  const opts = {
    ...params.opts,
    marketplace:
      params.opts.marketplace ?? (shorthand?.ok ? shorthand.marketplaceSource : undefined),
  };
  if (opts.dangerouslyForceUnsafeInstall) {
    runtime.log(theme.warn(DEPRECATED_DANGEROUS_FORCE_UNSAFE_INSTALL_WARNING));
  }
  if (opts.marketplace) {
    if (opts.link) {
      runtime.error(
        `--link is not supported with --marketplace. Remove --link, or install a local path with ${formatCliCommand(`openclaw plugins install --link <path> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)}.`,
      );
      return runtime.exit(1);
    }
    if (opts.pin) {
      runtime.error(
        `--pin is not supported with --marketplace. Use ${formatCliCommand(`openclaw plugins install <plugin> --marketplace <name> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)} without --pin.`,
      );
      return runtime.exit(1);
    }
  }
  const gitPrefix = raw.trim().toLowerCase().startsWith("git:");
  const gitSpec = parseGitPluginSpec(raw);
  if (gitPrefix && !gitSpec) {
    runtime.error(
      `Unsupported git plugin spec: ${raw}. Use ${formatCliCommand(`openclaw plugins install git:<repo>@<ref> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)}.`,
    );
    return runtime.exit(1);
  }
  if (gitSpec && opts.link) {
    runtime.error(
      `--link is not supported with git: installs. Use ${formatCliCommand(`openclaw plugins install git:<repo>@<ref> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)} for Git installs or ${formatCliCommand(`openclaw plugins install --link <path> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)} for local paths.`,
    );
    return runtime.exit(1);
  }
  if (gitSpec && opts.pin) {
    runtime.error(
      `--pin is not supported with git: installs. Pin the ref in the spec instead, for example ${formatCliCommand(`openclaw plugins install git:<repo>@<ref> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)}.`,
    );
    return runtime.exit(1);
  }
  const npmPackPath = parseNpmPackPrefixPath(raw);
  const clawhubSpec = parseClawHubPluginSpec(raw);
  const requestResolution = resolvePluginInstallRequestContext({
    rawSpec: raw,
    marketplace: opts.marketplace,
  });
  if (!requestResolution.ok) {
    runtime.error(requestResolution.error);
    return runtime.exit(1);
  }
  let request = requestResolution.request;
  const resolved = request.resolvedPath ?? request.normalizedSpec;
  const resolvesToLocalPath = fs.existsSync(resolved);
  if (!resolvesToLocalPath && (gitSpec || npmPackPath !== null || clawhubSpec)) {
    request = { ...request, installKind: "plugin" };
  }
  const bundledPreNpmPlan = resolvesToLocalPath
    ? null
    : resolveBundledInstallPlanBeforeNpm({
        rawSpec: raw,
        findBundledSource: (lookup) => findBundledPluginSource({ lookup }),
      });
  const officialExternalPlan = resolvesToLocalPath
    ? null
    : resolveCatalogOfficialExternalInstallPlan(raw);
  if (bundledPreNpmPlan || officialExternalPlan) {
    request = { ...request, installKind: "plugin" };
  }
  const snapshot = await loadConfigForInstall(request).catch((error: unknown) => {
    runtime.error(formatErrorMessage(error));
    return null;
  });
  if (!snapshot) {
    return runtime.exit(1);
  }
  const cfg = snapshot.config;
  // For linked paths, --force confirms source provenance without changing copy/update mode.
  const installMode = resolveInstallMode(opts.force && !opts.link);
  const safetyOverrides = resolveInstallSafetyOverrides({ ...opts, config: cfg });
  const extensionsDir = resolveDefaultPluginExtensionsDir();
  const acknowledgeNonClawHubSource = async (
    sourceClass: NonClawHubInstallSourceClass,
    spec: string,
  ): Promise<boolean> =>
    await confirmNonClawHubInstall({
      acknowledged: opts.force,
      runtime,
      sourceClass,
      spec,
    });

  if (opts.marketplace) {
    if (!(await acknowledgeNonClawHubSource("marketplace", `${raw} from ${opts.marketplace}`))) {
      return runtime.exit(1);
    }
    const result = await installPluginFromMarketplace({
      ...safetyOverrides,
      marketplace: opts.marketplace,
      mode: installMode,
      plugin: raw,
      extensionsDir,
      logger: createPluginInstallLogger(runtime),
    });
    if (!result.ok) {
      if (!isClawHubBlockedCliFailure(result)) {
        runtime.error(result.error);
      }
      return runtime.exit(1);
    }

    await persistPluginInstall({
      snapshot,
      pluginId: result.pluginId,
      install: {
        source: "marketplace",
        installPath: result.targetDir,
        version: result.version,
        marketplaceName: result.marketplaceName,
        marketplaceSource: result.marketplaceSource,
        marketplacePlugin: result.marketplacePlugin,
      },
      invalidateRuntimeCache,
      runtime,
    });
    return;
  }

  if (fs.existsSync(resolved)) {
    const bundledLocalSource = resolveArchiveKind(resolved)
      ? undefined
      : findBundledPluginSource({ lookup: { kind: "localPath", value: resolved } });
    if (
      !bundledLocalSource &&
      !(await acknowledgeNonClawHubSource(
        resolveArchiveKind(resolved) ? "local-archive" : "local-path",
        resolved,
      ))
    ) {
      return runtime.exit(1);
    }
    const fullyBlockedReason = resolveFullyBlockedConfigMutationReason(snapshot);
    if (fullyBlockedReason) {
      runtime.error(fullyBlockedReason);
      return runtime.exit(1);
    }
    if (snapshot.pluginMutation.mode === "blocked" || snapshot.hookMutation.mode === "blocked") {
      const hookProbe = await probeHookPackFromPath({
        ...safetyOverrides,
        path: resolved,
        mode: installMode,
        inspection: "package-kind",
      });
      if (hookProbe.ok && hookProbe.packageKind === "hook-only") {
        if (snapshot.hookMutation.mode === "blocked") {
          runtime.error(snapshot.hookMutation.reason);
          return runtime.exit(1);
        }
        const hookFallback = await tryInstallHookPackFromLocalPath({
          snapshot,
          installMode,
          resolvedPath: resolved,
          safetyOverrides,
          ...(opts.link ? { link: true } : {}),
          expectedPackageKind: "hook-only",
          runtime,
        });
        if (hookFallback.ok) {
          return;
        }
        runtime.error(hookFallback.error);
        return runtime.exit(1);
      }
      if (snapshot.pluginMutation.mode === "blocked") {
        runtime.error(snapshot.pluginMutation.reason);
        return runtime.exit(1);
      }
    }
    if (opts.link) {
      const existing = cfg.plugins?.load?.paths ?? [];
      const merged = uniqueStrings([...existing, resolved]);
      const probe = await installPluginFromPath({
        ...safetyOverrides,
        mode: installMode,
        path: resolved,
        dryRun: true,
        allowSourceTypeScriptEntries: true,
        extensionsDir,
        logger: createPluginInstallLogger(runtime),
      });
      if (!probe.ok) {
        if (isTerminalPluginInstallFailure(probe.code)) {
          runtime.error(probe.error);
          return runtime.exit(1);
        }
        const hookFallback = await tryInstallHookPackFromLocalPath({
          snapshot,
          installMode,
          resolvedPath: resolved,
          safetyOverrides,
          link: true,
          runtime,
        });
        if (hookFallback.ok) {
          return;
        }
        runtime.error(formatPluginInstallWithHookFallbackError(probe.error, hookFallback));
        return runtime.exit(1);
      }

      await persistPluginInstall({
        snapshot: {
          ...snapshot,
          config: {
            ...cfg,
            plugins: {
              ...cfg.plugins,
              load: {
                ...cfg.plugins?.load,
                paths: merged,
              },
            },
          },
        },
        pluginId: probe.pluginId,
        install: {
          source: "path",
          sourcePath: resolved,
          installPath: resolved,
          version: probe.version,
        },
        invalidateRuntimeCache,
        successMessage: `Linked plugin path: ${shortenHomePath(resolved)}`,
        runtime,
      });
      return;
    }

    const result = await installPluginFromPath({
      ...safetyOverrides,
      mode: installMode,
      path: resolved,
      extensionsDir,
      logger: createPluginInstallLogger(runtime),
    });
    if (!result.ok) {
      if (isTerminalPluginInstallFailure(result.code)) {
        runtime.error(result.error);
        return runtime.exit(1);
      }
      const hookFallback = await tryInstallHookPackFromLocalPath({
        snapshot,
        installMode,
        resolvedPath: resolved,
        safetyOverrides,
        runtime,
      });
      if (hookFallback.ok) {
        return;
      }
      runtime.error(formatPluginInstallWithHookFallbackError(result.error, hookFallback));
      return runtime.exit(1);
    }

    const source: "archive" | "path" = resolveArchiveKind(resolved) ? "archive" : "path";
    await persistPluginInstall({
      snapshot,
      pluginId: result.pluginId,
      install: {
        source,
        sourcePath: resolved,
        installPath: result.targetDir,
        version: result.version,
      },
      invalidateRuntimeCache,
      runtime,
    });
    return;
  }

  if (opts.link) {
    runtime.error(
      `--link requires a local path. Run ${formatCliCommand(`openclaw plugins install --link <path> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)}.`,
    );
    return runtime.exit(1);
  }

  const npmPrefixSpec = parseNpmPrefixSpec(raw);
  if (npmPrefixSpec !== null) {
    if (!npmPrefixSpec) {
      runtime.error(
        `Unsupported npm plugin spec: missing package. Use ${formatCliCommand(`openclaw plugins install npm:<package> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)}.`,
      );
      return runtime.exit(1);
    }
    const trustedNpmInstall = resolveOpenClawTrustedNpmPackageInstall(npmPrefixSpec);
    if (!trustedNpmInstall && !(await acknowledgeNonClawHubSource("npm", npmPrefixSpec))) {
      return runtime.exit(1);
    }
    const npmPrefixResult = await tryInstallPluginOrHookPackFromNpmSpec({
      snapshot,
      installMode,
      spec: npmPrefixSpec,
      pin: opts.pin,
      safetyOverrides,
      allowBundledFallback: false,
      extensionsDir,
      invalidateRuntimeCache,
      ...(trustedNpmInstall
        ? {
            expectedPluginId: trustedNpmInstall.pluginId,
            ...(trustedNpmInstall.expectedIntegrity
              ? { expectedIntegrity: trustedNpmInstall.expectedIntegrity }
              : {}),
            trustedSourceLinkedOfficialInstall: true,
          }
        : {}),
      runtime,
    });
    if (!npmPrefixResult.ok) {
      return runtime.exit(1);
    }
    return;
  }

  if (npmPackPath !== null) {
    if (!npmPackPath) {
      runtime.error(
        `Unsupported npm-pack plugin spec: missing archive path. Use ${formatCliCommand(`openclaw plugins install npm-pack:<path-to.tgz> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)}.`,
      );
      return runtime.exit(1);
    }
    if (!(await acknowledgeNonClawHubSource("npm-pack", raw))) {
      return runtime.exit(1);
    }
    const npmPackResult = await tryInstallPluginFromNpmPackArchive({
      snapshot,
      installMode,
      archivePath: npmPackPath,
      safetyOverrides,
      extensionsDir,
      invalidateRuntimeCache,
      runtime,
    });
    if (!npmPackResult.ok) {
      return runtime.exit(1);
    }
    return;
  }

  if (gitSpec) {
    if (!(await acknowledgeNonClawHubSource("git", raw))) {
      return runtime.exit(1);
    }
    const gitResult = await tryInstallPluginFromGitSpec({
      snapshot,
      installMode,
      spec: raw,
      safetyOverrides,
      extensionsDir,
      invalidateRuntimeCache,
      runtime,
    });
    if (!gitResult.ok) {
      return runtime.exit(1);
    }
    return;
  }

  if (
    looksLikeLocalInstallSpec(raw, [
      ".ts",
      ".js",
      ".mjs",
      ".cjs",
      ".tgz",
      ".tar.gz",
      ".tar",
      ".zip",
    ])
  ) {
    runtime.error(
      `Plugin path not found: ${resolved}. Check the path, or install from npm with ${formatCliCommand(`openclaw plugins install npm:<package> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)}.`,
    );
    return runtime.exit(1);
  }

  if (bundledPreNpmPlan) {
    await tracePluginLifecyclePhaseAsync(
      "install execution",
      () =>
        installBundledPluginSource({
          snapshot,
          rawSpec: raw,
          bundledSource: bundledPreNpmPlan.bundledSource,
          warning: bundledPreNpmPlan.warning,
          invalidateRuntimeCache,
          runtime,
        }),
      {
        command: "install",
        source: "bundled",
        pluginId: bundledPreNpmPlan.bundledSource.pluginId,
      },
    );
    return;
  }

  if (officialExternalPlan) {
    const npmResult = await tryInstallPluginOrHookPackFromNpmSpec({
      snapshot,
      installMode,
      spec: officialExternalPlan.npmSpec,
      pin: opts.pin,
      safetyOverrides,
      allowBundledFallback: false,
      extensionsDir,
      expectedPluginId: officialExternalPlan.pluginId,
      expectedIntegrity: officialExternalPlan.expectedIntegrity,
      trustedSourceLinkedOfficialInstall: true,
      invalidateRuntimeCache,
      runtime,
    });
    if (!npmResult.ok) {
      return runtime.exit(1);
    }
    return;
  }

  if (clawhubSpec) {
    const installFromClawHub = async (
      installSnapshot = snapshot,
      installSafetyOverrides = safetyOverrides,
    ) => {
      const result = await installPluginFromClawHub({
        ...installSafetyOverrides,
        ...resolveClawHubRiskAcknowledgementCliOptions({
          acknowledgeClawHubRisk: opts.acknowledgeClawHubRisk,
          action: "installing",
        }),
        mode: installMode,
        spec: raw,
        ...(opts.expectedIntegrity ? { expectedIntegrity: opts.expectedIntegrity } : {}),
        ...(opts.expectedPluginId ? { expectedPluginId: opts.expectedPluginId } : {}),
        extensionsDir,
        logger: createPluginInstallLogger(runtime),
      });
      if (!result.ok) {
        if (!isClawHubBlockedCliFailure(result)) {
          runtime.error(result.error);
        }
        return false;
      }

      await persistPluginInstall({
        snapshot: installSnapshot,
        pluginId: result.pluginId,
        install: {
          ...buildClawHubPluginInstallRecordFields(result.clawhub),
          spec: raw,
          installPath: result.targetDir,
        },
        invalidateRuntimeCache,
        runtime,
      });
      if (!params.clawManaged && result.clawhub.version) {
        markClawPackageIndependentlyOwned({
          kind: "plugin",
          source: "clawhub",
          ref: result.clawhub.clawhubPackage,
          version: result.clawhub.version,
        });
      }
      await reportClawHubPluginInstallTelemetry({
        baseUrl: result.clawhub.clawhubUrl,
        packageName: result.clawhub.clawhubPackage,
        version: result.clawhub.version,
      }).catch(() => undefined);
      return true;
    };
    if (params.clawManaged) {
      if (!(await installFromClawHub())) {
        return runtime.exit(1);
      }
      return;
    }
    const installed = await withClawPackageLifecycleLease(
      { kind: "plugin", source: "clawhub", ref: clawhubSpec.name },
      async () => {
        const leasedSnapshot = await loadConfigForInstall(request).catch((error: unknown) => {
          runtime.error(formatErrorMessage(error));
          return null;
        });
        if (!leasedSnapshot) {
          return false;
        }
        return await installFromClawHub(
          leasedSnapshot,
          resolveInstallSafetyOverrides({ ...opts, config: leasedSnapshot.config }),
        );
      },
    );
    if (!installed) {
      return runtime.exit(1);
    }
    return;
  }

  const trustedNpmInstall = resolveOpenClawTrustedNpmPackageInstall(raw);
  if (!trustedNpmInstall && !(await acknowledgeNonClawHubSource("npm", raw))) {
    return runtime.exit(1);
  }
  const npmResult = await tryInstallPluginOrHookPackFromNpmSpec({
    snapshot,
    installMode,
    spec: raw,
    pin: opts.pin,
    safetyOverrides,
    allowBundledFallback: true,
    extensionsDir,
    invalidateRuntimeCache,
    ...(trustedNpmInstall
      ? {
          expectedPluginId: trustedNpmInstall.pluginId,
          ...(trustedNpmInstall.expectedIntegrity
            ? { expectedIntegrity: trustedNpmInstall.expectedIntegrity }
            : {}),
          trustedSourceLinkedOfficialInstall: true,
        }
      : {}),
    runtime,
  });
  if (!npmResult.ok) {
    return runtime.exit(1);
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
