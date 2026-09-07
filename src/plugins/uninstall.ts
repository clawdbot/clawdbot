// Removes installed plugins and updates plugin index records.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { formatErrorMessage } from "../infra/errors.js";
import { readOpenClawManagedNpmRootOverrides } from "../infra/npm-managed-root.js";
import { pathMayExistSync } from "../infra/path-existence.js";
import { createSafeNpmInstallEnv } from "../infra/safe-package-install.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  isPluginNpmManagedPath,
  isPluginNpmProjectDir,
  resolveDefaultPluginGitDir,
  resolveDefaultPluginNpmDir,
  resolvePluginInstallDir,
  resolvePluginNpmProjectsDir,
} from "./install-paths.js";
import { relinkOpenClawPeerDependenciesInManagedNpmRoot } from "./plugin-peer-link.js";
import { defaultSlotIdForKey } from "./slots.js";
import {
  isUninstallPathInsideOrEqual,
  resolveComparableUninstallPath,
  type PluginConfigUninstallActions,
} from "./uninstall-config.js";
import { pruneManagedNpmPeerDependenciesAfterUninstall } from "./uninstall-managed-npm.js";
import {
  removePluginInstallOwnerFromConfig,
  removePluginRuntimePolicyFromConfig,
} from "./uninstall-package-config.js";
import {
  prepareConfigForDisabledPluginSet,
  resolvePluginPackageUninstallPlan,
} from "./uninstall-package-plan.js";

export { resolveUninstallChannelConfigKeys } from "./uninstall-config.js";

type UninstallActions = PluginConfigUninstallActions & {
  directory: boolean;
};

const UNINSTALL_ACTION_LABELS = {
  entry: "plugin settings",
  install: "install record",
  allowlist: "allowlist entry",
  denylist: "denylist entry",
  loadPath: "load path",
  memorySlot: "memory slot",
  contextEngineSlot: "context engine slot",
  channelConfig: "channel config",
  directory: "directory",
} satisfies Record<keyof UninstallActions, string>;

const UNINSTALL_ACTION_ORDER = [
  "entry",
  "install",
  "allowlist",
  "denylist",
  "loadPath",
  "memorySlot",
  "contextEngineSlot",
  "channelConfig",
  "directory",
] as const satisfies ReadonlyArray<keyof UninstallActions>;

export function formatUninstallActionLabels(
  actions: UninstallActions,
  preview?: { channelConfigKeys: readonly string[] },
): string[] {
  return UNINSTALL_ACTION_ORDER.flatMap((key) => {
    if (!actions[key]) {
      return [];
    }
    if (preview) {
      if (key === "memorySlot" || key === "contextEngineSlot") {
        const slot = key === "memorySlot" ? "memory" : "contextEngine";
        return [`${UNINSTALL_ACTION_LABELS[key]} (will reset to "${defaultSlotIdForKey(slot)}")`];
      }
      if (key === "channelConfig") {
        return preview.channelConfigKeys.map(
          (id) => `${UNINSTALL_ACTION_LABELS.channelConfig} (channels.${id})`,
        );
      }
    }
    return [UNINSTALL_ACTION_LABELS[key]];
  });
}

function hasUninstallAction(actions: PluginConfigUninstallActions): boolean {
  return Object.values(actions).some(Boolean);
}

export type PluginUninstallDirectoryRemoval = {
  target: string;
  cleanup?:
    | {
        kind: "npm";
        npmRoot: string;
        packageName: string;
        rootKind: "legacy-shared" | "isolated-project";
      }
    | {
        kind: "git";
        parentDir: string;
      };
};

type PluginUninstallPlanResult =
  | {
      ok: true;
      config: OpenClawConfig;
      pluginId: string;
      actions: UninstallActions;
      directoryRemoval: PluginUninstallDirectoryRemoval | null;
    }
  | { ok: false; error: string };

