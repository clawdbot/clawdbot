// Static payload checks for installed plugins after a core update swaps package files.
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { detectBundleManifestFormat, loadBundleManifest } from "../../plugins/bundle-manifest.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import type { PluginBundleFormat } from "../../plugins/manifest-types.js";
import { resolvePackageExtensionEntries, type PackageManifest } from "../../plugins/manifest.js";
import { validatePackageExtensionEntriesForInstall } from "../../plugins/package-entry-resolution.js";
import { auditOpenClawPeerDependencyLink } from "../../plugins/plugin-peer-link.js";
import type { PluginVerificationFailureReason } from "../../plugins/runtime-degraded-state.js";
import { resolveUserPath } from "../../utils.js";

export type PluginPayloadSmokeFailure = {
  pluginId: string;
  installPath?: string;
  reason: PluginVerificationFailureReason;
  detail: string;
};

export type PluginPayloadSmokeResult = {
  checked: string[];
  failures: PluginPayloadSmokeFailure[];
};

const TRACKED_SOURCES: ReadonlySet<string> = new Set(["npm", "clawhub", "git", "marketplace"]);

/**
 * Verify that each tracked plugin install record on disk is structurally
 * loadable: code packages contain a parseable `package.json` and declared
 * package entry files, while bundle packages satisfy their bundle manifest
 * contract.
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

    const bundlePayload = resolveBundleInstallRecordPayload({ record, installPath });
    const packagePayload = await readPackagePayloadManifest(installPath);
    if (packagePayload.status === "present") {
      const usePackagePayload =
        !bundlePayload.isBundlePayload || hasNativePackageMetadata(packagePayload.manifest);
      if (usePackagePayload) {
        failures.push(
          ...(await validatePackagePayload({
            pluginId,
            installPath,
            manifest: packagePayload.manifest,
          })),
        );
        continue;
      }
    } else if (!bundlePayload.isBundlePayload) {
      failures.push(formatPackagePayloadReadFailure({ pluginId, installPath, packagePayload }));
      continue;
    }

    const bundleFailure = validateBundleInstallRecordPayload({
      pluginId,
      installPath,
      record,
      bundleFormat: bundlePayload.bundleFormat,
    });
    if (bundleFailure) {
      failures.push(bundleFailure);
    }
  }

  return { checked, failures };
}

/** Verifies the exact manifest records selected for this process. */
export async function runPluginPayloadSmokeCheckForManifestRecords(params: {
  plugins: readonly Pick<PluginManifestRecord, "id" | "rootDir" | "format">[];
  env: NodeJS.ProcessEnv;
}): Promise<PluginPayloadSmokeResult> {
  const records = Object.fromEntries(
    params.plugins.map((plugin) => [
      plugin.id,
      {
        source: plugin.format === "bundle" ? "marketplace" : "npm",
        installPath: plugin.rootDir,
        ...(plugin.format === "bundle" ? { clawhubFamily: "bundle-plugin" as const } : {}),
      } satisfies PluginInstallRecord,
    ]),
  );
  return await runPluginPayloadSmokeCheck({ records, env: params.env });
}

type PackagePayloadManifest = PackageManifest & { main?: unknown; exports?: unknown };

type PackagePayloadManifestReadResult =
  | { status: "missing" }
  | { status: "unreadable"; error: string }
  | { status: "invalid"; error: string }
  | { status: "present"; manifest: PackagePayloadManifest };

async function readPackagePayloadManifest(
  installPath: string,
): Promise<PackagePayloadManifestReadResult> {
  const packageJsonPath = path.join(installPath, "package.json");
  const packageJsonStat = await safeStat(packageJsonPath);
  if (!packageJsonStat?.isFile()) {
    return { status: "missing" };
  }
  let packageJson: string;
  try {
    packageJson = await fs.readFile(packageJsonPath, "utf8");
  } catch (err) {
    return { status: "unreadable", error: err instanceof Error ? err.message : String(err) };
  }
  try {
    return {
      status: "present",
      manifest: JSON.parse(packageJson) as PackagePayloadManifest,
    };
  } catch (err) {
    return { status: "invalid", error: err instanceof Error ? err.message : String(err) };
  }
}

function formatPackagePayloadReadFailure(params: {
  pluginId: string;
  installPath: string;
  packagePayload: Exclude<PackagePayloadManifestReadResult, { status: "present" }>;
}): PluginPayloadSmokeFailure {
  if (params.packagePayload.status === "unreadable") {
    const packageJsonPath = path.join(params.installPath, "package.json");
    return {
      pluginId: params.pluginId,
      installPath: params.installPath,
      reason: "unreadable-package-json",
      detail: `Could not read package.json at ${packageJsonPath}: ${params.packagePayload.error}`,
    };
  }
  if (params.packagePayload.status === "invalid") {
    return {
      pluginId: params.pluginId,
      installPath: params.installPath,
      reason: "invalid-package-json",
      detail: `Could not parse package.json: ${params.packagePayload.error}`,
    };
  }
  return {
    pluginId: params.pluginId,
    installPath: params.installPath,
    reason: "missing-package-json",
    detail: `package.json is missing under ${params.installPath}`,
  };
}

function hasNativePackageMetadata(manifest: PackageManifest): boolean {
  return resolvePackageExtensionEntries(manifest).status !== "missing";
}

