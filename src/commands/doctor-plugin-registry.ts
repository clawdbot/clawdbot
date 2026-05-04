import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { saveJsonFile } from "../infra/json-file.js";
import { resolveDefaultPluginNpmDir } from "../plugins/install-paths.js";
import type { InstalledPluginIndexRecordStoreOptions } from "../plugins/installed-plugin-index-records.js";
import { loadInstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { refreshPluginRegistry } from "../plugins/plugin-registry.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import {
  DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV,
  migratePluginRegistryForInstall,
  preflightPluginRegistryInstallMigration,
  type PluginRegistryInstallMigrationParams,
} from "./doctor/shared/plugin-registry-migration.js";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
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
  const npmRoot = params.stateDir
    ? path.join(params.stateDir, "npm")
    : resolveDefaultPluginNpmDir(params.env);
  const npmPackageJsonPath = path.join(npmRoot, "package.json");
  const dependencies = readStringMap(readJsonObject(npmPackageJsonPath)?.dependencies);
  const stale: StaleManagedNpmBundledPlugin[] = [];

  for (const packageName of Object.keys(dependencies).toSorted()) {
    if (!packageName.startsWith("@openclaw/")) {
      continue;
    }
    const bundled = bundledByPackage.get(packageName);
    if (!bundled) {
      continue;
    }
    const packageDir = path.join(npmRoot, "node_modules", packageName);
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

  return stale;
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
  const removedStaleManagedNpmBundledPlugins = maybeRepairStaleManagedNpmBundledPlugins(params);
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
    const result = await migratePluginRegistryForInstall(migrationParams);
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

  if (preflight.action === "skip-existing" || removedStaleManagedNpmBundledPlugins) {
    const index = await refreshPluginRegistry({
      ...migrationParams,
      reason: "migration",
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
