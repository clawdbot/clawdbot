// Provides stricter filesystem helpers for canonical path and symlink-sensitive operations.
import "./fs-safe-defaults.js";

// Advanced fs-safe helpers for symlink, hardlink, and sibling-temp protections.
export {
  assertNoHardlinkedFinalPath,
  assertNoSymlinkParents,
  assertNoSymlinkParentsSync,
  sameFileIdentity,
  sanitizeUntrustedFileName,
  writeSiblingTempFile,
  writeViaSiblingTempPath,
  type AssertNoSymlinkParentsOptions,
  type FileIdentityStat,
} from "@openclaw/fs-safe/advanced";
