// Exposes path-safety helpers backed by fs-safe defaults.
import "./fs-safe-defaults.js";

// Back-compat import path for path guard helpers used across core surfaces.
export {
  isNotFoundPathError,
  hasNodeErrorCode,
  isNodeError,
  isPathInside,
  isPathInsideWithRealpath,
  isSymlinkOpenError,
  isWithinDir,
  normalizeWindowsPathForComparison,
  resolveSafeBaseDir,
  resolveSafeRelativePath,
  safeRealpathSync,
  safeStatSync,
  splitSafeRelativePath,
} from "@openclaw/fs-safe/path";
export { formatPosixMode } from "@openclaw/fs-safe/advanced";
