// Exposes lifecycle-owned file lock managers with fs-safe defaults.
import "./fs-safe-defaults.js";

// Process-local file lock manager used by code that needs explicit lifecycle
// control instead of a one-shot withFileLock call.
export {
  createFileLockManager,
  type FileLockHeldEntry,
  type FileLockManager,
} from "@openclaw/fs-safe/file-lock";
