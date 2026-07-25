import fs from "node:fs/promises";
import {
  publishFileExclusive,
  syncDirectory,
  type DirectorySyncOutcome,
} from "@openclaw/fs-safe/durability";
import { sameFileIdentity } from "./fs-safe-advanced.js";

export {
  ensureDurableDirectory,
  isHardlinkFallbackError,
  pinDirectory,
  syncDirectory,
  syncDirectoryBestEffortSync,
  type DirectorySyncOutcome,
  type DirectoryReceipt,
  type DurableDirectoryReceipt,
  type PinnedDirectory,
} from "@openclaw/fs-safe/durability";

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
  options: {
    strategy: "link-required" | "link-or-copy";
    moveSource?: boolean;
    durability: "fail-closed" | "degrade";
  },
) {
  const sourceIdentity = await fs.lstat(sourcePath);
  const published = await publishFileExclusive({
    sourcePath,
    targetPath,
    expectedSourceIdentity: sourceIdentity,
    strategy: options.strategy,
  });
  const degraded = published.directorySync.status === "unsupported";
  if (options.durability === "fail-closed") {
    requireDirectorySync(published.directorySync, "File publication directory");
  }

  if (options.moveSource) {
    const currentSource = await fs.lstat(sourcePath);
    if (!currentSource.isFile() || !sameFileIdentity(currentSource, sourceIdentity)) {
      throw new Error(`File publication source changed before removal: ${sourcePath}`);
    }
    await fs.unlink(sourcePath);
  }

  return { ...published, durability: degraded ? "degraded" : "durable" };
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
