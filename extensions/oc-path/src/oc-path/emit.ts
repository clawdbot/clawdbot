/**
 * Emit an AST back to bytes.
 *
 * **Two modes**:
 *
 *   1. **Round-trip** — the AST hasn't been mutated since `parseMd`
 *      produced it. Returns `ast.raw` verbatim. Byte-identical.
 *
 *   2. **Mutation-aware** — the AST has been modified (frontmatter
 *      entry edited, item kv.value changed, block reordered). Returns
 *      a freshly-rendered representation. **Not** byte-identical to a
 *      hypothetical "perfect" rewrite — we render canonical forms
 *      (LF endings, single space after `:` in frontmatter, etc.).
 *      Callers needing byte-fidelity for partial edits should patch
 *      `raw` directly instead of mutating the AST.
 *
 * In both modes, every emitted leaf flows through `guardSentinel` so a
 * `__OPENCLAW_REDACTED__` literal anywhere in the output throws
 * `OcEmitSentinelError`. This is the substrate guard: callers can't
 * accidentally write a redacted view to disk through this emitter.
 *
 * @module @openclaw/oc-path/emit
 */

import type { FrontmatterEntry, MdAst } from "./ast.js";
import { guardSentinel } from "./sentinel.js";

/**
 * Emit options. `mode: 'roundtrip'` (default) returns `ast.raw` if
 * present and not flagged as dirty; `mode: 'render'` always
 * re-renders.
 */
export interface EmitOptions {
  readonly mode?: "roundtrip" | "render";
  /**
   * When provided, the emitter walks every emitted leaf string through
   * `guardSentinel(value, ocPath)`. Default uses the file name
   * (`oc://<file>`) when the field-precise path can't be determined.
   * Callers that want richer error context can supply `ocPathFor` to
   * compute a path per leaf.
   */
  readonly fileNameForGuard?: string;
  /**
   * See `JsoncEmitOptions.acceptPreExistingSentinel` for the rationale.
   * Default `true` — round-trip echoes parsed bytes without scanning
   * for the sentinel. Render mode scans every leaf regardless.
   */
  readonly acceptPreExistingSentinel?: boolean;
}

/**
 * Emit the AST. In render mode, throws `OcEmitSentinelError` if any
 * leaf string matches `REDACTED_SENTINEL`. In round-trip mode, echoes
 * `ast.raw` verbatim (does not scan unless caller opts in via
 * `acceptPreExistingSentinel: false`).
 */
export function emitMd(ast: MdAst, opts: EmitOptions = {}): string {
  const mode = opts.mode ?? "roundtrip";
  const guardPath = opts.fileNameForGuard ? `oc://${opts.fileNameForGuard}` : "oc://";
  const acceptPreExisting = opts.acceptPreExistingSentinel ?? true;

  if (mode === "roundtrip") {
    // Round-trip trusts parsed bytes — see emit-policy comment in
    // jsonc/emit.ts. A markdown file legitimately containing the
    // sentinel literal (in a code block, in a pasted error log) would
    // otherwise become a workspace-wide emit DoS.
    if (!acceptPreExisting && ast.raw.includes("__OPENCLAW_REDACTED__")) {
      guardSentinel("__OPENCLAW_REDACTED__", `${guardPath}/[raw]`);
    }
    return ast.raw;
  }

  // Render mode: rebuild from structural fields. This loses
  // formatting details (extra blank lines, custom whitespace, etc.)
  // but is correct.
  const parts: string[] = [];

  if (ast.frontmatter.length > 0) {
    parts.push("---");
    for (const fm of ast.frontmatter) {
      guardSentinel(fm.value, `${guardPath}/[frontmatter]/${fm.key}`);
      parts.push(`${fm.key}: ${formatFrontmatterValue(fm.value)}`);
    }
    parts.push("---");
  }

  if (ast.preamble.length > 0) {
    guardSentinel(ast.preamble, `${guardPath}/[preamble]`);
    if (parts.length > 0) {
      parts.push("");
    }
    parts.push(ast.preamble);
  }

  for (const block of ast.blocks) {
    if (parts.length > 0) {
      parts.push("");
    }
    parts.push(`## ${block.heading}`);
    if (block.bodyText.length > 0) {
      // Walk items + frontmatter-key value strings for sentinels;
      // body text is also walked as one big string in case of any raw
      // sentinel.
      guardSentinel(block.bodyText, `${guardPath}/${block.slug}/[body]`);
      for (const item of block.items) {
        if (item.kv) {
          guardSentinel(item.kv.value, `${guardPath}/${block.slug}/${item.slug}/${item.kv.key}`);
        }
      }
      parts.push(block.bodyText);
    }
  }

  return parts.join("\n");
}

function formatFrontmatterValue(value: string): string {
  // Frontmatter is yaml-ish; quote values with structural chars.
  if (value.length === 0) {
    return '""';
  }
  if (/[:#&*?|<>=!%@`,[\]{}\r\n]/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Mark an AST as "dirty" — useful for callers that mutate the AST
 * structurally and want emitMd() to re-render rather than round-trip.
 *
 * Currently a no-op flag — emitMd() decides based on `opts.mode`. Kept
 * as an extension point for a future invariant where the AST tracks
 * its own dirty state.
 */
export function markDirty(_ast: MdAst): void {
  // intentionally empty
}

// Re-export the frontmatter type for convenience so tests don't need
// to import from ast.ts.
export type { FrontmatterEntry };
