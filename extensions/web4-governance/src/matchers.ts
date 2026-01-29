/**
 * Matchers - Glob and regex matching for policy rules.
 *
 * Used to match tool names, categories, and target strings
 * against policy rule criteria.
 */

import type { ToolCategory } from "./r6.js";
import type { PolicyMatch } from "./policy-types.js";

/**
 * Convert a glob pattern to a regex.
 * Supports: * (any chars except /), ** (any chars including /), ? (single char)
 */
export function globToRegex(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
        // Skip trailing slash after **
        if (pattern[i] === "/") i++;
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (".+^${}()|[]\\".includes(ch)) {
      re += "\\" + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return new RegExp("^" + re + "$");
}

/** Check if a value matches any entry in a string list (case-sensitive). */
export function matchesList(value: string, list: string[]): boolean {
  return list.includes(value);
}

/** Check if a target string matches any of the given patterns. */
export function matchesTarget(
  target: string | undefined,
  patterns: string[],
  useRegex: boolean,
): boolean {
  if (target === undefined) return false;
  for (const pattern of patterns) {
    if (useRegex) {
      if (new RegExp(pattern).test(target)) return true;
    } else {
      if (globToRegex(pattern).test(target)) return true;
    }
  }
  return false;
}

/**
 * Evaluate whether a tool call matches a PolicyMatch specification.
 * All specified criteria are AND'd: if tools, categories, and targetPatterns
 * are all specified, all must match.
 */
export function matchesRule(
  toolName: string,
  category: ToolCategory,
  target: string | undefined,
  match: PolicyMatch,
): boolean {
  // Each specified criterion must match (AND logic)
  if (match.tools && !matchesList(toolName, match.tools)) return false;
  if (match.categories && !matchesList(category, match.categories)) return false;
  if (match.targetPatterns) {
    if (!matchesTarget(target, match.targetPatterns, match.targetPatternsAreRegex ?? false)) {
      return false;
    }
  }
  return true;
}
