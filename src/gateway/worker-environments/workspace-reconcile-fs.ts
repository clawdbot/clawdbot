import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { runCommandBuffered } from "../../process/exec.js";
import {
  gitFileMode,
  MAX_RECONCILIATION_FILE_BYTES,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import { isDerivedWorkspacePath } from "./workspace-path-exclusions.js";

const PATCH_TIMEOUT_MS = 10 * 60_000;

export function localPath(root: string, relative: string): string {
  return path.join(root, ...relative.split("/"));
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
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
  return (
    stats.isFile() &&
    !stats.isSymbolicLink() &&
    gitFileMode(stats.mode & 0o777) === entry.mode &&
    stats.size === entry.size &&
    (await sha256File(absolute)) === entry.sha256
  );
}

export async function entryMatches(
  root: string,
  entry: WorkerWorkspaceManifestEntry,
): Promise<boolean> {
  return await absoluteEntryMatches(localPath(root, entry.path), entry);
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
): Promise<boolean> {
  for (const name of await fs.readdir(localPath(root, directory))) {
    const child = `${directory}/${name}`;
    if (isDerivedWorkspacePath(child)) {
      continue;
    }
    const stats = await fs.lstat(localPath(root, child));
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      if (!directories.has(child)) {
        return false;
      }
      if (!(await directoryContainsOnlyJournalPaths(root, child, paths, directories))) {
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
): Promise<boolean> {
  const names = await fs.readdir(localPath(root, directory));
  let foundDerivedEntry = false;
  for (const name of names) {
    const child = `${directory}/${name}`;
    if (isDerivedWorkspacePath(child)) {
      foundDerivedEntry = true;
      continue;
    }
    const stats = await fs.lstat(localPath(root, child));
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      !(await directoryContainsOnlyDerivedWorkspaceEntries(root, child))
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
