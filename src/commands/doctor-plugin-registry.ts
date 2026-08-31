/** Doctor repairs for stale plugin registry entries, managed npm shadows, and peer links. */
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { HealthFinding, HealthRepairEffect } from "../flows/health-checks.js";
import { writeJsonTarget } from "../infra/json-file.js";
import { tryReadJsonSync } from "../infra/json-files.js";
import type { BundledPluginSource } from "../plugins/bundled-sources.js";
import {
  loadInstalledPluginIndexInstallRecords,
  loadInstalledPluginIndexInstallRecordsSync,
  removePluginInstallRecordFromRecords,
  type InstalledPluginIndexRecordStoreOptions,
} from "../plugins/installed-plugin-index-records.js";
import { loadInstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { hasRetainedManagedNpmInstallMarker } from "../plugins/managed-npm-retention.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import { refreshPluginRegistry } from "../plugins/plugin-registry-refresh.js";
import {
  listStaleLocalBundledPluginInstallRecords,
  type StaleLocalBundledPluginInstallRecord,
} from "../plugins/stale-local-bundled-plugin-install-records.js";
import { shortenHomePath } from "../utils.js";
import {
  listStaleManagedNpmInstallGenerations,
  maybeRepairStaleManagedNpmInstallGenerations,
  PLUGIN_REGISTRY_CHECK_ID,
  staleManagedNpmInstallGenerationToHealthFinding,
  staleManagedNpmInstallGenerationToRepairEffect,
  type StaleManagedNpmInstallGenerationIssue,
} from "./doctor-plugin-generations.js";
import {
  resolveDoctorPluginNpmRoots,
  listPluginOpenClawHostLinkIssues,
  maybeRepairPluginOpenClawHostLinks,
} from "./doctor-plugin-host-links.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import {
  InvalidPluginInstallRecordStateError,
  migratePluginRegistryForInstall,
  preflightPluginRegistryInstallMigration,
  type PluginRegistryInstallMigrationParams,
} from "./doctor/shared/plugin-registry-migration.js";

type PluginRegistryDoctorRepairParams = Omit<PluginRegistryInstallMigrationParams, "config"> &
  InstalledPluginIndexRecordStoreOptions & {
    config: OpenClawConfig;
    prompter: Pick<DoctorPrompter, "shouldRepair">;
  };

type PluginRegistryDoctorRepairResult = {
  config: OpenClawConfig;
  pluginInventoryChanged?: true;
};

type StaleManagedNpmBundledPlugin = {
  pluginId: string;
  packageName: string;
  packageDir: string;
  npmRoot: string;
  version?: string;
};

type StaleManagedNpmBundledPluginRepairResult = {
  installRecords: Record<string, PluginInstallRecord>;
  removedPluginIds: string[];
};

type PluginRegistryHealthIssue =
  | {
      kind: "registry-missing-or-stale";
      path: string;
    }
  | {
      kind: "stale-managed-npm-bundled-plugin";
      pluginId: string;
      packageName: string;
      packageDir: string;
      npmRoot: string;
      version?: string;
    }
  | {
      kind: "stale-local-bundled-plugin-install-record";
      pluginId: string;
      stalePath: string;
    }
  | {
      kind: "managed-npm-openclaw-peer-link";
      packageName: string;
      packageDir: string;
      reason: string;
    }
  | {
      kind: "registered-npm-openclaw-host-link";
      packageName: string;
      packageDir: string;
      reason: string;
    }
  | {
      kind: "managed-npm-package-unreadable";
      packageDir: string;
      reason: string;
    }
  | {
      kind: "registered-npm-package-unreadable";
      packageDir: string;
      reason: string;
    }
  | StaleManagedNpmInstallGenerationIssue;

function readJsonObject(filePath: string): Record<string, unknown> | null {
  const parsed = tryReadJsonSync(filePath);
  return isRecord(parsed) ? parsed : null;
}

function readStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string" && raw.trim()) {
      result[key] = raw.trim();
    }
  }
  return result;
}

function deleteObjectKey(record: Record<string, unknown>, key: string): boolean {
  if (!Object.hasOwn(record, key)) {
    return false;
  }
  delete record[key];
  return true;
}