function resolveUninstallDirectoryTarget(params: {
  pluginId: string;
  hasInstall: boolean;
  installRecord?: PluginInstallRecord;
  extensionsDir?: string;
}): string | null {
  if (!params.hasInstall) {
    return null;
  }

  if (isLinkedPathInstallRecord(params.installRecord)) {
    return null;
  }

  const npmManagedInstall = resolveNpmManagedInstall({
    installRecord: params.installRecord,
    extensionsDir: params.extensionsDir,
  });
  if (npmManagedInstall) {
    return npmManagedInstall.installPath;
  }
  const gitManagedInstall = resolveGitManagedInstall({
    installRecord: params.installRecord,
    extensionsDir: params.extensionsDir,
  });
  if (gitManagedInstall) {
    return gitManagedInstall.installPath;
  }

  let defaultPath: string;
  try {
    defaultPath = resolvePluginInstallDir(params.pluginId, params.extensionsDir);
  } catch {
    return null;
  }

  const configuredPath = params.installRecord?.installPath;
  if (!configuredPath) {
    return defaultPath;
  }

  if (path.resolve(configuredPath) === path.resolve(defaultPath)) {
    return configuredPath;
  }

  if (params.extensionsDir && isUninstallPathInsideOrEqual(params.extensionsDir, configuredPath)) {
    return configuredPath;
  }

  const recordedManagedPath = resolveRecordedManagedInstallPath({
    pluginId: params.pluginId,
    installPath: configuredPath,
  });
  if (recordedManagedPath) {
    return recordedManagedPath;
  }

  // Never trust configured installPath blindly for recursive deletes outside
  // the managed extensions directory.
  return defaultPath;
}

function resolveNpmManagedInstall(params: {
  installRecord?: PluginInstallRecord;
  extensionsDir?: string;
}): {
  installPath: string;
  npmRoot: string;
  packageName: string;
  rootKind: "legacy-shared" | "isolated-project";
} | null {
  const installPath = params.installRecord?.installPath?.trim();
  if (params.installRecord?.source !== "npm" || !installPath) {
    return null;
  }

  const npmRoots = new Set<string>();
  if (params.extensionsDir) {
    npmRoots.add(path.join(path.dirname(path.resolve(params.extensionsDir)), "npm"));
  }
  npmRoots.add(resolveDefaultPluginNpmDir());

  for (const npmRoot of npmRoots) {
    const nodeModulesRoot = path.join(npmRoot, "node_modules");
    if (
      isUninstallPathInsideOrEqual(nodeModulesRoot, installPath) &&
      resolveComparableUninstallPath(nodeModulesRoot) !==
        resolveComparableUninstallPath(installPath)
    ) {
      const packageName = resolveNpmPackageNameFromInstallPath({ installPath, nodeModulesRoot });
      return packageName ? { installPath, npmRoot, packageName, rootKind: "legacy-shared" } : null;
    }
    const projectMatch = resolveNpmManagedProjectInstall({
      installPath,
      projectsDir: resolvePluginNpmProjectsDir(npmRoot),
    });
    if (projectMatch) {
      return projectMatch;
    }
  }
  return null;
}

function resolveNpmManagedProjectInstall(params: { installPath: string; projectsDir: string }): {
  installPath: string;
  npmRoot: string;
  packageName: string;
  rootKind: "isolated-project";
} | null {
  if (
    !isUninstallPathInsideOrEqual(params.projectsDir, params.installPath) ||
    resolveComparableUninstallPath(params.projectsDir) ===
      resolveComparableUninstallPath(params.installPath)
  ) {
    return null;
  }
  const relativePath = path.relative(
    path.resolve(params.projectsDir),
    path.resolve(params.installPath),
  );
  const segments = relativePath.split(path.sep).filter(Boolean);
  if (segments.length < 3 || segments[1] !== "node_modules") {
    return null;
  }
  const npmRoot = path.join(params.projectsDir, segments[0] ?? "");
  const npmDir = path.dirname(params.projectsDir);
  if (!isUninstallPathInsideOrEqual(npmDir, params.installPath)) {
    return null;
  }
  const nodeModulesRoot = path.join(npmRoot, "node_modules");
  const packageName = resolveNpmPackageNameFromInstallPath({
    installPath: params.installPath,
    nodeModulesRoot,
  });
  if (
    !packageName ||
    resolveComparableUninstallPath(params.installPath) !==
      resolveComparableUninstallPath(path.join(nodeModulesRoot, ...packageName.split("/")))
  ) {
    return null;
  }
  const ownsProjectRoot = isPluginNpmProjectDir({
    packageName,
    projectDir: npmRoot,
    npmDir,
  });
  return {
    installPath: ownsProjectRoot ? npmRoot : params.installPath,
    npmRoot,
    packageName,
    rootKind: "isolated-project",
  };
}

