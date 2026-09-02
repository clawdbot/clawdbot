/**
 * Runtime boundary-file facade for sandbox fs bridge path checks.
 *
 * Tests can mock this small module while the guard keeps using the shared
 * root-file open primitive that rejects symlink and path traversal escapes.
 */
export { openRootFile, type RootFileOpenResult } from "../../infra/boundary-file-read.js";
