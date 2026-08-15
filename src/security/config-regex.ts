// Defines config regexes used by security validation.
import {
  compileSafeRegexDetailed,
  type SafeRegexCompileResult,
  type SafeRegexRejectReason,
} from "./safe-regex.js";

/** Reject reasons that should be surfaced for user-configured regex patterns. */
export type ConfigRegexRejectReason = Exclude<SafeRegexRejectReason, "empty">;

/**
 * Result for one config regex pattern.
 * Empty patterns return null from the compiler; invalid or unsafe patterns return a rejected shape.
 */
type CompiledConfigRegex =
  | {
      regex: RegExp;
      pattern: string;
      flags: string;
      reason: null;
    }
  | {
      regex: null;
      pattern: string;
      flags: string;
      reason: ConfigRegexRejectReason;
    };

function normalizeRejectReason(result: SafeRegexCompileResult): ConfigRegexRejectReason | null {
  if (result.reason === null || result.reason === "empty") {
    return null;
  }
  return result.reason;
}

/**
 * Compile a single user-configured regex with the shared safe-regex guardrails.
 * Returns null for blank patterns so optional config entries can be skipped silently.
 */
export function compileConfigRegex(pattern: string, flags = ""): CompiledConfigRegex | null {
  const result = compileSafeRegexDetailed(pattern, flags);
  // Blank config entries are absence, not rejection diagnostics.
  if (result.reason === "empty") {
    return null;
  }
  return {
    regex: result.regex,
    pattern: result.source,
    flags: result.flags,
    reason: normalizeRejectReason(result),
  } as CompiledConfigRegex;
}

/**
 * Compile a list of user-configured regex patterns, separating usable regexes from diagnostics.
 * Callers can keep operating with safe entries while reporting rejected unsafe patterns once.
 */
export function compileConfigRegexes(
  patterns: string[],
  flags = "",
): {
  regexes: RegExp[];
  rejected: Array<{
    pattern: string;
    flags: string;
    reason: ConfigRegexRejectReason;
  }>;
} {
  const regexes: RegExp[] = [];
  const rejected: Array<{
    pattern: string;
    flags: string;
    reason: ConfigRegexRejectReason;
  }> = [];

  for (const pattern of patterns) {
    const compiled = compileConfigRegex(pattern, flags);
    if (!compiled) {
      continue;
    }
    if (compiled.regex) {
      regexes.push(compiled.regex);
      continue;
    }
    rejected.push({
      pattern: compiled.pattern,
      flags: compiled.flags,
      reason: compiled.reason,
    });
  }

  return { regexes, rejected };
}
