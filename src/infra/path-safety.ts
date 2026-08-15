// Exposes path-safety helpers backed by fs-safe defaults.
import "./fs-safe-defaults.js";

// Back-compat import path for path guard helpers used across core surfaces.
export {
  isPathInside,
  isPathInsideWithRealpath,
  isWithinDir,
  safeRealpathSync,
  safeStatSync,
} from "@openclaw/fs-safe/path";
export { formatPosixMode } from "@openclaw/fs-safe/advanced";
