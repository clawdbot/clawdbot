import fs from "node:fs/promises";
import path from "node:path";
import {
  isHardlinkFallbackError,
  publishFileExclusive,
  syncDirectory,
  type DirectorySyncOutcome,
  type PublishFileExclusiveResult,
} from "@openclaw/fs-safe/durability";
import { sameFileIdentity } from "./fs-safe-advanced.js";

export {
  ensureDurableDirectory,
  isHardlinkFallbackError,
  pinDirectory,
  publishFileExclusive,
  syncDirectory,
  syncDirectoryBestEffortSync,
  type DirectorySyncOutcome,
  type DurableDirectoryReceipt,
  type PinnedDirectory,
  type PublishFileExclusiveResult,
  type PublishFileExclusiveStrategy,
} from "@openclaw/fs-safe/durability";

export type FilePublicationOptions = {
  strategy: "link-required" | "link-or-copy";
  moveSource?: boolean;
  durability: "fail-closed" | "degrade";
};

export type FilePublicationResult = PublishFileExclusiveResult & {
  durability: "durable" | "degraded";
};

type DirectoryDurabilityOutcome = DirectorySyncOutcome | { status: "not-needed" };

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EINVAL" ||
    code === "ENOTSUP" ||
    code === "ENOSYS" ||
    (process.platform === "win32" && (code === "EISDIR" || code === "EPERM" || code === "EACCES"))
  );
}

/** Require a real directory sync at product commit boundaries. */
export function requireDirectorySync(outcome: DirectoryDurabilityOutcome, label: string): void {
  if (outcome.status !== "unsupported" || process.platform === "win32") {
    return;
  }
  const code = outcome.code ? ` (${outcome.code})` : "";
  throw new Error(`${label} does not support crash-durable directory synchronization${code}.`);
}

/** Publish one file without replacement under OpenClaw's durability policy. */
export async function publishFileNoClobber(
  sourcePath: string,
  targetPath: string,
  options: FilePublicationOptions,
): Promise<FilePublicationResult> {
  const sourceIdentity = await fs.lstat(sourcePath);
  const published = await publishFileExclusive({
    sourcePath,
    targetPath,
    expectedSourceIdentity: sourceIdentity,
    strategy: options.strategy,
  });
  const directorySync = await syncDirectory(path.dirname(targetPath), {
    label: "file publication directory",
  });
  const result = { ...published, directorySync };
  const degraded = directorySync.status === "unsupported";
  if (options.durability === "fail-closed") {
    requireDirectorySync(directorySync, "File publication directory");
  }

  if (options.moveSource) {
    const currentSource = await fs.lstat(sourcePath);
    if (!currentSource.isFile() || !sameFileIdentity(currentSource, sourceIdentity)) {
      throw new Error(`File publication source changed before removal: ${sourcePath}`);
    }
    await fs.unlink(sourcePath);
    const currentTarget = await fs.lstat(targetPath);
    if (!currentTarget.isFile() || !sameFileIdentity(currentTarget, result.identity)) {
      throw new Error(`Published file changed after source removal: ${targetPath}`);
    }
  }

  return { ...result, durability: degraded ? "degraded" : "durable" };
}

/** Compatibility adapter for former best-effort call sites. */
export async function syncDirectoryIfSupported(
  directoryPath: string,
): Promise<DirectorySyncOutcome> {
  try {
    return await syncDirectory(directoryPath);
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) {
      throw error;
    }
    const code = (error as NodeJS.ErrnoException).code;
    return code ? { status: "unsupported", code } : { status: "unsupported" };
  }
}
