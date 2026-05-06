// Safe local-file helpers for plugin runtime media and bridge code.

export {
  readFileWithinRoot,
  readLocalFileFromRoots,
  root,
  writeFileWithinRoot,
} from "../infra/fs-safe.js";
export { basenameFromMediaSource, safeFileURLToPath } from "../infra/local-file-access.js";