export async function hasNativePackageInstallPayload(installPath: string): Promise<boolean> {
  const packagePayload = await readPackagePayloadManifest(installPath);
  return packagePayload.status === "present" && hasNativePackageMetadata(packagePayload.manifest);
}

async function validatePackagePayload(params: {
  pluginId: string;
  installPath: string;
  manifest: PackagePayloadManifest;
}): Promise<PluginPayloadSmokeFailure[]> {
  const failures: PluginPayloadSmokeFailure[] = [];

  if (manifestDeclaresOpenClawPeer(params.manifest)) {
    const peerIssue = await auditOpenClawPeerDependencyLink({
      packageDir: params.installPath,
      packageName: params.manifest.name ?? params.pluginId,
    });
    if (peerIssue) {
      failures.push({
        pluginId: params.pluginId,
        installPath: params.installPath,
        reason: "missing-openclaw-peer-link",
        detail: `Plugin declares peerDependency "openclaw" but peer link audit failed: ${peerIssue.reason}.`,
      });
    }
  }

  const extensionResolution = resolvePackageExtensionEntries(params.manifest);
  if (extensionResolution.status === "invalid" || extensionResolution.status === "empty") {
    failures.push({
      pluginId: params.pluginId,
      installPath: params.installPath,
      reason: "missing-extension-entry",
      detail: `Plugin extension entry validation failed: ${
        extensionResolution.status === "invalid"
          ? extensionResolution.error
          : "package.json openclaw.extensions is empty"
      }`,
    });
    return failures;
  } else if (extensionResolution.status === "ok") {
    const extensionValidation = await validatePackageExtensionEntriesForInstall({
      packageDir: params.installPath,
      extensions: extensionResolution.entries,
      manifest: params.manifest,
    });
    if (!extensionValidation.ok) {
      failures.push({
        pluginId: params.pluginId,
        installPath: params.installPath,
        reason: "missing-extension-entry",
        detail: `Plugin extension entry validation failed: ${extensionValidation.error}`,
      });
    }
  }

  // Only fail on `missing-main-entry` when `main` is *explicitly declared*
  // and absent on disk. Fully resolving `exports` conditional sub-keys is
  // out of scope for a static smoke check, so packages with only `exports`
  // remain intentionally permissive.
  if (typeof params.manifest.main !== "string" || !params.manifest.main.trim()) {
    return failures;
  }
  const mainRel = params.manifest.main.trim();
  const mainPath = path.join(params.installPath, mainRel);
  const mainStat = await safeStat(mainPath);
  if (!mainStat?.isFile()) {
    failures.push({
      pluginId: params.pluginId,
      installPath: params.installPath,
      reason: "missing-main-entry",
      detail: `Plugin main entry "${mainRel}" not found at ${mainPath}`,
    });
  }
  return failures;
}

function isBundleInstallRecord(record: PluginInstallRecord): boolean {
  return (
    (record as { format?: unknown }).format === "bundle" || record.clawhubFamily === "bundle-plugin"
  );
}

export function resolveBundleInstallRecordPayload(params: {
  record: PluginInstallRecord;
  installPath: string;
}): { isBundlePayload: boolean; bundleFormat: PluginBundleFormat | null } {
  const hasBundleRecordMetadata = isBundleInstallRecord(params.record);
  if (!hasBundleRecordMetadata && params.record.source !== "marketplace") {
    return { isBundlePayload: false, bundleFormat: null };
  }
  const bundleFormat = detectBundleManifestFormat(params.installPath);
  return {
    isBundlePayload: hasBundleRecordMetadata || bundleFormat !== null,
    bundleFormat,
  };
}

export function validateBundleInstallRecordPayload(params: {
  pluginId: string;
  installPath: string;
  record: PluginInstallRecord;
  bundleFormat?: PluginBundleFormat | null;
}): PluginPayloadSmokeFailure | null {
  const hasBundleRecordMetadata = isBundleInstallRecord(params.record);
  const bundleFormat =
    params.bundleFormat === undefined
      ? detectBundleManifestFormat(params.installPath)
      : params.bundleFormat;
  if (!hasBundleRecordMetadata && !bundleFormat) {
    return null;
  }
  if (!bundleFormat) {
    return {
      pluginId: params.pluginId,
      installPath: params.installPath,
      reason: "missing-bundle-manifest",
      detail: `No supported bundle manifest or bundle marker found under ${params.installPath}`,
    };
  }
  const bundleManifest = loadBundleManifest({
    rootDir: params.installPath,
    bundleFormat,
  });
  if (bundleManifest.ok) {
    return null;
  }
  return {
    pluginId: params.pluginId,
    installPath: params.installPath,
    reason: bundleManifest.error.startsWith("plugin manifest not found")
      ? "missing-bundle-manifest"
      : "invalid-bundle-manifest",
    detail: `Bundle manifest validation failed: ${bundleManifest.error}`,
  };
}

function manifestDeclaresOpenClawPeer(manifest: PackageManifest): boolean {
  const peerDependencies = (manifest as { peerDependencies?: unknown }).peerDependencies;
  return (
    typeof peerDependencies === "object" &&
    peerDependencies !== null &&
    !Array.isArray(peerDependencies) &&
    typeof (peerDependencies as Record<string, unknown>).openclaw === "string"
  );
}

async function safeStat(target: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}
