import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError, root as openFsSafeRoot, type Root } from "../../infra/fs-safe.js";
import {
  createStagedInputPathMatcher,
  isStagedInputPath,
  stagedInputDirectoriesFromEntries,
} from "../../media/staged-inputs.js";
import type { WorkerWorkspaceManifestEntry } from "./workspace-manifest.js";
import { isDerivedWorkspacePath } from "./workspace-path-exclusions.js";

export function reconciliationEntries(
  entries: readonly WorkerWorkspaceManifestEntry[],
  stagedInputDirectories: ReadonlySet<string> = stagedInputDirectoriesFromEntries(entries),
): WorkerWorkspaceManifestEntry[] {
  return entries.filter(
    (entry) =>
      !isDerivedWorkspacePath(entry.path, isStagedInputPath(entry.path, stagedInputDirectories)),
  );
}

export function reconciliationDirectories(
  directories: readonly string[] | undefined,
  stagedInputDirectories: ReadonlySet<string>,
): string[] {
  return (directories ?? []).filter(
    (directory) =>
      !isDerivedWorkspacePath(directory, isStagedInputPath(directory, stagedInputDirectories)),
  );
}

function localPath(root: string, relative: string): string {
  return path.join(root, ...relative.split("/"));
}

async function removeDerivedWorkspaceDescendants(
  root: Root,
  relativeDirectory: string,
  isRetainedInput: ReturnType<typeof createStagedInputPathMatcher>,
): Promise<void> {
  for (const entry of await root.list(relativeDirectory, { withFileTypes: true })) {
    const child = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (isDerivedWorkspacePath(child, await isRetainedInput(child))) {
      await removeDerivedWorkspaceEntry(root, child, entry.isDirectory);
      continue;
    }
    if (entry.isDirectory) {
      await removeDerivedWorkspaceDescendants(root, child, isRetainedInput);
      if ((await root.list(child)).length === 0) {
        // This traversal only runs beneath a manifest non-directory replacing
        // relativeDirectory. Every empty descendant belongs to that old namespace,
        // and pruning it unconditionally keeps interrupted cleanup resumable.
        await root.remove(child);
      }
    }
  }
}

async function removeDerivedWorkspaceEntry(
  root: Root,
  relativePath: string,
  isDirectory: boolean,
): Promise<void> {
  if (isDirectory) {
    let entries;
    try {
      entries = await root.list(relativePath, { withFileTypes: true });
    } catch (error) {
      if (!(error instanceof FsSafeError) || !["not-found", "path-alias"].includes(error.code)) {
        throw error;
      }
      entries = undefined;
    }
    for (const entry of entries ?? []) {
      await removeDerivedWorkspaceEntry(root, `${relativePath}/${entry.name}`, entry.isDirectory);
    }
  }
  await root.remove(relativePath).catch((error: unknown) => {
    if (!(error instanceof FsSafeError) || error.code !== "not-found") {
      throw error;
    }
  });
}

async function hasWorkspaceSymlinkAncestor(root: string, relativePath: string): Promise<boolean> {
  const segments = relativePath.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const stats = await fs
      .lstat(localPath(root, segments.slice(0, index).join("/")))
      .catch(() => undefined);
    if (stats?.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

export async function prepareNonDirectoryTargets(
  root: string,
  entries: readonly WorkerWorkspaceManifestEntry[],
  retainedInput?: ReturnType<typeof createStagedInputPathMatcher>,
): Promise<void> {
  const workspaceRoot = await openFsSafeRoot(root);
  const isRetainedInput = retainedInput ?? createStagedInputPathMatcher(workspaceRoot);
  // Entries are an already-selected delta; an unchanged ownership marker may be absent.
  for (const entry of entries) {
    if (await hasWorkspaceSymlinkAncestor(root, entry.path)) {
      continue;
    }
    let stats;
    try {
      stats = await workspaceRoot.stat(entry.path);
    } catch (error) {
      if (error instanceof FsSafeError && ["not-found", "path-alias"].includes(error.code)) {
        continue;
      }
      throw error;
    }
    if (stats.isDirectory) {
      // Excluded descendants cannot fence a namespace replacement, but Git
      // cannot replace their still-nonempty parent until they are removed.
      // fs-safe binds traversal/removal to root-relative directory handles, so
      // a symlink swap cannot redirect cleanup outside this workspace.
      await removeDerivedWorkspaceDescendants(workspaceRoot, entry.path, isRetainedInput);
      if ((await workspaceRoot.list(entry.path)).length === 0) {
        await workspaceRoot.remove(entry.path);
      }
    }
  }
}
