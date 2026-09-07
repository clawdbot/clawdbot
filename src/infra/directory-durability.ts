import fsSync, { type Stats } from "node:fs";
import fs from "node:fs/promises";
import {
  publishFileExclusive,
  syncDirectory,
  type DirectorySyncOutcome,
  type PublishFileExclusiveFailureDetails,
  type PublishFileExclusiveFailurePhase,
  type PublishFileExclusiveResult,
} from "@openclaw/fs-safe/durability";
import { sameFileIdentity } from "./fs-safe-advanced.js";
import { FsSafeError } from "./fs-safe.js";

export {
  ensureDurableDirectory,
  isHardlinkFallbackError,
  pinDirectory,
  publishFileExclusive,
  sha256File,
  syncDirectory,
  syncDirectoryBestEffortSync,
  syncDirectorySync,
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

export function getPublishFileExclusiveFailureDetails(
  error: unknown,
): PublishFileExclusiveFailureDetails | undefined {
  if (!(error instanceof FsSafeError)) {
    return undefined;
  }
  const details = error.details;
  if (
    !details ||
    typeof details.targetCreated !== "boolean" ||
    (details.cleanup !== "removed" &&
      details.cleanup !== "preserved" &&
      details.cleanup !== "unknown")
  ) {
    return undefined;
  }
  return details as PublishFileExclusiveFailureDetails;
}

function postPublicationFailure(params: {
  error: unknown;
  phase: PublishFileExclusiveFailurePhase;
  published: PublishFileExclusiveResult;
}): FsSafeError {
  const cause = params.error instanceof Error ? params.error : new Error(String(params.error));
  return new FsSafeError(
    params.error instanceof FsSafeError ? params.error.code : "helper-failed",
    `File publication failed after target creation: ${cause.message}`,
    {
      cause,
      details: {
        phase: params.phase,
        targetCreated: true,
        targetIdentity: {
          dev: params.published.identity.dev,
          ino: params.published.identity.ino,
        },
        // After publication succeeds, pathname cleanup cannot atomically prove
        // it still owns the target. Callers use this receipt with their pinned guards.
        cleanup: "preserved",
      } satisfies PublishFileExclusiveFailureDetails,
    },
  );
}

export function sameFileStatFingerprint(left: Stats, right: Stats): boolean {
  // Hard-link creation/removal changes ctime. The remaining fields bind the
  // pathname to the published bytes even when Windows recycles a file identity.
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function publicationVerificationPhase(
  published: PublishFileExclusiveResult,
): PublishFileExclusiveFailurePhase {
  return published.method === "hardlink" ? "hardlink-verify" : "copy-verify";
}

function assertPublishedTargetFingerprint(
  targetPath: string,
  expectedIdentity: Stats,
  message: string,
): void {
  const currentTarget = fsSync.lstatSync(targetPath);
  if (!currentTarget.isFile() || !sameFileStatFingerprint(expectedIdentity, currentTarget)) {
    throw new Error(`${message}: ${targetPath}`);
  }
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
  const verificationPhase = publicationVerificationPhase(published);
  try {
    if (
      published.method === "hardlink" &&
      !sameFileStatFingerprint(sourceIdentity, published.identity)
    ) {
      throw new Error(`File publication target changed after hard-link creation: ${targetPath}`);
    }
    assertPublishedTargetFingerprint(
      targetPath,
      published.identity,
      "File publication target changed after creation",
    );
  } catch (error) {
    throw postPublicationFailure({ error, phase: verificationPhase, published });
  }
  const degraded = published.directorySync.status === "unsupported";
  if (options.durability === "fail-closed") {
    try {
      requireDirectorySync(published.directorySync, "File publication directory");
    } catch (error) {
      throw postPublicationFailure({
        error,
        phase: "directory-sync",
        published,
      });
    }
  }

  if (options.moveSource) {
    try {
      const currentSource = fsSync.lstatSync(sourcePath);
      if (!currentSource.isFile() || !sameFileStatFingerprint(currentSource, sourceIdentity)) {
        throw new Error(`File publication source changed before removal: ${sourcePath}`);
      }
      assertPublishedTargetFingerprint(
        targetPath,
        published.identity,
        "File publication target changed before source removal",
      );
      // Keep the final ownership fence and unlink in one synchronous section so
      // another in-process publication cannot interleave between them.
      fsSync.unlinkSync(sourcePath);
      assertPublishedTargetFingerprint(
        targetPath,
        published.identity,
        "File publication target changed after source removal",
      );
    } catch (error) {
      throw postPublicationFailure({
        error,
        phase: verificationPhase,
        published,
      });
    }
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
