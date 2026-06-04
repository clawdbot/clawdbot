// Exposes generic path guard helpers with fs-safe defaults.
import "./fs-safe-defaults.js";

// Generic path guard facade for containment checks and safe relative paths.
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
