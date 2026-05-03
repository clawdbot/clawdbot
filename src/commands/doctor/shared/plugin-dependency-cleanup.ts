import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import { resolveOpenClawPackageRootSync } from "../../../infra/openclaw-root.js";
import { resolveConfigDir, resolveUserPath } from "../../../utils.js";

const LEGACY_DIRECT_CHILD_NAMES = new Set(["plugin-runtime-deps", "bundled-plugin-runtime-deps"]);

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

function isLegacyDependencyDebrisName(name: string): boolean {
  return (
    isRuntimeDependencyMarkerName(name) ||
    name === ".openclaw-pnpm-store" ||
    name === ".openclaw-install-backups" ||
    name.startsWith(".openclaw-install-stage-")
  );
}

async function collectDirectChildren(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.map((entry) => path.join(root, entry.name));
}

async function collectLegacyExtensionDebris(extensionsRoot: string): Promise<string[]> {
  const pluginDirs = await fs.readdir(extensionsRoot, { withFileTypes: true }).catch(() => []);
  const targets: string[] = [];
  for (const entry of pluginDirs) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const pluginRoot = path.join(extensionsRoot, entry.name);
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

async function collectLegacyPluginDependencyTargets(
  env: NodeJS.ProcessEnv = process.env,
  options: { packageRoot?: string | null } = {},
): Promise<string[]> {
  const packageRoot =
    options.packageRoot ??
    resolveOpenClawPackageRootSync({
      argv1: process.argv[1],
      moduleUrl: import.meta.url,
      cwd: process.cwd(),
    });
  const roots = uniqueSorted([resolveStateDir(env), resolveConfigDir(env), packageRoot]);
  const explicitStageRoots = splitPathList(env.OPENCLAW_PLUGIN_STAGE_DIR).map((entry) =>
    resolveUserPath(entry, env),
  );
  const stateDirectoryRoots = splitPathList(env.STATE_DIRECTORY).map((entry) =>
    path.join(resolveUserPath(entry, env), "plugin-runtime-deps"),
  );
  const targets = [
    ...explicitStageRoots,
    ...stateDirectoryRoots,
    ...roots.flatMap((root) => [
      ...[...LEGACY_DIRECT_CHILD_NAMES].map((name) => path.join(root, name)),
      path.join(root, ".local", "bundled-plugin-runtime-deps"),
    ]),
  ];
  for (const root of roots) {
    targets.push(...(await collectLegacyExtensionDebris(path.join(root, "extensions"))));
    targets.push(...(await collectLegacyExtensionDebris(path.join(root, "dist", "extensions"))));
  }
  return uniqueSorted(targets);
}

export async function cleanupLegacyPluginDependencyState(params: {
  env?: NodeJS.ProcessEnv;
  packageRoot?: string | null;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const env = params.env ?? process.env;
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const target of await collectLegacyPluginDependencyTargets(env, {
    packageRoot: params.packageRoot,
  })) {
    if (!(await pathExists(target))) {
      continue;
    }
    try {
      await fs.rm(target, { recursive: true, force: true });
      changes.push(`Removed legacy plugin dependency state: ${target}`);
    } catch (error) {
      warnings.push(`Failed to remove legacy plugin dependency state ${target}: ${String(error)}`);
    }
  }
  return { changes, warnings };
}

export const __testing = {
  collectLegacyPluginDependencyTargets,
};
