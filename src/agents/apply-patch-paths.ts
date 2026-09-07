/**
 * Path extraction for the apply_patch envelope grammar.
 * Used by pre-execution policy hooks that only need destination paths, not the
 * full strict patch parser.
 */
import path from "node:path";
import { extractApplyPatchTargets } from "./apply-patch-targets.js";
import { preserveAtPrefixedRelativePath, resolvePathFromInput } from "./path-policy.js";
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
  /** Run cancellation propagated to remote path disambiguation. */
  signal?: AbortSignal;
  /** Sandbox bridge used by apply_patch execution, when the tool runs in a sandbox. */
  sandbox?: {
    root: string;
    bridge: SandboxFsBridge;
  };
};

/** Resolve a patch input through the same literal-@ policy used by execution. */
export async function resolveApplyPatchInputPath(
  raw: string,
  options: ApplyPatchPathExtractionOptions = {},
): Promise<string> {
  const cwd = options.cwd ?? options.sandbox?.root ?? process.cwd();
  const preserved = await preserveAtPrefixedRelativePath(
    raw,
    cwd,
    options.sandbox?.bridge,
    options.signal,
  );
  if (!raw.startsWith("@") || preserved !== raw) {
    return preserved;
  }
  const referenced = raw.slice(1);
  return referenced === "~" || referenced.startsWith("~/") || referenced.startsWith("~\\")
    ? resolvePathFromInput(raw, cwd)
    : referenced;
}

function normalizePatchPath(
  raw: string,
  options: ApplyPatchPathExtractionOptions = {},
): string | undefined {
  if (raw.length === 0) {
    return undefined;
  }
  const cwd = options.cwd ?? options.sandbox?.root ?? process.cwd();
  try {
    const filePath = preserveAtPrefixedRelativePath(raw, cwd);
    const resolved = options.sandbox
      ? options.sandbox.bridge.resolvePath({
          filePath,
          cwd,
        })
      : undefined;
    const normalized = path.normalize(
      resolved
        ? (resolved.hostPath ?? resolved.containerPath)
        : resolveSandboxInputPath(filePath, cwd),
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

/** Derive policy-visible paths using the asynchronous resolver used by execution. */
export async function extractResolvedApplyPatchTargetPaths(
  input: unknown,
  options: ApplyPatchPathExtractionOptions = {},
): Promise<string[]> {
  const paths: string[] = [];
  const seen = new Set<string>();
  const cwd = options.cwd ?? options.sandbox?.root ?? process.cwd();
  for (const target of extractApplyPatchTargets(input)) {
    try {
      const filePath = await resolveApplyPatchInputPath(target.path, options);
      const resolved = options.sandbox?.bridge.resolvePath({ filePath, cwd });
      const normalized = resolved?.hostPath
        ? path.normalize(resolved.hostPath)
        : resolved
          ? path.posix.normalize(resolved.containerPath)
          : path.normalize(resolveSandboxInputPath(filePath, cwd));
      if (normalized && normalized !== "." && !seen.has(normalized)) {
        seen.add(normalized);
        paths.push(normalized);
      }
    } catch {
      options.signal?.throwIfAborted();
      // Derived paths are best-effort metadata; execution remains authoritative.
    }
  }
  return paths;
}
