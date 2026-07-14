// Doctor cleanup for stale plugin dependency install state and dangling runtime symlinks.
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import type { HealthFinding } from "../../../flows/health-checks.js";
import { resolveOpenClawPackageRootSync } from "../../../infra/openclaw-root.js";
import { resolveConfigDir, resolveUserPath } from "../../../utils.js";
import { removeStalePluginRuntimeSymlinks } from "./plugin-runtime-symlinks.js";

const LEGACY_DIRECT_CHILD_NAMES = new Set(["plugin-runtime-deps", "bundled-plugin-runtime-deps"]);

interface CleanupRoot {
  readonly realPath: string;
}

interface CleanupTarget {
  readonly kind: "explicit-stage" | "legacy";
  readonly path: string;
  readonly rawPath?: string;
}

interface LegacyPluginDependencyStateIssue {
  readonly kind: "legacy-plugin-dependency-state";
  readonly path: string;
}

function uniqueSorted(values: Iterable<string | null | undefined>): string[] {
  return [
    ...new Set(
      [...values]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .map((value) => path.resolve(value)),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

function splitPathList(value: string | undefined): string[] {
  return value
    ? value
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

function hasParentPathSegment(value: string): boolean {
  return value.split(/[\\/]+/u).includes("..");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isRuntimeDependencyMarkerName(name: string): boolean {
  return (
    name === ".openclaw-runtime-deps.json" ||
    name === ".openclaw-runtime-deps-stamp.json" ||
    name.startsWith(".openclaw-runtime-deps-")
  );
}

function isInstallStageDebrisName(name: string): boolean {
  return /^\.openclaw-install-stage(?:-.+)?$/u.test(name);
}

function isLegacyDependencyDebrisName(name: string): boolean {
  return (
    isRuntimeDependencyMarkerName(name) ||
    name === ".openclaw-pnpm-store" ||
    name === ".openclaw-install-backups" ||
    isInstallStageDebrisName(name)
  );
}

function isExpectedLegacyCleanupTargetName(name: string): boolean {
  return (
    name === "node_modules" ||
    LEGACY_DIRECT_CHILD_NAMES.has(name) ||
    isLegacyDependencyDebrisName(name)
  );
}

async function isFile(targetPath: string): Promise<boolean> {
  const stat = await fs.lstat(targetPath).catch(() => null);
  return stat?.isFile() === true;
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function collectDirectChildren(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.map((entry) => path.join(root, entry.name));
}

async function isDirectoryInCleanupRoot(
  candidate: string,
  cleanupRootRealPath: string,
): Promise<boolean> {
  const stat = await fs.lstat(candidate).catch(() => null);
  if (!stat?.isDirectory() && !stat?.isSymbolicLink()) {
    return false;
  }
  const realPath = await fs.realpath(candidate).catch(() => null);
  return realPath !== null && isPathInsideRoot(realPath, cleanupRootRealPath);
}

async function collectLegacyExtensionDebris(
  extensionsRoot: string,
  cleanupRootRealPath: string,
): Promise<string[]> {
  if (!(await isDirectoryInCleanupRoot(extensionsRoot, cleanupRootRealPath))) {
    return [];
  }
  const pluginDirs = await fs.readdir(extensionsRoot, { withFileTypes: true }).catch(() => []);
  const targets: string[] = [];
  for (const entry of pluginDirs) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const pluginRoot = path.join(extensionsRoot, entry.name);
    if (!(await isDirectoryInCleanupRoot(pluginRoot, cleanupRootRealPath))) {
      continue;
    }
    const children = await collectDirectChildren(pluginRoot);
    const hasRuntimeDepsMarker = children.some((childPath) =>
      isRuntimeDependencyMarkerName(path.basename(childPath)),
    );
    for (const childPath of children) {
      const basename = path.basename(childPath);
      if (basename === "node_modules" && hasRuntimeDepsMarker) {
        targets.push(childPath);
        continue;
      }
      if (isLegacyDependencyDebrisName(basename)) {
        targets.push(childPath);
      }
    }
  }
  return targets;
}

function collectCleanupRootPaths(
  env: NodeJS.ProcessEnv,
  packageRoot: string | null | undefined,
): string[] {
  const stateDirectoryRoots = splitPathList(env.STATE_DIRECTORY).map((entry) =>
    resolveUserPath(entry, env),
  );
  return uniqueSorted([
    resolveStateDir(env),
    resolveConfigDir(env),
    packageRoot,
    ...stateDirectoryRoots,
  ]);
}

async function collectExistingCleanupRoots(
  cleanupRootPaths: readonly string[],
): Promise<CleanupRoot[]> {
  const roots: CleanupRoot[] = [];
  for (const rootPath of cleanupRootPaths) {
    const stat = await fs.stat(rootPath).catch(() => null);
    if (!stat?.isDirectory()) {
      continue;
    }
    const realPath = await fs.realpath(rootPath).catch(() => null);
    if (realPath === null) {
      continue;
    }
    roots.push({ realPath });
  }
  return roots;
}

function collectExplicitStageTargets(env: NodeJS.ProcessEnv): CleanupTarget[] {
  return splitPathList(env.OPENCLAW_PLUGIN_STAGE_DIR).map((entry) => ({
    kind: "explicit-stage",
    path: resolveUserPath(entry, env),
    rawPath: entry,
  }));
}

async function hasOpenClawRenameResidue(root: string): Promise<boolean> {
  const nodeModulesRoot = path.join(root, "node_modules");
  if (await isFile(path.join(nodeModulesRoot, ".openclaw-rename-tmp"))) {
    return true;
  }
  const entries = await fs.readdir(nodeModulesRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const entryPath = path.join(nodeModulesRoot, entry.name);
    if (await isFile(path.join(entryPath, ".openclaw-rename-tmp"))) {
      return true;
    }
    if (!entry.name.startsWith("@")) {
      continue;
    }
    const scopedEntries = await fs.readdir(entryPath, { withFileTypes: true }).catch(() => []);
    for (const scopedEntry of scopedEntries) {
      if (!scopedEntry.isDirectory() || scopedEntry.isSymbolicLink()) {
        continue;
      }
      if (await isFile(path.join(entryPath, scopedEntry.name, ".openclaw-rename-tmp"))) {
        return true;
      }
    }
  }
  return false;
}

async function hasExplicitStageDebrisProof(root: string): Promise<boolean> {
  const children = await collectDirectChildren(root);
  if (children.some((childPath) => isRuntimeDependencyMarkerName(path.basename(childPath)))) {
    return true;
  }
  return await hasOpenClawRenameResidue(root);
}

function filterLegacyStaleRootCandidates(
  targets: readonly CleanupTarget[],
  cleanupRootPaths: readonly string[],
): { targets: CleanupTarget[]; warnings: string[] } {
  const safeTargets: CleanupTarget[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const targetPath = path.resolve(target.path);
    if (seen.has(targetPath)) {
      continue;
    }
    seen.add(targetPath);
    if (target.kind === "explicit-stage") {
      if (target.rawPath && hasParentPathSegment(target.rawPath)) {
        warnings.push(
          `Skipped legacy plugin dependency state ${targetPath}: parent path segments are not allowed`,
        );
        continue;
      }
      safeTargets.push({ ...target, path: targetPath });
      continue;
    }
    if (!isExpectedLegacyCleanupTargetName(path.basename(targetPath))) {
      warnings.push(`Skipped legacy plugin dependency state ${targetPath}: unexpected path name`);
      continue;
    }
    if (!cleanupRootPaths.some((rootPath) => isPathInsideRoot(targetPath, rootPath))) {
      warnings.push(
        `Skipped legacy plugin dependency state ${targetPath}: outside OpenClaw cleanup roots`,
      );
      continue;
    }
    safeTargets.push({ ...target, path: targetPath });
  }
  return {
    targets: safeTargets.toSorted((left, right) => left.path.localeCompare(right.path)),
    warnings,
  };
}

async function resolveSafeRemovalTarget(
  target: CleanupTarget,
  cleanupRoots: readonly CleanupRoot[],
): Promise<{ target: string } | { warning: string }> {
  const targetPath = path.resolve(target.path);
  const stat = await fs.lstat(targetPath).catch(() => null);
  if (target.kind === "explicit-stage" && stat?.isSymbolicLink()) {
    return {
      warning: `Skipped legacy plugin dependency state ${targetPath}: symbolic link roots are not removed`,
    };
  }
  const realPath = await fs.realpath(targetPath).catch(() => null);
  if (realPath === null) {
    return {
      warning: `Skipped legacy plugin dependency state ${targetPath}: could not resolve path`,
    };
  }
  if (target.kind === "explicit-stage") {
    if (
      !isInstallStageDebrisName(path.basename(targetPath)) &&
      !(await hasExplicitStageDebrisProof(targetPath))
    ) {
      return {
        warning: `Skipped legacy plugin dependency state ${targetPath}: unexpected path name`,
      };
    }
    return { target: targetPath };
  }
  if (!cleanupRoots.some((root) => isPathInsideRoot(realPath, root.realPath))) {
    return {
      warning: `Skipped legacy plugin dependency state ${targetPath}: resolved outside OpenClaw cleanup roots`,
    };
  }
  return { target: targetPath };
}

async function prepareCleanupTargets(
  targets: readonly CleanupTarget[],
  cleanupRoots: readonly CleanupRoot[],
): Promise<{ removalTargets: string[]; staleRoots: string[]; warnings: string[] }> {
  const removalTargets: string[] = [];
  const staleRoots: string[] = [];
  const warnings: string[] = [];
  for (const target of targets) {
    if (!(await pathExists(target.path))) {
      continue;
    }
    const safeTarget = await resolveSafeRemovalTarget(target, cleanupRoots);
    if ("warning" in safeTarget) {
      warnings.push(safeTarget.warning);
      continue;
    }
    removalTargets.push(safeTarget.target);
    staleRoots.push(safeTarget.target);
  }
  return {
    removalTargets: uniqueSorted(removalTargets),
    staleRoots: uniqueSorted(staleRoots),
    warnings,
  };
}

async function collectLegacyPluginDependencyTargetEntries(
  env: NodeJS.ProcessEnv = process.env,
  options: { packageRoot?: string | null } = {},
): Promise<CleanupTarget[]> {
  const packageRoot =
    options.packageRoot ??
    resolveOpenClawPackageRootSync({
      argv1: process.argv[1],
      moduleUrl: import.meta.url,
      cwd: process.cwd(),
    });
  const roots = uniqueSorted([resolveStateDir(env), resolveConfigDir(env), packageRoot]);
  const stateDirectoryRoots = splitPathList(env.STATE_DIRECTORY).map(
    (entry): CleanupTarget => ({
      kind: "legacy",
      path: path.join(resolveUserPath(entry, env), "plugin-runtime-deps"),
    }),
  );
  const targets: CleanupTarget[] = [
    ...collectExplicitStageTargets(env),
    ...stateDirectoryRoots,
    ...roots.flatMap((root) => [
      ...[...LEGACY_DIRECT_CHILD_NAMES].map(
        (name): CleanupTarget => ({
          kind: "legacy",
          path: path.join(root, name),
        }),
      ),
      {
        kind: "legacy",
        path: path.join(root, ".local", "bundled-plugin-runtime-deps"),
      } satisfies CleanupTarget,
    ]),
  ];
  for (const root of roots) {
    const rootRealPath = await fs.realpath(root).catch(() => null);
    if (rootRealPath === null) {
      continue;
    }
    targets.push(
      ...(await collectLegacyExtensionDebris(path.join(root, "extensions"), rootRealPath)).map(
        (targetPath): CleanupTarget => ({ kind: "legacy", path: targetPath }),
      ),
    );
    targets.push(
      ...(
        await collectLegacyExtensionDebris(path.join(root, "dist", "extensions"), rootRealPath)
      ).map((targetPath): CleanupTarget => ({ kind: "legacy", path: targetPath })),
    );
  }
  return targets.toSorted((left, right) => left.path.localeCompare(right.path));
}

async function collectLegacyPluginDependencyTargets(
  env: NodeJS.ProcessEnv = process.env,
  options: { packageRoot?: string | null } = {},
): Promise<string[]> {
  return uniqueSorted(
    (await collectLegacyPluginDependencyTargetEntries(env, options)).map((target) => target.path),
  );
}

/** Find stale legacy plugin dependency state that doctor --fix can remove. */
export async function detectLegacyPluginDependencyStateIssues(
  params: {
    env?: NodeJS.ProcessEnv;
    packageRoot?: string | null;
  } = {},
): Promise<LegacyPluginDependencyStateIssue[]> {
  const env = params.env ?? process.env;
  const packageRoot =
    params.packageRoot ??
    resolveOpenClawPackageRootSync({
      argv1: process.argv[1],
      moduleUrl: import.meta.url,
      cwd: process.cwd(),
    });
  const targets = await collectLegacyPluginDependencyTargetEntries(env, {
    packageRoot,
  });
  const cleanupRootPaths = collectCleanupRootPaths(env, packageRoot);
  const cleanupRoots = await collectExistingCleanupRoots(cleanupRootPaths);
  const staleRootCandidates = filterLegacyStaleRootCandidates(targets, cleanupRootPaths);
  const preparedTargets = await prepareCleanupTargets(staleRootCandidates.targets, cleanupRoots);
  return preparedTargets.removalTargets.map(
    (target): LegacyPluginDependencyStateIssue => ({
      kind: "legacy-plugin-dependency-state",
      path: target,
    }),
  );
}

export function legacyPluginDependencyStateIssueToHealthFinding(
  issue: LegacyPluginDependencyStateIssue,
): HealthFinding {
  return {
    checkId: "core/doctor/legacy-plugin-dependencies",
    severity: "warning",
    message: `Legacy plugin dependency state remains at ${issue.path}.`,
    target: issue.path,
    path: issue.path,
    requirement: "legacy-plugin-dependency-state-removed",
    fixHint: "Run `openclaw doctor --fix` to remove legacy plugin dependency state.",
  };
}

/** Remove legacy plugin dependency state under trusted OpenClaw cleanup roots. */
export async function cleanupLegacyPluginDependencyState(params: {
  env?: NodeJS.ProcessEnv;
  packageRoot?: string | null;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const env = params.env ?? process.env;
  const changes: string[] = [];
  const warnings: string[] = [];
  const packageRoot =
    params.packageRoot ??
    resolveOpenClawPackageRootSync({
      argv1: process.argv[1],
      moduleUrl: import.meta.url,
      cwd: process.cwd(),
    });
  const targets = await collectLegacyPluginDependencyTargetEntries(env, {
    packageRoot,
  });
  const cleanupRootPaths = collectCleanupRootPaths(env, packageRoot);
  const cleanupRoots = await collectExistingCleanupRoots(cleanupRootPaths);
  const staleRootCandidates = filterLegacyStaleRootCandidates(targets, cleanupRootPaths);
  warnings.push(...staleRootCandidates.warnings);
  const preparedTargets = await prepareCleanupTargets(staleRootCandidates.targets, cleanupRoots);
  warnings.push(...preparedTargets.warnings);
  const staleSymlinks = await removeStalePluginRuntimeSymlinks(packageRoot, {
    staleRoots: preparedTargets.staleRoots,
  });
  changes.push(...staleSymlinks.changes);
  warnings.push(...staleSymlinks.warnings);
  for (const target of preparedTargets.removalTargets) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      changes.push(`Removed legacy plugin dependency state: ${target}`);
    } catch (error) {
      warnings.push(`Failed to remove legacy plugin dependency state ${target}: ${String(error)}`);
    }
  }
  return { changes, warnings };
}

export const testing = {
  collectLegacyPluginDependencyTargets,
  detectLegacyPluginDependencyStateIssues,
  legacyPluginDependencyStateIssueToHealthFinding,
};
