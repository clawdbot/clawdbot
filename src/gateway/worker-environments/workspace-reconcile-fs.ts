import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError, type Root } from "../../infra/fs-safe.js";
import type { createStagedInputPathMatcher } from "../../media/staged-inputs.js";
import { runCommandBuffered } from "../../process/exec.js";
import { readWorkspaceFileSnapshotWithLimit } from "./workspace-actual-manifest.js";
import {
  MAX_RECONCILIATION_FILE_BYTES,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import { isDerivedWorkspacePath } from "./workspace-path-exclusions.js";

const PATCH_TIMEOUT_MS = 10 * 60_000;

export function localPath(root: string, relative: string): string {
  return path.join(root, ...relative.split("/"));
}

export async function removeEmptyWorkspaceDirectory(root: Root, entryPath: string): Promise<void> {
  let children: string[];
  try {
    children = await root.list(entryPath);
  } catch (error) {
    if (error instanceof FsSafeError && ["not-found", "path-alias"].includes(error.code)) {
      return;
    }
    throw error;
  }
  if (children.length > 0) {
    // Conflicted descendants deliberately keep their containing directory
    // even when the cloud result removed that directory.
    return;
  }
  try {
    await root.remove(entryPath);
  } catch (error) {
    if (error instanceof FsSafeError && ["not-found", "path-alias"].includes(error.code)) {
      return;
    }
    const racedChildren = await root.list(entryPath).catch(() => undefined);
    if (racedChildren?.length) {
      return;
    }
    throw error;
  }
}

type WorkspaceFileSnapshot =
  | { type: "file"; mode: number; size: number; sha256: string }
  | { type: "unsupported" };

export async function readWorkspaceFileSnapshot(
  root: string,
  entryPath: string,
): Promise<WorkspaceFileSnapshot> {
  const absolute = localPath(root, entryPath);
  return await readWorkspaceFileSnapshotWithLimit(absolute, MAX_RECONCILIATION_FILE_BYTES, root);
}

async function readAbsoluteFileSnapshot(absolute: string): Promise<WorkspaceFileSnapshot> {
  return await readWorkspaceFileSnapshotWithLimit(absolute, MAX_RECONCILIATION_FILE_BYTES);
}

export async function absoluteEntryMatches(
  absolute: string,
  entry: WorkerWorkspaceManifestEntry,
): Promise<boolean> {
  const stats = await fs.lstat(absolute).catch(() => undefined);
  if (!stats) {
    return false;
  }
  if (entry.type === "symlink") {
    return stats.isSymbolicLink() && (await fs.readlink(absolute)) === entry.target;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return false;
  }
  const snapshot = await readAbsoluteFileSnapshot(absolute).catch(() => undefined);
  return (
    snapshot?.type === "file" &&
    snapshot.mode === entry.mode &&
    snapshot.size === entry.size &&
    snapshot.sha256 === entry.sha256
  );
}

export async function entryMatches(
  root: string,
  entry: WorkerWorkspaceManifestEntry,
): Promise<boolean> {
  if (entry.type === "symlink") {
    return await absoluteEntryMatches(localPath(root, entry.path), entry);
  }
  const snapshot = await readWorkspaceFileSnapshot(root, entry.path).catch(() => undefined);
  return (
    snapshot?.type === "file" &&
    snapshot.mode === entry.mode &&
    snapshot.size === entry.size &&
    snapshot.sha256 === entry.sha256
  );
}

export async function readWorkspaceTreeFile(params: {
  repositoryRoot: string;
  tree: string;
  entry: Extract<WorkerWorkspaceManifestEntry, { type: "file" }>;
}): Promise<Uint8Array> {
  const listed = await runCommandBuffered(
    [
      "git",
      "--literal-pathspecs",
      "-C",
      params.repositoryRoot,
      "ls-tree",
      "-z",
      "--full-tree",
      params.tree,
      "--",
      params.entry.path,
    ],
    {
      timeoutMs: PATCH_TIMEOUT_MS,
      maxOutputBytes: 1024 * 1024,
    },
  );
  if (listed.termination !== "exit" || listed.code !== 0) {
    throw new Error(listed.stderr.toString("utf8").trim() || "git ls-tree failed");
  }
  const record = listed.stdout;
  const terminator = record.indexOf(0);
  const separator = record.indexOf(9);
  if (terminator !== record.byteLength - 1 || separator < 0 || separator > terminator) {
    throw new Error(`Cloud workspace recovery snapshot is missing: ${params.entry.path}`);
  }
  const metadata = record.subarray(0, separator).toString("utf8");
  const match = /^100(?:644|755) blob ([a-f0-9]{40})$/u.exec(metadata);
  const listedPath = record.subarray(separator + 1, terminator);
  if (!match || !listedPath.equals(Buffer.from(params.entry.path))) {
    throw new Error(`Cloud workspace recovery snapshot is invalid: ${params.entry.path}`);
  }
  const blob = await runCommandBuffered(
    ["git", "-C", params.repositoryRoot, "cat-file", "blob", match[1]!],
    {
      timeoutMs: PATCH_TIMEOUT_MS,
      maxOutputBytes: MAX_RECONCILIATION_FILE_BYTES + 1,
    },
  );
  if (blob.termination !== "exit" || blob.code !== 0) {
    throw new Error(blob.stderr.toString("utf8").trim() || "git cat-file failed");
  }
  return blob.stdout;
}

export async function directoryContainsOnlyJournalPaths(
  root: string,
  directory: string,
  paths: ReadonlySet<string>,
  directories: ReadonlySet<string>,
  isRetainedInput: ReturnType<typeof createStagedInputPathMatcher>,
): Promise<boolean> {
  for (const name of await fs.readdir(localPath(root, directory))) {
    const child = `${directory}/${name}`;
    if (isDerivedWorkspacePath(child, await isRetainedInput(child))) {
      continue;
    }
    const stats = await fs.lstat(localPath(root, child));
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      if (
        !directories.has(child) &&
        !(await directoryContainsOnlyDerivedWorkspaceEntries(root, child, isRetainedInput))
      ) {
        return false;
      }
      if (
        directories.has(child) &&
        !(await directoryContainsOnlyJournalPaths(root, child, paths, directories, isRetainedInput))
      ) {
        return false;
      }
    } else if (!paths.has(child)) {
      return false;
    }
  }
  return true;
}

export async function directoryContainsOnlyDerivedWorkspaceEntries(
  root: string,
  directory: string,
  isRetainedInput: ReturnType<typeof createStagedInputPathMatcher>,
): Promise<boolean> {
  const names = await fs.readdir(localPath(root, directory));
  let foundDerivedEntry = false;
  for (const name of names) {
    const child = `${directory}/${name}`;
    if (isDerivedWorkspacePath(child, await isRetainedInput(child))) {
      foundDerivedEntry = true;
      continue;
    }
    const stats = await fs.lstat(localPath(root, child));
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      !(await directoryContainsOnlyDerivedWorkspaceEntries(root, child, isRetainedInput))
    ) {
      return false;
    }
    foundDerivedEntry = true;
  }
  return foundDerivedEntry;
}

export async function clearTemporaryWorkspace(repositoryRoot: string): Promise<void> {
  for (const name of await fs.readdir(repositoryRoot)) {
    if (name !== ".git") {
      await fs.rm(path.join(repositoryRoot, name), { recursive: true, force: true });
    }
  }
}
