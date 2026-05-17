/**
 * `@openclaw/oc-path` — substrate package public surface.
 *
 * **Strategic frame**: workspace files are byte-stable and addressable
 * via the `oc://` scheme — the addressing scheme is universal across
 * file kinds (md / jsonc / jsonl / yaml). Encoding (parse/emit) is per-kind;
 * addressing (resolve/set) is universal.
 *
 * **Public verbs**:
 *   - One `resolveOcPath(ast, path)` - concrete, kind-dispatched
 *   - One `findOcPaths(ast, pattern)` - multi-match, kind-dispatched
 *   - One `setOcPath(ast, path, value)` - concrete mutation / insertion
 *   - Per-kind `parseXxx` / `emitXxx` (parsing is per-kind by nature)
 *
 * `setOcPath` accepts a string value; the substrate coerces based on
 * AST shape at the path location. The OcPath syntax encodes the
 * operation: plain path = leaf set, `+` suffix = insertion.
 *
 * Per-kind set/resolve helpers exist as internal implementation; they
 * aren't on the public surface. Callers don't need to pick a kind -
 * the AST carries its `kind` discriminator and the universal verbs
 * dispatch internally.
 *
 * @module @openclaw/oc-path
 */

/**
 * SDK version this build of `@openclaw/oc-path` exposes. Bumped on
 * every breaking change to AST shape, OcPath syntax, or universal
 * verbs (`resolveOcPath`, `setOcPath`, `findOcPaths`, `parseXxx`,
 * `emitXxx`). Plugin packs that depend on the substrate declare the
 * version they were authored against and the host warns on mismatch.
 */
export const SDK_VERSION = "0.1.0";

// AST types
export type { AstBlock, AstItem, Diagnostic, FrontmatterEntry, ParseResult, MdAst } from "./ast.js";
export type { JsoncAst, JsoncEntry, JsoncValue } from "./jsonc/ast.js";
export type { JsonlAst, JsonlLine } from "./jsonl/ast.js";
export type { YamlAst } from "./yaml/ast.js";

// OcPath types + parser/formatter
export type { OcPath, PathSegmentLayout, PositionalContainer, PredicateSpec } from "./oc-path.js";
// Public OcPath surface — what plugin authors and callers use.
export {
  MAX_PATH_LENGTH,
  MAX_SUB_SEGMENTS_PER_SLOT,
  MAX_TRAVERSAL_DEPTH,
  OcPathError,
  POS_FIRST,
  POS_LAST,
  WILDCARD_RECURSIVE,
  WILDCARD_SINGLE,
  formatOcPath,
  hasWildcard,
  isOrdinalSeg,
  isPattern,
  isPositionalSeg,
  isPredicateSeg,
  isQuotedSeg,
  isUnionSeg,
  isValidOcPath,
  parseOcPath,
} from "./oc-path.js";

// `evaluatePredicate`, `getPathLayout`, `parseOrdinalSeg`,
// `parsePredicateSeg`, `parseUnionSeg`, `quoteSeg`, `unquoteSeg`,
// `repackPath`, `resolvePositionalSeg`, `splitRespectingBrackets`
// were exported from earlier prototypes. They're substrate-internal
// helpers — used by `find.ts`, the per-kind resolvers, and the parser
// itself, but not part of the upstream-portable public surface.
// Callers that need their behavior should round-trip through
// `parseOcPath` / `formatOcPath` / `findOcPaths`.

// Per-kind parse / emit (encoding is genuinely per-kind)
export { parseMd } from "./parse.js";
export { parseJsonc } from "./jsonc/parse.js";
export { parseJsonl } from "./jsonl/parse.js";
export { parseYaml } from "./yaml/parse.js";
export type { JsoncParseResult } from "./jsonc/parse.js";
export type { JsonlParseResult } from "./jsonl/parse.js";
export type { YamlParseResult } from "./yaml/parse.js";

export type { EmitOptions } from "./emit.js";
export { emitMd, markDirty } from "./emit.js";
export type { JsoncEmitOptions } from "./jsonc/emit.js";
export { emitJsonc } from "./jsonc/emit.js";
export type { JsonlEmitOptions } from "./jsonl/emit.js";
export { emitJsonl } from "./jsonl/emit.js";
export type { YamlEmitOptions } from "./yaml/emit.js";
export { emitYaml } from "./yaml/emit.js";

// Universal verbs — the only public resolve / set on the surface.
export type {
  OcAst,
  OcMatch,
  LeafType,
  NodeDescriptor,
  ContainerKind,
  SetResult,
  InsertionInfo,
} from "./universal.js";
export { resolveOcPath, setOcPath, detectInsertion } from "./universal.js";

// Multi-match search verb — the wildcard-accepting cousin of resolve.
export type { OcPathMatch } from "./find.js";
export { findOcPaths } from "./find.js";

// Cross-kind utility — filename → kind hint.
export { inferKind } from "./dispatch.js";
export type { OcKind } from "./dispatch.js";

// Sentinel guard
export { OcEmitSentinelError, REDACTED_SENTINEL, guardSentinel } from "./sentinel.js";

// Slug helper
export { slugify } from "./slug.js";

// Workspace manifest is a separate concern (filesystem classifier);
// it's not part of this PR's scope.
