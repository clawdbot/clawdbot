// Parses host tool parameters supplied by plugin tool contracts.
import {
  extractResolvedApplyPatchTargetPaths,
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
type HostToolDerivedParams = {
  /** Best-effort destination path hints the tool may read or write, when discoverable. */
  derivedPaths?: readonly string[];
};

type HostToolDerivationOptions = ApplyPatchPathExtractionOptions;

/**
 * Derive host-owned metadata for a tool call. Returns an empty object when no
 * parser is registered for the tool, which lets callers spread the result
 * unconditionally without a nullability check.
 */
export async function deriveToolParams(
  toolName: string,
  params: unknown,
  options?: HostToolDerivationOptions,
): Promise<HostToolDerivedParams> {
  if (toolName !== "apply_patch") {
    return {};
  }
  const paths = await extractResolvedApplyPatchTargetPaths(params, options);
  return paths.length > 0 ? { derivedPaths: Object.freeze([...paths]) } : {};
}
