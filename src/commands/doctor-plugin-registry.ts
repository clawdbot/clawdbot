/** Doctor repairs for stale plugin registry entries, managed npm shadows, and peer links. */
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding, HealthRepairEffect } from "../flows/health-checks.js";
import { saveJsonFile } from "../infra/json-file.js";
import { tryReadJsonSync } from "../infra/json-files.js";
import type { BundledPluginSource } from "../plugins/bundled-sources.js";
import { resolveDefaultPluginNpmDir } from "../plugins/install-paths.js";
import {
  loadInstalledPluginIndexInstallRecords,
  type InstalledPluginIndexRecordStoreOptions,
} from "../plugins/installed-plugin-index-records.js";
import { loadInstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { hasRetainedManagedNpmInstallMarker } from "../plugins/managed-npm-retention.js";
import { listManagedPluginNpmRootsSync } from "../plugins/npm-project-roots.js";
import {
  auditOpenClawPeerDependenciesInManagedNpmRoot,
  type OpenClawPeerLinkAuditIssue,
  relinkOpenClawPeerDependenciesInManagedNpmRoot,
} from "../plugins/plugin-peer-link.js";
import { refreshPluginRegistry } from "../plugins/plugin-registry.js";
import {
  listStaleLocalBundledPluginInstallRecords,
  type StaleLocalBundledPluginInstallRecord,
} from "../plugins/stale-local-bundled-plugin-install-records.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import {
  DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV,
  migratePluginRegistryForInstall,
  preflightPluginRegistryInstallMigration,
  type PluginRegistryInstallMigrationParams,
} from "./doctor/shared/plugin-registry-migration.js";

const PLUGIN_REGISTRY_CHECK_ID = "core/doctor/plugin-registry";

type PluginRegistryDoctorRepairParams = Omit<PluginRegistryInstallMigrationParams, "config"> &
  InstalledPluginIndexRecordStoreOptions & {
    config: OpenClawConfig;
    prompter: Pick<DoctorPrompter, "shouldRepair">;
  };

type StaleManagedNpmBundledPlugin = {
  pluginId: string;
  packageName: string;
  packageDir: string;
  npmRoot: string;
  version?: string;
};

type PluginRegistryDoctorNoteLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
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
      kind: "managed-npm-package-unreadable";
      packageDir: string;
      reason: string;
    };

type ManagedNpmPackageReadFailure = {
  packageDir: string;
  reason: string;
};

function formatPackageReadFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

function resolveManagedPluginNpmRoot(params: PluginRegistryDoctorRepairParams): string {
  return params.stateDir
    ? path.join(params.stateDir, "npm")
    : resolveDefaultPluginNpmDir(params.env);
}

function listManagedPluginNpmRoots(params: PluginRegistryDoctorRepairParams): string[] {
  return listManagedPluginNpmRootsSync(resolveManagedPluginNpmRoot(params));
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

  for (const npmRoot of listManagedPluginNpmRoots(params)) {
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
  saveJsonFile(npmPackageJsonPath, nextPackageJson);
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
    saveJsonFile(packageLockPath, packageLock);
  }
}