function resolveNpmPackageNameFromInstallPath(params: {
  installPath: string;
  nodeModulesRoot: string;
}): string | null {
  const relativePath = path.relative(
    path.resolve(params.nodeModulesRoot),
    path.resolve(params.installPath),
  );
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }
  const segments = relativePath.split(path.sep).filter(Boolean);
  if (segments.length < 1) {
    return null;
  }
  if (segments[0]?.startsWith("@")) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
  }
  return segments[0] ?? null;
}

function resolveGitManagedInstall(params: {
  installRecord?: PluginInstallRecord;
  extensionsDir?: string;
}): { installPath: string; parentDir: string } | null {
  const installPath = params.installRecord?.installPath?.trim();
  if (params.installRecord?.source !== "git" || !installPath) {
    return null;
  }

  const gitRoots = new Set<string>();
  if (params.extensionsDir) {
    gitRoots.add(path.join(path.dirname(path.resolve(params.extensionsDir)), "git"));
  }
  gitRoots.add(resolveDefaultPluginGitDir());

  for (const gitRoot of gitRoots) {
    if (
      isUninstallPathInsideOrEqual(gitRoot, installPath) &&
      resolveComparableUninstallPath(gitRoot) !== resolveComparableUninstallPath(installPath)
    ) {
      return { installPath, parentDir: path.dirname(installPath) };
    }
  }
  return null;
}

function resolveRecordedManagedInstallPath(params: {
  pluginId: string;
  installPath: string;
}): string | null {
  const resolvedInstallPath = path.resolve(params.installPath);
  const recordedExtensionsDir = path.dirname(resolvedInstallPath);
  if (path.basename(recordedExtensionsDir) !== "extensions") {
    return null;
  }

  try {
    const canonicalInstallPath = path.resolve(
      resolvePluginInstallDir(params.pluginId, recordedExtensionsDir),
    );
    return canonicalInstallPath === resolvedInstallPath ? params.installPath : null;
  } catch {
    return null;
  }
}

function isLinkedPathInstallRecord(installRecord: PluginInstallRecord | undefined): boolean {
  if (installRecord?.source !== "path") {
    return false;
  }
  if (!installRecord.sourcePath || !installRecord.installPath) {
    return true;
  }
  return (
    resolveComparableUninstallPath(installRecord.sourcePath) ===
    resolveComparableUninstallPath(installRecord.installPath)
  );
}

type UninstallPluginParams = {
  config: OpenClawConfig;
  /** Package install-record key whose record and shared directory are removed once. */
  pluginId: string;
  channelIds?: string[];
  deleteFiles?: boolean;
  extensionsDir?: string;
};

/**
 * Plan a plugin uninstall by removing it from config and resolving a safe file-removal target.
 * Linked path plugins never have their source directory deleted. Copied path installs still remove
 * their managed install directory.
 */
