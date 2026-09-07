// Compiles persisted exec argPattern values without changing their exact match semantics.
import { compileSafeRegexForExec, type SafeRegexRejectReason } from "../security/safe-regex.js";

export type ExecArgPatternRejectReason = Exclude<SafeRegexRejectReason, "empty">;

type ExecArgPatternCompileResult =
  | { regex: RegExp; reason: null }
  | { regex: null; reason: ExecArgPatternRejectReason };

/**
 * Shared compileSafeRegexDetailed is the two-arg plugin/config/cron compiler.
 * Exec uses compileSafeRegexForExec (unprobed Unicode fail-closed) then compiles
 * the original source so padding and escapes like `\ ` keep historical match
 * semantics. Reject only real ReDoS / invalid originals.
 */
export function compileExecArgPattern(source: string): ExecArgPatternCompileResult {
  const safety = compileSafeRegexForExec(source);
  // Fail closed on nested-repetition even when the shared helper trims first.
  if (safety.reason === "unsafe-nested-repetition") {
    return { regex: null, reason: "unsafe-nested-repetition" };
  }
  // empty, safe, or shared invalid-after-trim (e.g. "\ " → "\"): compile original.
  try {
    return { regex: new RegExp(source), reason: null };
  } catch {
    return { regex: null, reason: "invalid-regex" };
  }
}