/** Removes managed npm packages that shadow current bundled plugins when repair is enabled. */
export function maybeRepairStaleManagedNpmBundledPlugins(
  params: PluginRegistryDoctorRepairParams,
): boolean {
  const stale = listStaleManagedNpmBundledPlugins(params);
  if (stale.length === 0) {
    return false;
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
    return false;
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
  return true;
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

/** Relinks managed npm plugin packages to the current OpenClaw host packages. */
export async function maybeRepairManagedNpmOpenClawPeerLinks(
  params: PluginRegistryDoctorRepairParams,
): Promise<boolean> {
  const npmRoots = listManagedPluginNpmRoots(params);
  if (!params.prompter.shouldRepair) {
    const packageReadFailures: ManagedNpmPackageReadFailure[] = [];
    const audits = await Promise.all(
      npmRoots.map((npmRoot) =>
        auditOpenClawPeerDependenciesInManagedNpmRoot({
          npmRoot,
          onPackageReadError: (error, packageDir) => {
            packageReadFailures.push({
              packageDir,
              reason: formatPackageReadFailure(error),
            });
          },
        }),
      ),
    );
    const issues = audits.flatMap((audit) => audit.issues);
    if (issues.length > 0) {
      note(
        [
          "Managed npm OpenClaw host peer links need repair:",
          ...issues.map((issue) => `- ${issue.packageName}: ${issue.reason}`),
          `Repair with ${formatCliCommand("openclaw doctor --fix")} to relink managed npm plugin packages.`,
        ].join("\n"),
        "Plugin registry",
      );
    }
    if (packageReadFailures.length > 0) {
      note(
        [
          "Managed npm plugin packages could not be inspected:",
          ...packageReadFailures.map(
            (failure) => `- ${shortenHomePath(failure.packageDir)}: ${failure.reason}`,
          ),
        ].join("\n"),
        "Plugin registry",
      );
    }
    return false;
  }

  const messages: { level: "info" | "warn"; message: string }[] = [];
  const logger: PluginRegistryDoctorNoteLogger = {
    info: (message) => messages.push({ level: "info", message }),
    warn: (message) => messages.push({ level: "warn", message }),
  };
  const results = await Promise.all(
    npmRoots.map((npmRoot) =>
      relinkOpenClawPeerDependenciesInManagedNpmRoot({
        npmRoot,
        logger,
        onPackageReadError: (error, packageDir) => {
          logger.warn(
            `Could not inspect managed npm package ${shortenHomePath(packageDir)}: ${formatPackageReadFailure(error)}`,
          );
        },
      }),
    ),
  );
  const repaired = results.reduce((total, result) => total + result.repaired, 0);

  if (repaired > 0) {
    note(
      `Repaired OpenClaw host peer link(s) for ${repaired} managed npm plugin package(s).`,
      "Plugin registry",
    );
  }
  const warnings = messages
    .filter((message) => message.level === "warn")
    .map((message) => `- ${message.message}`);
  if (warnings.length > 0) {
    note(
      ["Could not repair all managed npm OpenClaw host peer links:", ...warnings].join("\n"),
      "Plugin registry",
    );
  }

  return repaired > 0;
}

async function loadInstallRecordsWithoutPluginIds(
  params: PluginRegistryDoctorRepairParams,
  pluginIds: readonly string[],
) {
  const records = await loadInstalledPluginIndexInstallRecords(params);
  for (const pluginId of pluginIds) {
    delete records[pluginId];
  }
  return records;
}

async function listManagedNpmOpenClawPeerLinkIssues(
  params: PluginRegistryDoctorRepairParams,
): Promise<{
  peerLinkIssues: OpenClawPeerLinkAuditIssue[];
  packageReadFailures: ManagedNpmPackageReadFailure[];
}> {
  const packageReadFailures: ManagedNpmPackageReadFailure[] = [];
  const audits = await Promise.all(
    listManagedPluginNpmRoots(params).map((npmRoot) =>
      auditOpenClawPeerDependenciesInManagedNpmRoot({
        npmRoot,
        onPackageReadError: (error, packageDir) => {
          packageReadFailures.push({
            packageDir,
            reason: formatPackageReadFailure(error),
          });
        },
      }),
    ),
  );
  return {
    peerLinkIssues: audits.flatMap((audit) => audit.issues),
    packageReadFailures,
  };
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
  const managedNpmAudit = await listManagedNpmOpenClawPeerLinkIssues(params);
  for (const issue of managedNpmAudit.peerLinkIssues) {
    issues.push({
      kind: "managed-npm-openclaw-peer-link",
      packageName: issue.packageName,
      packageDir: issue.packageDir,
      reason: issue.reason,
    });
  }
  for (const failure of managedNpmAudit.packageReadFailures) {
    issues.push({
      kind: "managed-npm-package-unreadable",
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
    case "managed-npm-package-unreadable":
      return {
        checkId: PLUGIN_REGISTRY_CHECK_ID,
        severity: "warning",
        message: `Managed npm package could not be inspected: ${issue.reason}.`,
        path: issue.packageDir,
        fixHint: "Restore access to the package files, then run `openclaw doctor` again.",
      };
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
    case "managed-npm-package-unreadable":
      return {
        kind: "package",
        action: "requires-managed-npm-package-readability-repair",
        target: issue.packageDir,
        dryRunSafe: false,
      };
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
): Promise<OpenClawConfig> {
  const preflight = preflightPluginRegistryInstallMigration(params);
  for (const warning of preflight.deprecationWarnings) {
    note(warning, "Plugin registry");
  }
  if (preflight.action === "disabled") {
    note(
      `${DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV} is set; skipping plugin registry repair.`,
      "Plugin registry",
    );
    return params.config;
  }

  const migrationParams = {
    ...params,
    config: params.config,
  };
  const staleManagedNpmBundledPluginIds = listStaleManagedNpmBundledPlugins(params).map(
    (plugin) => plugin.pluginId,
  );
  const removedStaleManagedNpmBundledPlugins = maybeRepairStaleManagedNpmBundledPlugins(params);
  const removedStaleLocalBundledPluginIds =
    await maybeRepairStaleLocalBundledPluginInstallRecords(params);
  const repairedManagedNpmOpenClawPeerLinks = await maybeRepairManagedNpmOpenClawPeerLinks(params);
  const stalePluginIdsToRemove = [
    ...new Set([
      ...(removedStaleManagedNpmBundledPlugins ? staleManagedNpmBundledPluginIds : []),
      ...removedStaleLocalBundledPluginIds,
    ]),
  ];
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
    return params.config;
  }

  if (preflight.action === "migrate") {
    const result = await migratePluginRegistryForInstall({
      ...migrationParams,
      ...(stalePluginIdsToRemove.length > 0
        ? {
            installRecords: await loadInstallRecordsWithoutPluginIds(
              params,
              stalePluginIdsToRemove,
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
    return params.config;
  }

  if (
    preflight.action === "skip-existing" ||
    removedStaleManagedNpmBundledPlugins ||
    removedStaleLocalBundledPluginIds.length > 0 ||
    repairedManagedNpmOpenClawPeerLinks
  ) {
    const index = await refreshPluginRegistry({
      ...migrationParams,
      reason: "migration",
      ...(stalePluginIdsToRemove.length > 0
        ? {
            installRecords: await loadInstallRecordsWithoutPluginIds(
              params,
              stalePluginIdsToRemove,
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
  }

  return params.config;
}
