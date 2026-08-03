/**
 * JSONL AST types — JSON-Lines: one JSON value per line, separated by
 * `\n`. The shape used by openclaw session-event logs, audit trails,
 * and LKG checkpoints (which is why JSONL is part of the universal
 * OcPath addressing scheme).
 *
 * **Per-kind discriminator**: every AST in this substrate carries a
 * `kind` field. The OcPath resolver dispatches on `kind`.
 *
 * **Byte-fidelity**: `raw` is preserved on the root for round-trip
 * emit. JSONL is line-oriented, so blank lines and per-line comments
 * (we don't strip them in render mode either — we preserve them as
 * "raw" line entries) live in the AST.
 *
 * @module @openclaw/oc-path/jsonl/ast
 */

import type { JsoncValue } from "../jsonc/ast.js";

/** The root JSONL AST. `raw` round-trips byte-identical via emit. */
export interface JsonlAst {
  readonly kind: "jsonl";
  readonly raw: string;
  readonly lines: readonly JsonlLine[];
  /**
   * Line-ending convention detected at parse time. Used by render mode
   * to reconstruct the original convention (Windows-authored datasets
   * use CRLF; Unix uses LF). Optional for back-compat with synthetic
   * ASTs that don't track this — render mode falls back to LF when
   * undefined.
   */
  readonly lineEnding?: "\r\n" | "\n";
}

/**
 * One line of a JSONL file. Either a parsed JSON value, a blank line
 * (preserved for round-trip), or a malformed line (emit verbatim;
 * emit-time sentinel guard still scans).
 */
export type JsonlLine =
  | {
      readonly kind: "value";
      readonly line: number;
      readonly value: JsoncValue;
      /** The original line text (without trailing newline). */
      readonly raw: string;
    }
  | { readonly kind: "blank"; readonly line: number; readonly raw: string }
  | { readonly kind: "malformed"; readonly line: number; readonly raw: string };
