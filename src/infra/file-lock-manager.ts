// Exposes lifecycle-owned file lock managers with fs-safe defaults.
import "./fs-safe-defaults.js";
import type { Root as FsSafeRoot } from "@openclaw/fs-safe/root";

// Process-local file lock manager used by code that needs explicit lifecycle
// control instead of a one-shot withFileLock call.
export {
  acquireFileLockSync,
  createFileLockManager,
  type FileLockSyncAcquireOptions,
  type FileLockSyncHandle,
} from "@openclaw/fs-safe/file-lock";

/** Recover the full runtime Root type for core-only lockRoot use. */
export function asFsSafeFileLockRoot(root: Omit<FsSafeRoot, "walk">): FsSafeRoot {
  return root as FsSafeRoot;
}
