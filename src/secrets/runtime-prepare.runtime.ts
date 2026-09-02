/**
 * Lazy runtime facade for preparing a secrets snapshot. Runtime callers import
 * this compact boundary to avoid pulling CLI/configure-only helpers.
 */
export { resolveSecretRefValues } from "./resolve.js";
export { collectAuthStoreAssignments } from "./runtime-auth-collectors.js";
export { collectConfigAssignments } from "./runtime-config-collectors.js";
export { applyResolvedAssignments, createResolverContext } from "./runtime-shared.js";
export { resolveRuntimeWebTools } from "./runtime-web-tools.js";
