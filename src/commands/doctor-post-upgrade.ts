/** Post-upgrade validation probes for persisted plugin index and package extension entries. */
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readPersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import type { PackageManifest } from "../plugins/manifest.js";
import { validatePackageExtensionEntriesForInstall } from "../plugins/package-entry-resolution.js";
import {
  POST_UPGRADE_PROBE_CODES,
  type PostUpgradeFinding,
  type PostUpgradeReport,
} from "./doctor-post-upgrade.types.js";

type InstalledPluginRecord = {
  pluginId: string;
  rootDir: string;
  enabled: boolean;
  origin?: string;
  packageJson?: { path: string };
  manifestPath?: string;
  manifestHash?: string;
};

type InstallsJson = { plugins: InstalledPluginRecord[] };

function buildReport(findings: PostUpgradeFinding[]): PostUpgradeReport {
  return { probesRun: [...POST_UPGRADE_PROBE_CODES], findings };
}

function isInstallsJson(value: unknown): value is InstallsJson {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { plugins?: unknown }).plugins) &&
    (value as { plugins: unknown[] }).plugins.every(isInstalledPluginRecord)
  );
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isPackageJsonRef(value: unknown): value is InstalledPluginRecord["packageJson"] {
  return (
    value === undefined ||
    (typeof value === "object" &&
      value !== null &&
      typeof (value as { path?: unknown }).path === "string")
  );
}

function isSourceCheckoutPluginRecord(record: InstalledPluginRecord): boolean {
  if (record.origin === "workspace" || record.origin === "config") {
    return true;
  }
  return record.origin === "bundled" && isBundledSourceCheckoutPluginRoot(record.rootDir);
}

function isBundledSourceCheckoutPluginRoot(pluginRootDir: string): boolean {
  let current = path.resolve(pluginRootDir);
  while (true) {
    const extensionsDir = path.dirname(current);
    if (path.basename(extensionsDir) === "extensions") {
      const packageRoot = path.dirname(extensionsDir);
      return (
        fsSync.existsSync(path.join(packageRoot, ".git")) &&
        fsSync.existsSync(path.join(packageRoot, "pnpm-workspace.yaml")) &&
        fsSync.existsSync(path.join(packageRoot, "src"))
      );
    }
    const next = path.dirname(current);
    if (next === current) {
      return false;
    }
    current = next;
  }
}

function isInstalledPluginRecord(value: unknown): value is InstalledPluginRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as InstalledPluginRecord;
  return (
    typeof record.pluginId === "string" &&
    typeof record.rootDir === "string" &&
    typeof record.enabled === "boolean" &&
    isOptionalString(record.origin) &&
    isPackageJsonRef(record.packageJson) &&
    isOptionalString(record.manifestPath) &&
    isOptionalString(record.manifestHash)
  );
}

async function readInstallsJson(installsPath: string): Promise<InstallsJson | null> {
  try {
    const installsRaw = await fs.readFile(installsPath, "utf-8");
    const installs = JSON.parse(installsRaw) as unknown;
    return isInstallsJson(installs) ? installs : null;
  } catch {
    return null;
  }
}

async function readInstalledPluginIndex(params: {
  installsPath?: string;
  stateDir?: string;
}): Promise<InstallsJson | null> {
  if (params.installsPath) {
    return await readInstallsJson(params.installsPath);
  }
  const index = await readPersistedInstalledPluginIndex(
    params.stateDir ? { stateDir: params.stateDir } : {},
  );
  return index && isInstallsJson(index) ? { plugins: [...index.plugins] } : null;
}

async function readInstalledPackageJson(
  rootDir: string,
  packageJsonRelPath: string,
): Promise<PackageManifest> {
  const absPath = path.join(rootDir, packageJsonRelPath);
  const raw = await fs.readFile(absPath, "utf-8");
  return JSON.parse(raw) as PackageManifest;
}

async function resolvePackageJsonRelPath(
  record: InstalledPluginRecord,
): Promise<string | undefined> {
  if (record.packageJson) {
    return record.packageJson.path;
  }
  try {
    await fs.access(path.join(record.rootDir, "package.json"));
    return "package.json";
  } catch {
    return undefined;
  }
}

async function sha256OfFile(absPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(absPath);
    return crypto.createHash("sha256").update(raw).digest("hex");
  } catch {
    return null;
  }
}

/** Runs post-upgrade plugin probes and returns structured findings for the caller to render. */
export async function runPostUpgradeProbes(params: {
  installsPath?: string;
  stateDir?: string;
}): Promise<PostUpgradeReport> {
  const findings: PostUpgradeFinding[] = [];
  const installs = await readInstalledPluginIndex(params);
  if (!installs) {
    findings.push({
      level: "error",
      code: "plugin.index_unavailable",
      message:
        "Installed plugin index is missing, unreadable, or malformed. Run `openclaw plugins registry --refresh` to rebuild it before post-upgrade validation.",
    });
    return buildReport(findings);
  }

  for (const record of installs.plugins) {
    if (!record.enabled) {
      continue;
    }
    const pkgRelPath = await resolvePackageJsonRelPath(record);
    if (pkgRelPath) {
      let pkg: PackageManifest;
      try {
        pkg = await readInstalledPackageJson(record.rootDir, pkgRelPath);
      } catch (err) {
        process.stderr.write(
          `[doctor-post-upgrade] could not read package.json for ${record.pluginId} at ${record.rootDir}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        continue;
      }
      const entries = pkg.openclaw?.extensions ?? [];
      if (entries.length > 0) {
        // Delegate to the install-time resolver so the probe enforces the same
        // contract as plugin install/discovery: runtimeExtensions shape, plugin-root
        // boundary, and inferred-built-output / TypeScript-source-only handling.
        const validation = await validatePackageExtensionEntriesForInstall({
          packageDir: record.rootDir,
          extensions: [...entries],
          manifest: pkg,
          allowSourceTypeScriptEntries: isSourceCheckoutPluginRecord(record),
        });
        if (!validation.ok) {
          const offendingEntry = entries.find((entry) => validation.error.includes(entry));
          findings.push({
            level: "error",
            code: "plugin.entry_unresolved",
            message: `Plugin ${record.pluginId}: ${validation.error}`,
            plugin: record.pluginId,
            ...(offendingEntry ? { entry: offendingEntry } : {}),
          });
        }
      }
    }

    if (record.manifestPath && record.manifestHash) {
      const currentHash = await sha256OfFile(record.manifestPath);
      if (currentHash && currentHash !== record.manifestHash) {
        findings.push({
          level: "warn",
          code: "plugin.manifest_drift",
          message: `Plugin ${record.pluginId} manifest hash drifted from installs.json snapshot. Run \`openclaw plugins registry --refresh\` to re-sync.`,
          plugin: record.pluginId,
        });
      }
    }
  }

  return buildReport(findings);
}
