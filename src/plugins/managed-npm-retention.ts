// Marks managed npm packages excluded from recovery and classifies cleanup eligibility.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { safePathSegmentHashed } from "../infra/install-safe-path.js";
import { isNotFoundPathError, isPathInside } from "../infra/path-guards.js";
import {
  isPluginNpmProjectDir,
  resolveDefaultPluginNpmDir,
  resolvePluginNpmProjectsDir,
} from "./install-paths.js";
import {
  isRetainedManagedNpmCleanupEligibleReason,
  RETAINED_MANAGED_NPM_KEEP_FILES_REASON,
} from "./managed-npm-retention-contract.js";
import { listManagedPluginNpmRootsSync } from "./npm-project-roots.js";

const RETAINED_MANAGED_NPM_INSTALL_MARKER_DIR = ".openclaw-retained-npm-installs";
const RETAINED_MANAGED_NPM_INSTALL_MARKER_VERSION = 1;

type MarkerCleanupDisposition =
  | { kind: "absent" }
  | { kind: "cleanup" }
  | { kind: "preserve" }
  | { kind: "invalid"; error: unknown };

function classifyMarkerForCleanup(markerPath: string): MarkerCleanupDisposition {
  try {
    const marker: unknown = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (
      !isRecord(marker) ||
      marker.version !== RETAINED_MANAGED_NPM_INSTALL_MARKER_VERSION ||
      typeof marker.pluginId !== "string" ||
      marker.pluginId.trim().length === 0 ||
      typeof marker.retainedAt !== "string" ||
      marker.retainedAt.trim().length === 0 ||
      typeof marker.reason !== "string"
    ) {
      return {
        kind: "invalid",
        error: new Error(`Invalid retained managed npm marker: ${markerPath}`),
      };
    }
    if (marker.reason === RETAINED_MANAGED_NPM_KEEP_FILES_REASON) {
      return { kind: "preserve" };
    }
    if (isRetainedManagedNpmCleanupEligibleReason(marker.reason)) {
      return { kind: "cleanup" };
    }
    return {
      kind: "invalid",
      error: new Error(`Unknown retained managed npm marker reason: ${markerPath}`),
    };
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return { kind: "absent" };
    }
    // Cleanup requires positive proof that the marker is disposable. A damaged marker may be
    // the only remaining record that package files were intentionally retained.
    return { kind: "invalid", error };
  }
}

export function resolveRetainedManagedNpmInstallPackageInfo(packageDir: string): {
  packageName: string;
  projectRoot: string;
  markerPath: string;
} | null {
  const resolvedPackageDir = path.resolve(packageDir);
  const packageBase = path.basename(resolvedPackageDir);
  const parentDir = path.dirname(resolvedPackageDir);
  const parentBase = path.basename(parentDir);
  const scopedPackage = parentBase.startsWith("@");
  const nodeModulesRoot = scopedPackage ? path.dirname(parentDir) : parentDir;
  if (path.basename(nodeModulesRoot) !== "node_modules") {
    return null;
  }
  const packageName = scopedPackage ? `${parentBase}/${packageBase}` : packageBase;
  if (!packageBase || packageBase === "." || !packageName.trim()) {
    return null;
  }
  const projectRoot = path.dirname(nodeModulesRoot);
  return {
    packageName,
    projectRoot,
    markerPath: path.join(
      projectRoot,
      RETAINED_MANAGED_NPM_INSTALL_MARKER_DIR,
      `${safePathSegmentHashed(packageName)}.json`,
    ),
  };
}

export function resolveRetainedManagedNpmInstallMarkerPath(packageDir: string): string {
  const info = resolveRetainedManagedNpmInstallPackageInfo(packageDir);
  if (!info) {
    throw new Error("retained npm install marker requires a node_modules package directory");
  }
  return info.markerPath;
}

export function hasRetainedManagedNpmInstallMarker(packageDir: string): boolean {
  const info = resolveRetainedManagedNpmInstallPackageInfo(packageDir);
  if (!info) {
    return false;
  }
  try {
    fs.lstatSync(info.markerPath);
    return true;
  } catch (error) {
    // Discovery must fail closed: an inaccessible marker cannot make retained files recoverable.
    return !isNotFoundPathError(error);
  }
}

