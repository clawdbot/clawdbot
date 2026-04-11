import { normalizeLowercaseStringOrEmpty } from "../../../shared/string-coerce.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "../../glob-pattern.js";
import type { ContextPruningToolMatch } from "./settings.js";

function normalizeGlob(value: string) {
  return normalizeLowercaseStringOrEmpty(value ?? "");
}

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
