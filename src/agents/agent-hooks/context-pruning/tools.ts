/** Tool-name matching helpers for context-pruning eligibility. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { compileGlobPatterns, matchesAnyGlobPattern } from "../../glob-pattern.js";
import type { ContextPruningToolMatch } from "./settings.js";

// Tool-name matcher used by context pruning to decide which tool-result blocks
// are safe to prune.
function normalizeGlob(value: string) {
  return normalizeLowercaseStringOrEmpty(value ?? "");
}

/** Build a deny-first allowlist predicate for context-prunable tool names. */
export function makeToolPrunablePredicate(
  match: ContextPruningToolMatch,
): (toolName: string) => boolean {
  const deny = compileGlobPatterns({ raw: match.deny, normalize: normalizeGlob });
  const allow = compileGlobPatterns({ raw: match.allow, normalize: normalizeGlob });

  return (toolName: string) => {
    const normalized = normalizeGlob(toolName);
    if (matchesAnyGlobPattern(normalized, deny)) {
      return false;
    }
    if (allow.length === 0) {
      return true;
    }
    return matchesAnyGlobPattern(normalized, allow);
  };
}
