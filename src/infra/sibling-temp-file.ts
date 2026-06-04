// Exposes sibling temp file writes with fs-safe defaults.
import "./fs-safe-defaults.js";

// Atomic sibling temp writes preserve target-directory permissions and avoid
// cross-device rename behavior.
export {
  writeSiblingTempFile,
  type WriteSiblingTempFileOptions,
  type WriteSiblingTempFileResult,
} from "@openclaw/fs-safe/advanced";
