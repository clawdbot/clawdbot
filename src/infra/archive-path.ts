// Resolves archive paths through safe filesystem defaults.
import "./fs-safe-defaults.js";

// Archive path facade kept in infra so callers share one traversal policy.
export {
  isWindowsDrivePath,
  normalizeArchiveEntryPath,
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "@openclaw/fs-safe/archive";
