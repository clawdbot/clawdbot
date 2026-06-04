// Exposes root-scoped file open helpers with fs-safe defaults.
import "./fs-safe-defaults.js";

// Root-scoped file open helpers. Use these for user paths that must stay under
// an already trusted boundary.
export {
  canUseRootFileOpen,
  matchRootFileOpenFailure,
  openRootFile,
  openRootFileSync,
  type OpenRootFileParams,
  type OpenRootFileSyncParams,
  type RootFileOpenFailure,
  type RootFileOpenFailureReason,
  type RootFileOpenResult,
} from "@openclaw/fs-safe/advanced";