function readPackageVersion(packageDir: string): string | undefined {
  const packageJson = readJsonObject(path.join(packageDir, "package.json"));
  const version = packageJson?.version;
  return typeof version === "string" && version.trim() ? version.trim() : undefined;
}

function readPluginManifestId(packageDir: string): string | undefined {
  const manifest = readJsonObject(path.join(packageDir, "openclaw.plugin.json"));
  const id = manifest?.id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function listStaleManagedNpmBundledPlugins(
  params: PluginRegistryDoctorRepairParams,
): StaleManagedNpmBundledPlugin[] {
  const currentBundled = loadInstalledPluginIndex({
    ...params,
    installRecords: {},
  }).plugins.filter((plugin) => plugin.origin === "bundled" && plugin.packageName);
  const bundledByPackage = new Map(
    currentBundled.map((plugin) => [plugin.packageName, plugin] as const),
  );
  const stale: StaleManagedNpmBundledPlugin[] = [];

  for (const npmRoot of resolveDoctorPluginNpmRoots(params)) {
    const npmPackageJsonPath = path.join(npmRoot, "package.json");
    const dependencies = readStringMap(readJsonObject(npmPackageJsonPath)?.dependencies);
    for (const packageName of Object.keys(dependencies).toSorted((left, right) =>
      left.localeCompare(right),
    )) {
      if (!packageName.startsWith("@openclaw/")) {
        continue;
      }
      const bundled = bundledByPackage.get(packageName);
      if (!bundled) {
        continue;
      }
      const packageDir = path.join(npmRoot, "node_modules", ...packageName.split("/"));
      if (hasRetainedManagedNpmInstallMarker(packageDir)) {
        continue;
      }
      const pluginId = readPluginManifestId(packageDir);
      if (!pluginId || pluginId !== bundled.pluginId) {
        continue;
      }
      stale.push({
        pluginId,
        packageName,
        packageDir,
        npmRoot,
        ...(readPackageVersion(packageDir) ? { version: readPackageVersion(packageDir) } : {}),
      });
    }
  }

  return stale;
}

function loadCurrentBundledPluginSources(
  params: PluginRegistryDoctorRepairParams,
): Map<string, BundledPluginSource> {
  const currentBundled = loadInstalledPluginIndex({
    ...params,
    installRecords: {},
  }).plugins.filter((plugin) => plugin.origin === "bundled");
  return new Map(
    currentBundled.map(
      (plugin) =>
        [
          plugin.pluginId,
          {
            pluginId: plugin.pluginId,
            localPath: plugin.rootDir,
            ...(plugin.packageName ? { npmSpec: plugin.packageName } : {}),
            ...(plugin.packageVersion ? { version: plugin.packageVersion } : {}),
          },
        ] as const,
    ),
  );
}

async function listStaleLocalBundledPluginInstallRecordShadows(
  params: PluginRegistryDoctorRepairParams,
): Promise<StaleLocalBundledPluginInstallRecord[]> {
  return listStaleLocalBundledPluginInstallRecords({
    installRecords: await loadInstalledPluginIndexInstallRecords(params),
    workspaceDir: params.workspaceDir,
    env: params.env,
    bundled: loadCurrentBundledPluginSources(params),
  });
}

function removeManagedNpmDependency(params: {
  npmRoot: string;
  packageName: string;
  packageDir: string;
}): void {
  const npmPackageJsonPath = path.join(params.npmRoot, "package.json");
  const packageJson = readJsonObject(npmPackageJsonPath) ?? {};
  const dependencies = readStringMap(packageJson.dependencies);
  delete dependencies[params.packageName];
  const nextPackageJson =
    Object.keys(dependencies).length === 0
      ? (() => {
          const { dependencies: _dependencies, ...rest } = packageJson;
          return rest;
        })()
      : {
          ...packageJson,
          dependencies,
        };
  writeJsonTarget(npmPackageJsonPath, nextPackageJson);
  removeManagedNpmPackageLockDependency(params);
  fs.rmSync(params.packageDir, { recursive: true, force: true });
  const scopeDir = path.dirname(params.packageDir);
  if (path.basename(path.dirname(scopeDir)) === "node_modules") {
    try {
      fs.rmdirSync(scopeDir);
    } catch {
      // Other packages can still live under the scope directory.
    }
  }
}

function removeManagedNpmPackageLockDependency(params: {
  npmRoot: string;
  packageName: string;
}): void {
  const packageLockPath = path.join(params.npmRoot, "package-lock.json");
  const packageLock = readJsonObject(packageLockPath);
  if (!packageLock) {
    return;
  }

  let changed = false;
  const packages = packageLock.packages;
  if (isRecord(packages)) {
    const rootPackage = packages[""];
    if (isRecord(rootPackage)) {
      const rootDependencies = readStringMap(rootPackage.dependencies);
      if (deleteObjectKey(rootDependencies, params.packageName)) {
        changed = true;
        if (Object.keys(rootDependencies).length === 0) {
          delete rootPackage.dependencies;
        } else {
          rootPackage.dependencies = rootDependencies;
        }
      }
    }
    changed = deleteObjectKey(packages, `node_modules/${params.packageName}`) || changed;
  }

  const dependencies = packageLock.dependencies;
  if (isRecord(dependencies)) {
    changed = deleteObjectKey(dependencies, params.packageName) || changed;
  }

  if (changed) {
    writeJsonTarget(packageLockPath, packageLock);
  }
}

/** Removes managed npm packages that shadow current bundled plugins when repair is enabled. */
export function maybeRepairStaleManagedNpmBundledPlugins(
  params: PluginRegistryDoctorRepairParams & {
    installRecords?: Record<string, PluginInstallRecord>;
  },
): StaleManagedNpmBundledPluginRepairResult | null {
  const stale = listStaleManagedNpmBundledPlugins(params);
  if (stale.length === 0) {
    return null;
  }

  if (!params.prompter.shouldRepair) {
    note(
      [
        "Managed npm plugin packages shadow bundled plugins:",
        ...stale.map(
          (plugin) =>
            `- ${plugin.pluginId}: ${plugin.packageName}${plugin.version ? `@${plugin.version}` : ""}`,
        ),
        `Repair with ${formatCliCommand("openclaw doctor --fix")} to remove stale managed npm packages and rebuild the plugin registry.`,
      ].join("\n"),
      "Plugin registry",
    );
    return null;
  }

  // Capture one authoritative record baseline before deleting the payload. Later readers recover
  // managed records from disk, so package-only cleanup can otherwise resurrect the same install.
  let installRecords = params.installRecords ?? loadInstalledPluginIndexInstallRecordsSync(params);
  const removedPluginIds = [...new Set(stale.map((plugin) => plugin.pluginId))].toSorted(
    (left, right) => left.localeCompare(right),
  );
  for (const pluginId of removedPluginIds) {
    installRecords = removePluginInstallRecordFromRecords(installRecords, pluginId);
  }
  for (const plugin of stale) {
    removeManagedNpmDependency(plugin);
  }
  note(
    [
      "Removed stale managed npm plugin package(s) shadowing bundled plugins:",
      ...stale.map(
        (plugin) =>
          `- ${plugin.pluginId}: ${plugin.packageName}${plugin.version ? `@${plugin.version}` : ""}`,
      ),
    ].join("\n"),
    "Plugin registry",
  );
  return { installRecords, removedPluginIds };
}

/** Removes local install records that shadow current bundled plugin sources. */
async function maybeRepairStaleLocalBundledPluginInstallRecords(
  params: PluginRegistryDoctorRepairParams,
): Promise<string[]> {
  const stale = await listStaleLocalBundledPluginInstallRecordShadows(params);
  if (stale.length === 0) {
    return [];
  }

  if (!params.prompter.shouldRepair) {
    note(
      [
        "Local bundled plugin install records shadow bundled plugins:",
        ...stale.map((record) => `- ${record.pluginId}: ${shortenHomePath(record.stalePath)}`),
        `Repair with ${formatCliCommand("openclaw doctor --fix")} to remove stale local install records and rebuild the plugin registry.`,
      ].join("\n"),
      "Plugin registry",
    );
    return [];
  }

  note(
    [
      "Removed stale local bundled plugin install record(s) shadowing bundled plugins:",
      ...stale.map((record) => `- ${record.pluginId}: ${shortenHomePath(record.stalePath)}`),
    ].join("\n"),
    "Plugin registry",
  );
  return stale.map((record) => record.pluginId);
}

async function loadInstallRecordsWithoutPluginIds(
  params: PluginRegistryDoctorRepairParams,
  pluginIds: readonly string[],
  baselineRecords?: Record<string, PluginInstallRecord>,
) {
  let records = baselineRecords ?? (await loadInstalledPluginIndexInstallRecords(params));
  for (const pluginId of pluginIds) {
    records = removePluginInstallRecordFromRecords(records, pluginId);
  }
  return records;
}

export async function detectPluginRegistryHealthIssues(
  params: PluginRegistryDoctorRepairParams,
): Promise<PluginRegistryHealthIssue[]> {
  const preflight = preflightPluginRegistryInstallMigration(params);
  const issues: PluginRegistryHealthIssue[] = [];
  if (preflight.action === "migrate") {
    issues.push({
      kind: "registry-missing-or-stale",
      path: preflight.filePath,
    });
  }
  for (const plugin of listStaleManagedNpmBundledPlugins(params)) {
    issues.push({
      kind: "stale-managed-npm-bundled-plugin",
      pluginId: plugin.pluginId,
      packageName: plugin.packageName,
      packageDir: plugin.packageDir,
      npmRoot: plugin.npmRoot,
      ...(plugin.version ? { version: plugin.version } : {}),
    });
  }
  for (const record of await listStaleLocalBundledPluginInstallRecordShadows(params)) {
    issues.push({
      kind: "stale-local-bundled-plugin-install-record",
      pluginId: record.pluginId,
      stalePath: record.stalePath,
    });
  }
  issues.push(...(await listStaleManagedNpmInstallGenerations(params)));
  const hostLinkAudit = await listPluginOpenClawHostLinkIssues(params);
  for (const issue of hostLinkAudit.peerLinkIssues) {
    issues.push({
      kind: "managed-npm-openclaw-peer-link",
      packageName: issue.packageName,
      packageDir: issue.packageDir,
      reason: issue.reason,
    });
  }
  for (const failure of hostLinkAudit.packageReadFailures) {
    issues.push({
      kind: "managed-npm-package-unreadable",
      packageDir: failure.packageDir,
      reason: failure.reason,
    });
  }
  for (const issue of hostLinkAudit.registeredPeerLinkIssues) {
    issues.push({
      kind: "registered-npm-openclaw-host-link",
      packageName: issue.packageName,
      packageDir: issue.packageDir,
      reason: issue.reason,
    });
  }
  for (const failure of hostLinkAudit.registeredPackageReadFailures) {
    issues.push({
      kind: "registered-npm-package-unreadable",
      packageDir: failure.packageDir,
      reason: failure.reason,
    });
  }
  return issues;
}

export function pluginRegistryIssueToHealthFinding(
  issue: PluginRegistryHealthIssue,
): HealthFinding {
  switch (issue.kind) {
    case "registry-missing-or-stale":
      return {
        checkId: PLUGIN_REGISTRY_CHECK_ID,
        severity: "warning",
        message: "Persisted plugin registry is missing or stale.",
        path: issue.path,
        fixHint: "Run `openclaw doctor --fix` to rebuild the plugin registry from enabled plugins.",
      };
    case "stale-managed-npm-bundled-plugin":
      return {
        checkId: PLUGIN_REGISTRY_CHECK_ID,
        severity: "warning",
        message: `Managed npm package ${issue.packageName}${
          issue.version ? `@${issue.version}` : ""
        } shadows bundled plugin ${issue.pluginId}.`,
        path: issue.packageDir,
        target: issue.pluginId,
        fixHint:
          "Run `openclaw doctor --fix` to remove stale managed npm packages and rebuild the plugin registry.",
      };
    case "stale-local-bundled-plugin-install-record":
      return {
        checkId: PLUGIN_REGISTRY_CHECK_ID,
        severity: "warning",
        message: `Local install record for bundled plugin ${issue.pluginId} points at a stale path.`,
        path: issue.stalePath,
        target: issue.pluginId,
        fixHint:
          "Run `openclaw doctor --fix` to remove stale local install records and rebuild the plugin registry.",
      };
    case "managed-npm-openclaw-peer-link":
      return {
        checkId: PLUGIN_REGISTRY_CHECK_ID,
        severity: "warning",
        message: `Managed npm package ${issue.packageName} has a broken OpenClaw peer link: ${issue.reason}.`,
        path: issue.packageDir,
        target: issue.packageName,
        fixHint: "Run `openclaw doctor --fix` to relink managed npm plugin packages.",
      };
    case "registered-npm-openclaw-host-link":
      return {
        checkId: PLUGIN_REGISTRY_CHECK_ID,
        severity: "warning",
        message: `Registered npm plugin ${issue.packageName} has a broken OpenClaw host link: ${issue.reason}.`,
        path: issue.packageDir,
        target: issue.packageName,
        fixHint: "Run `openclaw doctor --fix` to relink the installed npm plugin package.",
      };
    case "managed-npm-package-unreadable":
      return {
        checkId: PLUGIN_REGISTRY_CHECK_ID,
        severity: "warning",
        message: `Managed npm package could not be inspected: ${issue.reason}.`,
        path: issue.packageDir,
        fixHint: "Restore access to the package files, then run `openclaw doctor` again.",
      };
    case "registered-npm-package-unreadable":
      return {
        checkId: PLUGIN_REGISTRY_CHECK_ID,
        severity: "warning",
        message: `Registered npm plugin package could not be inspected: ${issue.reason}.`,
        path: issue.packageDir,
        fixHint: "Restore access to the package files, then run `openclaw doctor` again.",
      };
    case "stale-managed-npm-install-generation":
      return staleManagedNpmInstallGenerationToHealthFinding(issue);
  }
  return assertNeverPluginRegistryIssue(issue);
}

export function pluginRegistryIssueToRepairEffect(
  issue: PluginRegistryHealthIssue,
): HealthRepairEffect {
  switch (issue.kind) {
    case "registry-missing-or-stale":
      return {
        kind: "state",
        action: "would-rebuild-plugin-registry",
        target: issue.path,
        dryRunSafe: false,
      };
    case "stale-managed-npm-bundled-plugin":
      return {
        kind: "package",
        action: "would-remove-stale-managed-npm-bundled-plugin",
        target: issue.packageDir,
        dryRunSafe: false,
      };
    case "stale-local-bundled-plugin-install-record":
      return {
        kind: "state",
        action: "would-remove-stale-local-bundled-plugin-install-record",
        target: issue.pluginId,
        dryRunSafe: false,
      };
    case "managed-npm-openclaw-peer-link":
      return {
        kind: "package",
        action: "would-relink-managed-npm-openclaw-peer",
        target: issue.packageDir,
        dryRunSafe: false,
      };
    case "registered-npm-openclaw-host-link":
      return {
        kind: "package",
        action: "would-relink-registered-npm-openclaw-host",
        target: issue.packageDir,
        dryRunSafe: false,
      };
    case "managed-npm-package-unreadable":
      return {
        kind: "package",
        action: "requires-managed-npm-package-readability-repair",
        target: issue.packageDir,
        dryRunSafe: false,
      };
    case "registered-npm-package-unreadable":
      return {
        kind: "package",
        action: "requires-registered-npm-package-readability-repair",
        target: issue.packageDir,
        dryRunSafe: false,
      };
    case "stale-managed-npm-install-generation":
      return staleManagedNpmInstallGenerationToRepairEffect(issue);
  }
  return assertNeverPluginRegistryIssue(issue);
}

function assertNeverPluginRegistryIssue(issue: never): never {
  throw new Error(
    `Unhandled plugin registry issue kind: ${String((issue as { kind?: unknown }).kind)}`,
  );
}

/**
 * Runs plugin registry doctor repairs and refreshes the persisted plugin index when needed.
 *
 * Stale bundled shadows are removed before registry migration so the rebuilt index resolves the
 * current bundled source instead of an obsolete managed/local install record.
 */
export async function maybeRepairPluginRegistryState(
  params: PluginRegistryDoctorRepairParams,
): Promise<PluginRegistryDoctorRepairResult> {
  let preflight: ReturnType<typeof preflightPluginRegistryInstallMigration>;
  try {
    preflight = preflightPluginRegistryInstallMigration(params);
  } catch (error) {
    if (!(error instanceof InvalidPluginInstallRecordStateError)) {
      throw error;
    }
    note(error.message, "Plugin registry");
    return { config: params.config };
  }

  const migrationParams = {
    ...params,
    config: params.config,
  };
  const staleManagedNpmBundledPluginRepair = maybeRepairStaleManagedNpmBundledPlugins(params);
  const removedStaleLocalBundledPluginIds =
    await maybeRepairStaleLocalBundledPluginInstallRecords(params);
  const retiredStaleManagedNpmInstallGenerations =
    await maybeRepairStaleManagedNpmInstallGenerations(params);
  const repairedPluginOpenClawHostLinks = await maybeRepairPluginOpenClawHostLinks(params);
  const stalePluginIdsToRemove = [
    ...new Set([
      ...(staleManagedNpmBundledPluginRepair?.removedPluginIds ?? []),
      ...removedStaleLocalBundledPluginIds,
    ]),
  ];
  const shouldPersistRepairedInstallRecords =
    stalePluginIdsToRemove.length > 0 || retiredStaleManagedNpmInstallGenerations;
  if (!params.prompter.shouldRepair) {
    if (preflight.action === "migrate") {
      note(
        [
          "Persisted plugin registry is missing or stale.",
          `Repair with ${formatCliCommand("openclaw doctor --fix")} to rebuild ${shortenHomePath(preflight.filePath)} from enabled plugins.`,
        ].join("\n"),
        "Plugin registry",
      );
    }
    return { config: params.config };
  }

  if (preflight.action !== "skip-existing") {
    const result = await migratePluginRegistryForInstall({
      ...migrationParams,
      ...(shouldPersistRepairedInstallRecords
        ? {
            installRecords: await loadInstallRecordsWithoutPluginIds(
              params,
              stalePluginIdsToRemove,
              staleManagedNpmBundledPluginRepair?.installRecords,
            ),
          }
        : {}),
    });
    if (result.migrated) {
      const total = result.current.plugins.length;
      const enabled = result.current.plugins.filter((plugin) => plugin.enabled).length;
      note(
        `Plugin registry rebuilt: ${enabled}/${total} enabled plugins indexed.`,
        "Plugin registry",
      );
    }
    return {
      config: params.config,
      ...(result.migrated ? { pluginInventoryChanged: true as const } : {}),
    };
  }

  if (
    preflight.action === "skip-existing" ||
    staleManagedNpmBundledPluginRepair ||
    removedStaleLocalBundledPluginIds.length > 0 ||
    retiredStaleManagedNpmInstallGenerations ||
    repairedPluginOpenClawHostLinks
  ) {
    const index = await refreshPluginRegistry({
      ...migrationParams,
      reason: "migration",
      ...(shouldPersistRepairedInstallRecords
        ? {
            installRecords: await loadInstallRecordsWithoutPluginIds(
              params,
              stalePluginIdsToRemove,
              staleManagedNpmBundledPluginRepair?.installRecords,
            ),
          }
        : {}),
    });
    const total = index.plugins.length;
    const enabled = index.plugins.filter((plugin) => plugin.enabled).length;
    note(
      `Plugin registry refreshed: ${enabled}/${total} enabled plugins indexed.`,
      "Plugin registry",
    );
    const indexChanged =
      resolveInstalledManifestRegistryIndexFingerprint(preflight.current) !==
      resolveInstalledManifestRegistryIndexFingerprint(index);
    return {
      config: params.config,
      ...(indexChanged || repairedPluginOpenClawHostLinks
        ? { pluginInventoryChanged: true as const }
        : {}),
    };
  }

  return { config: params.config };
}
