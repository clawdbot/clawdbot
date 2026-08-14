/**
 * Path extraction for the apply_patch envelope grammar.
 * Used by pre-execution policy hooks that only need destination paths, not the
 * full strict patch parser.
 */
import path from "node:path";
import { extractApplyPatchTargets } from "./apply-patch-targets.js";
import { resolveSandboxInputPath } from "./sandbox-paths.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

/**
 * Lightweight path extractor for the `apply_patch` envelope grammar.
 *
 * The full parser in `apply-patch.ts` validates and applies a patch end-to-end.
 * Plugins running inside `before_tool_call` only need the destination paths so
 * they can compute path policy decisions before the patch is applied. This
 * helper walks the input lines and collects every path mentioned by:
 *
 *   - `*** Add File: <path>`
 *   - `*** Update File: <path>`         (and the optional `*** Move to: <new>`
 *                                         sub-marker that immediately follows)
 *   - `*** Delete File: <path>`
 *
 * Unlike the strict parser, this helper is forgiving: it does not require the
 * `*** Begin Patch` / `*** End Patch` envelope, it ignores non-marker lines
 * while scanning the full input, and it may therefore still pick up marker-like
 * lines that appear later in malformed input. Top-level hunk headers are matched
 * after trimming leading whitespace, like the executor parser; marker-like patch
 * body lines remain ignored while scanning an update hunk. Empty paths are dropped.
 *
 * The shape of the input mirrors how `apply_patch` receives it: either a
 * string (the full patch text) or an object with an `input` field carrying the
 * patch text. Anything else returns an empty array.
 */

export type ApplyPatchPathExtractionOptions = {
  /** Tool execution cwd. Defaults to process.cwd(), matching createApplyPatchTool. */
  cwd?: string;
  /** Sandbox bridge used by apply_patch execution, when the tool runs in a sandbox. */
  sandbox?: {
    root: string;
    bridge: SandboxFsBridge;
  };
};

function normalizePatchPath(
  raw: string,
  options: ApplyPatchPathExtractionOptions = {},
): string | undefined {
  if (raw.length === 0) {
    return undefined;
  }
  const cwd = options.cwd ?? options.sandbox?.root ?? process.cwd();
  try {
    const resolved = options.sandbox
      ? options.sandbox.bridge.resolvePath({
          filePath: raw,
          cwd,
        })
      : undefined;
    const normalized = path.normalize(
      resolved ? (resolved.hostPath ?? resolved.containerPath) : resolveSandboxInputPath(raw, cwd),
    );
    return normalized && normalized !== "." ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function pushPath(
  target: string[],
  seen: Set<string>,
  raw: string,
  options: ApplyPatchPathExtractionOptions,
): void {
  const normalized = normalizePatchPath(raw, options);
  if (!normalized) {
    return;
  }
  if (seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

/**
 * Walk an apply_patch envelope and return every destination path found, in
 * the order they appear. Duplicates are de-duplicated (the same file may be
 * referenced multiple times within a single envelope). Returns `[]` for any
 * input that is not a recognised envelope.
 */
export function extractApplyPatchTargetPaths(
  input: unknown,
  options: ApplyPatchPathExtractionOptions = {},
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const target of extractApplyPatchTargets(input)) {
    pushPath(paths, seen, target.path, options);
  }
  return paths;
}