export function planPluginUninstall(params: UninstallPluginParams): PluginUninstallPlanResult {
  const { config, pluginId, channelIds, deleteFiles = true, extensionsDir } = params;
  const packagePlan = resolvePluginPackageUninstallPlan(params);
  const runtimePluginIds = packagePlan?.runtimePluginIds ?? [pluginId];

  const entries = config.plugins?.entries ?? {};
  const installs = config.plugins?.installs ?? {};
  const hasEntry = runtimePluginIds.some((entryId) => Object.hasOwn(entries, entryId));
  const hasInstall = Object.hasOwn(installs, pluginId);
  const installRecord = hasInstall ? installs[pluginId] : undefined;
  const isLinked = isLinkedPathInstallRecord(installRecord);

  // Package lifecycle removes every child policy while the owner record/directory is handled once.
  let newConfig = config;
  const configActions: PluginConfigUninstallActions = {
    entry: false,
    install: false,
    allowlist: false,
    denylist: false,
    loadPath: false,
    memorySlot: false,
    contextEngineSlot: false,
    channelConfig: false,
  };
  for (const configPluginId of new Set(runtimePluginIds)) {
    const removal = removePluginRuntimePolicyFromConfig(newConfig, configPluginId, {
      channelIds,
      loadPaths: packagePlan?.runtimeLoadPaths ? [...packagePlan.runtimeLoadPaths] : undefined,
    });
    newConfig = removal.config;
    for (const key of Object.keys(configActions) as Array<keyof PluginConfigUninstallActions>) {
      configActions[key] ||= removal.actions[key];
    }
  }
  const ownerRemoval = removePluginInstallOwnerFromConfig(newConfig, pluginId);
  newConfig = ownerRemoval.config;
  for (const key of Object.keys(configActions) as Array<keyof PluginConfigUninstallActions>) {
    configActions[key] ||= ownerRemoval.actions[key];
  }

  if (hasInstall && runtimePluginIds.length > 0) {
    // Preserve explicit uninstall intent so remaining provider/model references do not
    // make startup repair treat the now-missing package as required.
    newConfig = prepareConfigForDisabledPluginSet(newConfig, runtimePluginIds);
  }

  if (!hasEntry && !hasInstall && !hasUninstallAction(configActions)) {
    return { ok: false, error: `Plugin not found: ${pluginId}` };
  }

  const actions: UninstallActions = {
    ...configActions,
    directory: false,
  };

  const npmManagedInstall =
    deleteFiles && !isLinked
      ? resolveNpmManagedInstall({
          installRecord,
          extensionsDir,
        })
      : null;
  const gitManagedInstall =
    deleteFiles && !isLinked
      ? resolveGitManagedInstall({
          installRecord,
          extensionsDir,
        })
      : null;

  const deleteTarget =
    deleteFiles && !isLinked
      ? resolveUninstallDirectoryTarget({
          pluginId,
          hasInstall,
          installRecord,
          extensionsDir,
        })
      : null;

  return {
    ok: true,
    config: newConfig,
    pluginId,
    actions,
    directoryRemoval: deleteTarget
      ? {
          target: deleteTarget,
          ...(npmManagedInstall
            ? {
                cleanup: {
                  kind: "npm",
                  npmRoot: npmManagedInstall.npmRoot,
                  packageName: npmManagedInstall.packageName,
                  rootKind: npmManagedInstall.rootKind,
                },
              }
            : gitManagedInstall && deleteTarget === gitManagedInstall.installPath
              ? {
                  cleanup: {
                    kind: "git",
                    parentDir: gitManagedInstall.parentDir,
                  },
                }
              : {}),
        }
      : null,
  };
}

export function pluginUninstallTargetExists(target: string): boolean {
  return pathMayExistSync(target);
}

function isOwnedNpmRemoval(removal: PluginUninstallDirectoryRemoval): boolean {
  const cleanup = removal.cleanup;
  if (cleanup?.kind !== "npm") {
    return true;
  }
  const projectsDir = path.dirname(cleanup.npmRoot);
  const projectRoot = cleanup.rootKind === "isolated-project";
  if (projectRoot !== (path.basename(projectsDir) === "projects")) {
    return false;
  }
  const npmDir = projectRoot ? path.dirname(projectsDir) : cleanup.npmRoot;
  if (
    projectRoot
      ? !isPluginNpmManagedPath({ managedPath: cleanup.npmRoot, npmDir })
      : !pluginUninstallTargetExists(npmDir) ||
        !isPluginNpmManagedPath({ managedPath: npmDir, npmDir })
  ) {
    return false;
  }
  const manifestPath = path.join(cleanup.npmRoot, "package.json");
  if (
    pluginUninstallTargetExists(manifestPath) &&
    !isPluginNpmManagedPath({ managedPath: manifestPath, npmDir })
  ) {
    return false;
  }
  if (path.resolve(removal.target) === path.resolve(cleanup.npmRoot)) {
    return (
      projectRoot &&
      isPluginNpmProjectDir({
        npmDir,
        packageName: cleanup.packageName,
        projectDir: cleanup.npmRoot,
      })
    );
  }
  const expectedPackageDir = path.join(
    cleanup.npmRoot,
    "node_modules",
    ...cleanup.packageName.split("/"),
  );
  if (path.resolve(removal.target) !== path.resolve(expectedPackageDir)) {
    return false;
  }
  return (
    !pluginUninstallTargetExists(removal.target) ||
    isPluginNpmManagedPath({
      managedPath: removal.target,
      npmDir,
    })
  );
}

