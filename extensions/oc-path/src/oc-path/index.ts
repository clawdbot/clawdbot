/**
 * Internal substrate surface consumed by `openclaw path`.
 *
 * Keep this barrel limited to CLI imports. Per-kind helpers stay in their
 * owning modules.
 *
 * @module @openclaw/oc-path
 */

export type { OcPath } from "./oc-path.js";
export { OcPathError, formatOcPath, parseOcPath } from "./oc-path.js";

export { parseMd } from "./parse.js";
export { parseJsonc } from "./jsonc/parse.js";
export { parseJsonl } from "./jsonl/parse.js";
export { parseYaml } from "./yaml/parse.js";

export { emitMd } from "./emit.js";
export { emitJsonc } from "./jsonc/emit.js";
export { emitJsonl } from "./jsonl/emit.js";
export { emitYaml } from "./yaml/emit.js";

export type { OcAst, OcMatch } from "./universal.js";
export { resolveOcPath, setOcPath } from "./universal.js";

export { findOcPaths } from "./find.js";
export { inferKind } from "./dispatch.js";

export { OcEmitSentinelError, REDACTED_SENTINEL } from "./sentinel.js";
