/**
 * Browser route output-path barrel.
 *
 * Re-exports the path scope and default media directories used by route modules
 * without exposing the broader browser paths implementation at each call site.
 */
export { DEFAULT_DOWNLOAD_DIR, DEFAULT_TRACE_DIR } from "../paths.js";
export { pathScope } from "../../sdk-security-runtime.js";