export async function clearRetainedManagedNpmInstallMarker(packageDir: string): Promise<boolean> {
  const info = resolveRetainedManagedNpmInstallPackageInfo(packageDir);
  if (!info) {
    return false;
  }
  try {
    await fs.promises.rm(info.markerPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  try {
    await fs.promises.rmdir(path.dirname(info.markerPath));
  } catch {
    // Best effort: keep the OpenClaw-owned marker directory if it is not empty.
  }
  return true;
}

export async function markRetainedManagedNpmInstall(params: {
  packageDir: string;
  pluginId: string;
  retainedAt?: string;
  reason: string;
}): Promise<boolean> {
  const info = resolveRetainedManagedNpmInstallPackageInfo(params.packageDir);
  if (!info) {
    return false;
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(params.packageDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    return false;
  }
  await fs.promises.mkdir(path.dirname(info.markerPath), { recursive: true });
  await fs.promises.writeFile(
    info.markerPath,
    `${JSON.stringify(
      {
        version: RETAINED_MANAGED_NPM_INSTALL_MARKER_VERSION,
        pluginId: params.pluginId,
        retainedAt: params.retainedAt ?? new Date().toISOString(),
        reason: params.reason,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return true;
}

function listManagedNpmPackageDirs(npmRoot: string): string[] {
  const nodeModulesDir = path.join(npmRoot, "node_modules");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries.flatMap((entry) => {
    if (!entry.isDirectory()) {
      return [];
    }
    if (!entry.name.startsWith("@")) {
      return [path.join(nodeModulesDir, entry.name)];
    }
    return fs
      .readdirSync(path.join(nodeModulesDir, entry.name), { withFileTypes: true })
      .filter((scopedEntry) => scopedEntry.isDirectory())
      .map((scopedEntry) => path.join(nodeModulesDir, entry.name, scopedEntry.name));
  });
}

function isOwnedManagedNpmProject(params: {
  markerNames: ReadonlySet<string>;
  npmDir: string;
  projectRoot: string;
}): boolean {
  return listManagedNpmPackageDirs(params.projectRoot).some((packageDir) => {
    const info = resolveRetainedManagedNpmInstallPackageInfo(packageDir);
    return Boolean(
      info &&
      params.markerNames.has(path.basename(info.markerPath)) &&
      isPluginNpmProjectDir({
        npmDir: params.npmDir,
        packageName: info.packageName,
        projectDir: params.projectRoot,
      }),
    );
  });
}

async function cleanupRetainedLegacyNpmPackages(params: {
  npmRoot: string;
  activeInstallPaths: string[];
  onError?: (error: unknown, projectRoot: string) => void;
}): Promise<number> {
  let removed = 0;
  for (const packageDir of listManagedNpmPackageDirs(params.npmRoot)) {
    if (params.activeInstallPaths.some((installPath) => isPathInside(packageDir, installPath))) {
      continue;
    }
    // Classify in one read so access failures cannot masquerade as a missing marker.
    const disposition = classifyMarkerForCleanup(
      resolveRetainedManagedNpmInstallMarkerPath(packageDir),
    );
    if (disposition.kind !== "cleanup") {
      if (disposition.kind === "invalid") {
        params.onError?.(disposition.error, packageDir);
      }
      continue;
    }
    try {
      await fs.promises.rm(packageDir, { recursive: true, force: true });
      await clearRetainedManagedNpmInstallMarker(packageDir);
      removed += 1;
    } catch (error) {
      params.onError?.(error, packageDir);
    }
  }
  return removed;
}

export async function cleanupRetainedManagedNpmInstallGenerations(
  params: {
    activeInstallPaths?: Iterable<string>;
    env?: NodeJS.ProcessEnv;
    npmDir?: string;
    onError?: (error: unknown, projectRoot: string) => void;
  } = {},
): Promise<number> {
  // Callers run this only after the previous gateway server has closed and preserve
  // every active install path, so retired module graphs no longer need these trees.
  const npmDir = params.npmDir ?? resolveDefaultPluginNpmDir(params.env);
  const projectsDir = resolvePluginNpmProjectsDir(npmDir);
  const activeInstallPaths = Array.from(params.activeInstallPaths ?? [], (installPath) =>
    path.resolve(installPath),
  );
  let removed = 0;
  for (const projectRoot of listManagedPluginNpmRootsSync(npmDir)) {
    if (path.resolve(projectRoot) === path.resolve(npmDir)) {
      removed += await cleanupRetainedLegacyNpmPackages({
        npmRoot: projectRoot,
        activeInstallPaths,
        onError: params.onError,
      });
      continue;
    }
    const markerDir = path.join(projectRoot, RETAINED_MANAGED_NPM_INSTALL_MARKER_DIR);
    let markerEntries: fs.Dirent[];
    try {
      markerEntries = fs
        .readdirSync(markerDir, { withFileTypes: true })
        .filter((entry) => entry.isFile());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      params.onError?.(error, projectRoot);
      continue;
    }
    if (
      markerEntries.length === 0 ||
      !isPathInside(projectsDir, projectRoot) ||
      !isOwnedManagedNpmProject({
        markerNames: new Set(markerEntries.map((entry) => entry.name)),
        npmDir,
        projectRoot,
      }) ||
      activeInstallPaths.some((installPath) => isPathInside(projectRoot, installPath))
    ) {
      continue;
    }
    let cleanupEligible = true;
    for (const entry of markerEntries) {
      const disposition = classifyMarkerForCleanup(path.join(markerDir, entry.name));
      if (disposition.kind !== "cleanup") {
        cleanupEligible = false;
        if (disposition.kind === "invalid") {
          params.onError?.(disposition.error, projectRoot);
        }
      }
    }
    if (!cleanupEligible) {
      continue;
    }
    try {
      await fs.promises.rm(projectRoot, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      params.onError?.(error, projectRoot);
    }
  }
  return removed;
}
