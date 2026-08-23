// Classifies closed POSIX shell builtins for exec allowlist checks.
import { isWindowsPlatform, type ExecCommandSegment } from "./exec-approvals-analysis.js";

// POSIX shell builtins that cannot execute external code or mutate environment state on their
// own. Shell allowlist evaluation handles them as a closed internal set instead of path-based
// safeBins matching.
const DEFAULT_SAFE_BUILTINS: ReadonlySet<string> = new Set([
  ":",
  "cd",
  "false",
  "pwd",
  "test",
  "true",
]);

/** Returns true when a parsed POSIX shell segment is one of the closed safe builtin forms. */
export function isSafeBuiltinSegment(params: {
  segment: ExecCommandSegment;
  platform?: string | null;
}): boolean {
  // Builtin semantics here are POSIX shell. On Windows the host shell is PowerShell, where
  // these tokens have different meaning (cd is an alias to Set-Location, etc.); defer.
  if (isWindowsPlatform(params.platform ?? process.platform)) {
    return false;
  }
  const head = params.segment.argv[0]?.trim().toLowerCase();
  if (!head) {
    return false;
  }
  if (head === "[") {
    return params.segment.argv.at(-1) === "]" || params.segment.raw.trim().endsWith("]");
  }
  return DEFAULT_SAFE_BUILTINS.has(head);
}
