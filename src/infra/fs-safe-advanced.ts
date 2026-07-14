// Provides stricter filesystem helpers for canonical path and symlink-sensitive operations.
import "./fs-safe-defaults.js";

// Advanced fs-safe helpers for symlink, hardlink, and sibling-temp protections.
export {
  assertNoSymlinkParents,
  assertNoSymlinkParentsSync,
  sameFileIdentity,
  sanitizeUntrustedFileName,
  writeViaSiblingTempPath,
  type AssertNoSymlinkParentsOptions,
} from "@openclaw/fs-safe/advanced";
