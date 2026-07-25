// Exposes root-scoped file open helpers with fs-safe defaults.
import "./fs-safe-defaults.js";
import {
  readFileDescriptorBounded as readFileDescriptorBoundedFsSafe,
  readFileDescriptorBoundedSync as readFileDescriptorBoundedSyncFsSafe,
} from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";

// Root-scoped file open helpers. Use these for user paths that must stay under
// an already trusted boundary.
export {
  canUseRootFileOpen,
  matchRootFileOpenFailure,
  openRootFile,
  openRootFileSync,
  type RootFileOpenFailure,
  type RootFileOpenResult,
} from "@openclaw/fs-safe/advanced";

function preserveOpenClawOverflowError(error: unknown, maxBytes: number): never {
  if (error instanceof FsSafeError && error.code === "too-large") {
    throw new RangeError(`File exceeds ${maxBytes} bytes`, { cause: error });
  }
  throw error;
}

/** Read a pinned descriptor without changing OpenClaw's user-facing overflow error. */
export async function readFileDescriptorBounded(fd: number, maxBytes: number): Promise<Buffer> {
  try {
    return await readFileDescriptorBoundedFsSafe(fd, maxBytes);
  } catch (error) {
    return preserveOpenClawOverflowError(error, maxBytes);
  }
}

/** Synchronous variant for callers that own a pinned descriptor. */
export function readFileDescriptorBoundedSync(fd: number, maxBytes: number): Buffer {
  try {
    return readFileDescriptorBoundedSyncFsSafe(fd, maxBytes);
  } catch (error) {
    return preserveOpenClawOverflowError(error, maxBytes);
  }
}
