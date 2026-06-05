/**
 * Browser route output-path barrel.
 *
 * Re-exports the path scope and default media directories used by route modules
 * without exposing the broader browser paths implementation at each call site.
 */
export {
  DEFAULT_DOWNLOAD_DIR,
  DEFAULT_TRACE_DIR,
  DEFAULT_UPLOAD_DIR,
  pathScope,
  resolveExistingPathsWithinRoot,
  resolveWritablePathWithinRoot,
} from "../paths.js";
