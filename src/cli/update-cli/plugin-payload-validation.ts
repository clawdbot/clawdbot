import fs from "node:fs/promises";
import path from "node:path";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { resolvePackageExtensionEntries, type PackageManifest } from "../../plugins/manifest.js";
import { validatePackageExtensionEntriesForInstall } from "../../plugins/package-entry-resolution.js";
import { resolveUserPath } from "../../utils.js";

export type PluginPayloadSmokeFailureReason =
  | "missing-install-path"
  | "missing-package-dir"
  | "missing-package-json"
  | "invalid-package-json"
  | "missing-main-entry"
  | "missing-extension-entry";

export type PluginPayloadSmokeFailure = {
  pluginId: string;
  installPath?: string;
  reason: PluginPayloadSmokeFailureReason;
  detail: string;
};

export type PluginPayloadSmokeResult = {
  checked: string[];
  failures: PluginPayloadSmokeFailure[];
};

const TRACKED_SOURCES: ReadonlySet<string> = new Set(["npm", "clawhub", "git", "marketplace"]);

/**
 * Verify that each tracked plugin install record on disk is structurally
 * loadable: the install dir exists, contains a parseable `package.json`,
 * and any declared package entry files exist.
 *
 * IMPORTANT: this is intentionally a *static* check. We do NOT execute the
 * plugin's code, so post-update side effects (network calls, filesystem
 * writes, registry registration) cannot fire while the gateway is still
 * stopped. The goal is to catch obvious payload corruption — missing files,
 * unparseable manifests — before we hand control back to the restart path.
 */
export async function runPluginPayloadSmokeCheck(params: {
  records: Record<string, PluginInstallRecord>;
  env: NodeJS.ProcessEnv;
}): Promise<PluginPayloadSmokeResult> {
  const checked: string[] = [];
  const failures: PluginPayloadSmokeFailure[] = [];

  for (const [pluginId, record] of Object.entries(params.records).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!record || typeof record !== "object" || !TRACKED_SOURCES.has(record.source)) {
      continue;
    }
    const rawInstallPath = typeof record.installPath === "string" ? record.installPath.trim() : "";
    if (!rawInstallPath) {
      checked.push(pluginId);
      failures.push({
        pluginId,
        reason: "missing-install-path",
        detail: "Install path is missing from the plugin install record.",
      });
      continue;
    }
    const installPath = resolveUserPath(rawInstallPath, params.env);
    checked.push(pluginId);

    const dirStat = await safeStat(installPath);
    if (!dirStat?.isDirectory()) {
      failures.push({
        pluginId,
        installPath,
        reason: "missing-package-dir",
        detail: `Install dir is missing: ${installPath}`,
      });
      continue;
    }

    const packageJsonPath = path.join(installPath, "package.json");
    const packageJsonStat = await safeStat(packageJsonPath);
    if (!packageJsonStat?.isFile()) {
      failures.push({
        pluginId,
        installPath,
        reason: "missing-package-json",
        detail: `package.json is missing under ${installPath}`,
      });
      continue;
    }

    let manifest: PackageManifest & { main?: unknown; exports?: unknown };
    try {
      manifest = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as typeof manifest;
    } catch (err) {
      failures.push({
        pluginId,
        installPath,
        reason: "invalid-package-json",
        detail: `Could not parse package.json: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const extensionResolution = resolvePackageExtensionEntries(manifest);
    if (extensionResolution.status === "ok") {
      const extensionValidation = await validatePackageExtensionEntriesForInstall({
        packageDir: installPath,
        extensions: extensionResolution.entries,
        manifest,
      });
      if (!extensionValidation.ok) {
        failures.push({
          pluginId,
          installPath,
          reason: "missing-extension-entry",
          detail: `Plugin extension entry validation failed: ${extensionValidation.error}`,
        });
      }
    }

    // Only fail on `missing-main-entry` when `main` is *explicitly declared*
    // and absent on disk. Fully resolving `exports` conditional sub-keys is
    // out of scope for a static smoke check, so packages with only `exports`
    // remain intentionally permissive.
    if (typeof manifest.main !== "string" || !manifest.main.trim()) {
      continue;
    }
    const mainRel = manifest.main.trim();
    const mainPath = path.join(installPath, mainRel);
    const mainStat = await safeStat(mainPath);
    if (!mainStat?.isFile()) {
      failures.push({
        pluginId,
        installPath,
        reason: "missing-main-entry",
        detail: `Plugin main entry "${mainRel}" not found at ${mainPath}`,
      });
    }
  }

  return { checked, failures };
}

async function safeStat(target: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}
