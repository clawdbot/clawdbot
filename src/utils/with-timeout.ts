/**
 * Compatibility export for timeout-wrapped operations.
 *
 * The implementation lives in infra/fs-safe; this keeps older utils imports on
 * the same public helper without duplicating timeout behavior.
 */
export { withTimeout } from "../infra/fs-safe.js";
