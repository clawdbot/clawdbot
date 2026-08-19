/**
 * Type-only schema barrel for the package root.
 *
 * Routing root type exports through the runtime-only `protocol-schemas`
 * registry retains the full registry in downstream declaration bundles.
 */
export type * from "./schema-modules.js";
export type { SessionsPatchResult } from "./sessions-patch-result.js";
