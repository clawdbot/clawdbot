/** Plugin-local re-export of shared path safety helpers for plugin install/runtime code. */
export {
  isPathInside,
  safeRealpathSync,
  safeStatSync,
  formatPosixMode,
} from "../infra/path-safety.js";