export async function applyPluginUninstallDirectoryRemoval(
  removal: PluginUninstallDirectoryRemoval | null,
): Promise<{ directoryRemoved: boolean; warnings: string[] }> {
  if (!removal) {
    return { directoryRemoved: false, warnings: [] };
  }

  const existed = pluginUninstallTargetExists(removal.target);
  const warnings: string[] = [];
  if (!existed && removal.cleanup?.kind !== "npm") {
    return { directoryRemoved: false, warnings };
  }

  const usesLegacySharedNpmRoot =
    removal.cleanup?.kind === "npm" && removal.cleanup.rootKind === "legacy-shared";
  const npmCleanupManifestPath =
    removal.cleanup?.kind === "npm" ? path.join(removal.cleanup.npmRoot, "package.json") : "";
  const npmCleanupManifestExists =
    removal.cleanup?.kind === "npm"
      ? await fs
          .access(npmCleanupManifestPath)
          .then(() => true)
          .catch(() => false)
      : false;

  if (!existed && removal.cleanup?.kind === "npm" && !npmCleanupManifestExists) {
    return { directoryRemoved: false, warnings };
  }

  const ownershipWarning = `Refused to remove npm path without canonical package ownership: ${removal.target}`;
  if (!isOwnedNpmRemoval(removal)) {
    return { directoryRemoved: false, warnings: [ownershipWarning] };
  }
  if (removal.cleanup?.kind === "npm" && npmCleanupManifestExists && usesLegacySharedNpmRoot) {
    const uninstall = await runCommandWithTimeout(
      [
        "npm",
        "uninstall",
        "--loglevel=error",
        "--legacy-peer-deps",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        removal.cleanup.packageName,
      ],
      {
        cwd: removal.cleanup.npmRoot,
        timeoutMs: 300_000,
        env: createSafeNpmInstallEnv(process.env, {
          legacyPeerDeps: true,
          npmConfigCwd: removal.cleanup.npmRoot,
          packageLock: true,
          quiet: true,
        }),
      },
    );
    if (uninstall.code !== 0) {
      warnings.push(
        `Failed to prune npm dependencies for plugin package ${removal.cleanup.packageName}: ${
          uninstall.stderr.trim() ||
          uninstall.stdout.trim() ||
          `npm exited with code ${uninstall.code}`
        }`,
      );
    }
    try {
      const managedOverrides = await readOpenClawManagedNpmRootOverrides();
      const warning = await pruneManagedNpmPeerDependenciesAfterUninstall({
        npmRoot: removal.cleanup.npmRoot,
        packageName: removal.cleanup.packageName,
        managedOverrides,
      });
      if (warning) {
        warnings.push(warning);
      }
    } catch (error) {
      warnings.push(
        `Failed to sync managed peer dependencies after uninstalling ${removal.cleanup.packageName}: ${formatErrorMessage(error)}`,
      );
    }
    try {
      await relinkOpenClawPeerDependenciesInManagedNpmRoot({
        npmRoot: removal.cleanup.npmRoot,
        logger: {
          warn: (message) => warnings.push(message),
        },
      });
    } catch (error) {
      warnings.push(
        `Failed to repair managed npm peer links after uninstalling ${removal.cleanup.packageName}: ${formatErrorMessage(error)}`,
      );
    }
  }
  if (!isOwnedNpmRemoval(removal) && pluginUninstallTargetExists(removal.target)) {
    return { directoryRemoved: false, warnings: [...warnings, ownershipWarning] };
  }
  try {
    await fs.rm(removal.target, { recursive: true, force: true });
    if (removal.cleanup?.kind === "git") {
      try {
        await fs.rmdir(removal.cleanup.parentDir);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY") {
          warnings.push(
            `Failed to remove empty git plugin install parent ${removal.cleanup.parentDir}: ${formatErrorMessage(error)}`,
          );
        }
      }
    }
    return { directoryRemoved: existed, warnings };
  } catch (error) {
    return {
      directoryRemoved: false,
      warnings: [
        ...warnings,
        `Failed to remove plugin directory ${removal.target}: ${formatErrorMessage(error)}`,
      ],
    };
  }
}
