/** Plugin-local re-export of shared path safety helpers for plugin install/runtime code. */
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
  formatPosixMode,
} from "../infra/path-safety.js";
