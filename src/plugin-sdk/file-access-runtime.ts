// Safe local-file helpers for plugin runtime media and bridge code.

export {
  canonicalPathFromExistingAncestor,
  readFileWithinRoot,
  readLocalFileFromRoots,
  root,
  writeFileWithinRoot,
} from "../infra/fs-safe.js";
export {
  ensureDurableDirectory,
  syncDirectory,
  type DirectorySyncOutcome,
} from "../infra/directory-durability.js";
export { removePathWithinRoot } from "../infra/fs-safe-remove.js";
export { basenameFromMediaSource, safeFileURLToPath } from "../infra/local-file-access.js";
export { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
