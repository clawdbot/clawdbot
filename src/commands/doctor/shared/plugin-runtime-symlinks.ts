// Doctor detection and cleanup for stale global plugin-runtime symlinks.
import fs from "node:fs/promises";
import path from "node:path";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { note } from "../../../../packages/terminal-core/src/note.js";
import { shortenHomePath } from "../../../utils.js";

const PLUGIN_RUNTIME_DEPS_MARKER = "plugin-runtime-deps";
const MAX_REPORTED = 6;

interface FsLike {
  readdir(dir: string, options: { withFileTypes: true }): Promise<readonly DirentLike[]>;
  lstat(file: string): Promise<StatsLike>;
  readlink(file: string): Promise<string>;
  stat(file: string): Promise<unknown>;
  rm(file: string, options: { force: true }): Promise<void>;
  unlink?(file: string): Promise<void>;
}

interface DirentLike {
  name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

interface StatsLike {
  isSymbolicLink(): boolean;
}

export interface StalePluginRuntimeSymlink {
  /** Package or scoped package name for the stale symlink. */
  readonly name: string;
  /** Symlink path under the containing node_modules directory. */
  readonly path: string;
  /** Resolved target that is missing or belongs to stale cleanup roots. */
  readonly target: string;
}

export interface PluginRuntimeSymlinkOptions {
  /** Filesystem adapter for tests and doctor cleanup callers. */
  readonly fs?: FsLike;
  /** Roots already classified as stale by plugin dependency cleanup. */
  readonly staleRoots?: readonly string[];
}

const DEFAULT_FS: FsLike = {
  readdir: (dir, options) => fs.readdir(dir, options) as Promise<DirentLike[]>,
  lstat: (file) => fs.lstat(file),
  readlink: (file) => fs.readlink(file),
  stat: (file) => fs.stat(file),
  rm: (file, options) => fs.rm(file, options),
  unlink: (file) => fs.unlink(file),
};

/** Find global node_modules symlinks that still point at stale plugin-runtime deps. */
export async function collectStalePluginRuntimeSymlinks(
  packageRoot: string | null | undefined,
  options: PluginRuntimeSymlinkOptions = {},
): Promise<StalePluginRuntimeSymlink[]> {
  if (!packageRoot) {
    return [];
  }
  const containingNodeModules = path.dirname(packageRoot);
  if (path.basename(containingNodeModules) !== "node_modules") {
    return [];
  }

  const fsApi = options.fs ?? DEFAULT_FS;
  const staleRoots = uniqueResolvedRoots(options.staleRoots ?? []);
  const stale: StalePluginRuntimeSymlink[] = [];
  const entries = await fsApi
    .readdir(containingNodeModules, { withFileTypes: true })
    .catch(() => [] as DirentLike[]);
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith("@")) {
      const scopeDir = path.join(containingNodeModules, entry.name);
      const scopeEntries = await fsApi
        .readdir(scopeDir, { withFileTypes: true })
        .catch(() => [] as DirentLike[]);
      for (const scopeEntry of scopeEntries) {
        const fullPath = path.join(scopeDir, scopeEntry.name);
        const target = await inspectCandidate(fullPath, fsApi, staleRoots);
        if (target) {
          stale.push({ name: `${entry.name}/${scopeEntry.name}`, path: fullPath, target });
        }
      }
      continue;
    }
    if (!entry.isSymbolicLink()) {
      continue;
    }
    const fullPath = path.join(containingNodeModules, entry.name);
    const target = await inspectCandidate(fullPath, fsApi, staleRoots);
    if (target) {
      stale.push({ name: entry.name, path: fullPath, target });
    }
  }

  return stale.toSorted((left, right) => left.name.localeCompare(right.name));
}

/** Emit a doctor note describing stale plugin-runtime symlinks, if any exist. */
export async function noteStalePluginRuntimeSymlinks(
  packageRoot: string | null | undefined,
  options: PluginRuntimeSymlinkOptions & {
    readonly noteFn?: (message: string, title?: string) => void;
    readonly shortenPath?: (value: string) => string;
  } = {},
): Promise<void> {
  const stale = await collectStalePluginRuntimeSymlinks(packageRoot, options);
  if (stale.length === 0) {
    return;
  }

  const shortenPath = options.shortenPath ?? shortenHomePath;
  const lines = [
    "- Plugin-runtime symlinks under the global Node prefix point at pruned",
    `  ${PLUGIN_RUNTIME_DEPS_MARKER} directories from a previous OpenClaw install.`,
    "- Bundled plugin ESM imports can fail with ERR_MODULE_NOT_FOUND until repaired.",
  ];
  for (const item of stale.slice(0, MAX_REPORTED)) {
    lines.push(`  - ${item.name} -> ${shortenPath(item.target)}`);
  }
  if (stale.length > MAX_REPORTED) {
    lines.push(`  - ...and ${stale.length - MAX_REPORTED} more`);
  }
  lines.push("- Repair: run `openclaw doctor --fix` to remove the dangling symlinks.");
  (options.noteFn ?? note)(lines.join("\n"), "Plugin-runtime symlinks");
}

/** Remove stale plugin-runtime symlinks and report changes/warnings. */
export async function removeStalePluginRuntimeSymlinks(
  packageRoot: string | null | undefined,
  options: PluginRuntimeSymlinkOptions = {},
): Promise<{ changes: string[]; warnings: string[] }> {
  const fsApi = options.fs ?? DEFAULT_FS;
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const item of await collectStalePluginRuntimeSymlinks(packageRoot, options)) {
    try {
      if (fsApi.unlink) {
        await fsApi.unlink(item.path);
      } else {
        await fsApi.rm(item.path, { force: true });
      }
      changes.push(`Removed stale plugin-runtime symlink: ${item.path}`);
    } catch (error) {
      warnings.push(`Failed to remove stale plugin-runtime symlink ${item.path}: ${String(error)}`);
    }
  }
  return { changes, warnings };
}

function uniqueResolvedRoots(values: readonly string[]): string[] {
  return sortUniqueStrings(values.map((value) => path.resolve(value)));
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function inspectCandidate(
  fullPath: string,
  fsApi: FsLike,
  staleRoots: readonly string[],
): Promise<string | null> {
  const stat = await fsApi.lstat(fullPath).catch(() => null);
  if (!stat?.isSymbolicLink()) {
    return null;
  }
  const target = await fsApi.readlink(fullPath).catch(() => null);
  if (!target || !target.includes(PLUGIN_RUNTIME_DEPS_MARKER)) {
    return null;
  }
  const resolvedTarget = path.isAbsolute(target)
    ? target
    : path.resolve(path.dirname(fullPath), target);
  if (staleRoots.some((root) => isPathInsideRoot(resolvedTarget, root))) {
    return resolvedTarget;
  }
  try {
    await fsApi.stat(resolvedTarget);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? resolvedTarget : null;
  }
}
