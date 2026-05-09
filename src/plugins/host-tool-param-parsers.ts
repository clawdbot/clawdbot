import {
  extractApplyPatchTargetPaths,
  type ApplyPatchPathExtractionOptions,
} from "../agents/apply-patch-paths.js";

/**
 * Derived metadata stamped on `before_tool_call` events for plugin handlers.
 *
 * The host owns best-effort parsing of well-known tool param shapes
 * (e.g. apply_patch). Plugins can use these fields as hints, but should still
 * parse params themselves when policy correctness depends on exact targets. The
 * host derives the initial call and re-derives only when a trusted policy
 * rewrites params. Fields are optional and additive: a missing field means
 * derivation produced nothing usable, never that it failed loudly.
 */
export type HostToolDerivedParams = {
  /** Best-effort destination path hints the tool may read or write, when discoverable. */
  derivedPaths?: readonly string[];
};

export type HostToolDerivationOptions = ApplyPatchPathExtractionOptions;

/**
 * Per-tool host-owned param derivers. Keep this map small and focused — every
 * entry runs synchronously inside the before_tool_call hot path.
 */
const HOST_TOOL_PARAM_PARSERS: Record<
  string,
  (params: unknown, options?: HostToolDerivationOptions) => HostToolDerivedParams
> = {
  apply_patch: (params, options) => {
    const paths = extractApplyPatchTargetPaths(params, options);
    return paths.length > 0 ? { derivedPaths: Object.freeze([...paths]) } : {};
  },
};

/**
 * Derive host-owned metadata for a tool call. Returns an empty object when no
 * parser is registered for the tool, which lets callers spread the result
 * unconditionally without a nullability check.
 */
export function deriveToolParams(
  toolName: string,
  params: unknown,
  options?: HostToolDerivationOptions,
): HostToolDerivedParams {
  if (!Object.hasOwn(HOST_TOOL_PARAM_PARSERS, toolName)) {
    return {};
  }
  const parser = HOST_TOOL_PARAM_PARSERS[toolName];
  return parser ? parser(params, options) : {};
}
