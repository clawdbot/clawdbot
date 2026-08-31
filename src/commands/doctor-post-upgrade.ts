/** Post-upgrade validation probes for persisted plugin index and package extension entries. */
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatConsoleDiagnosticLine } from "../logging/json-console-line.js";
import { readPersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import type {
  InstalledPluginIndex,
  InstalledPluginIndexRecord,
} from "../plugins/installed-plugin-index-types.js";
import { resolvePackageExtensionEntries, type PackageManifest } from "../plugins/manifest.js";
import { validatePackageExtensionEntriesForInstall } from "../plugins/package-entry-resolution.js";
import {
  POST_UPGRADE_PROBE_CODES,
  type PostUpgradeFinding,
  type PostUpgradeReport,
} from "./doctor-post-upgrade.types.js";

function buildReport(findings: PostUpgradeFinding[]): PostUpgradeReport {
  return { probesRun: [...POST_UPGRADE_PROBE_CODES], findings };
}

function isSourceCheckoutPluginRecord(record: InstalledPluginIndexRecord): boolean {
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

async function readInstalledPluginIndex(params: {
  stateDir?: string;
}): Promise<Pick<InstalledPluginIndex, "plugins"> | null> {
  const index = await readPersistedInstalledPluginIndex(
    params.stateDir ? { stateDir: params.stateDir } : {},
  );
  return index ? { plugins: [...index.plugins] } : null;
}

async function readInstalledPackageJson(
  rootDir: string,
  packageJsonRelPath: string,
): Promise<PackageManifest> {
  const absPath = path.join(rootDir, packageJsonRelPath);
  const raw = await fs.readFile(absPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("package.json must contain a JSON object");
  }
  return parsed as PackageManifest;
}

async function resolvePackageJsonRelPath(
  record: InstalledPluginIndexRecord,
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
        const reason = err instanceof Error ? err.message : String(err);
        const message = `[doctor-post-upgrade] could not read package.json for ${record.pluginId} at ${record.rootDir}: ${reason}`;
        process.stderr.write(`${formatConsoleDiagnosticLine({ level: "warn", message })}\n`);
        // A declared package is required to validate its runtime entry; logging
        // alone otherwise makes a broken enabled plugin exit as healthy.
        findings.push({
          level: "error",
          code: "plugin.entry_unresolved",
          message: `Plugin ${record.pluginId}: could not read package.json (${pkgRelPath}): ${reason}. Reinstall the plugin or run \`openclaw plugins registry --refresh\`.`,
          plugin: record.pluginId,
          entry: pkgRelPath,
        });
        continue;
      }
      const resolvedEntries = resolvePackageExtensionEntries(pkg);
      if (resolvedEntries.status === "invalid") {
        findings.push({
          level: "error",
          code: "plugin.entry_unresolved",
          message: `Plugin ${record.pluginId}: ${resolvedEntries.error}. Reinstall the plugin or run \`openclaw plugins registry --refresh\`.`,
          plugin: record.pluginId,
          entry: pkgRelPath,
        });
      } else if (resolvedEntries.status === "ok") {
        const entries = resolvedEntries.entries;
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
