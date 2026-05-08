/**
 * YAML AST types — wraps the `yaml` library's Document model so the
 * substrate can address YAML nodes via `OcPath` while preserving the
 * authoring shape (comments, anchors, etc.) for round-trip emit.
 *
 * **Per-kind discriminator**: `kind: 'yaml'` matches the md / jsonc /
 * jsonl pattern. The universal `setOcPath` / `resolveOcPath` dispatch
 * via `ast.kind`.
 *
 * **Byte-fidelity**: `raw` is preserved on the root for round-trip
 * emit. The internal `doc` is the parsed `yaml.Document` from the
 * `yaml` package — comment-preserving, anchor-aware.
 *
 * Lobster `.lobster` files (workflow specs) and `.craft/waves/*.yaml`
 * (craft system) both flow through this kind.
 *
 * @module @openclaw/oc-path/yaml/ast
 */

import type { Document, LineCounter } from 'yaml';

/** The root YAML AST. `raw` round-trips byte-identical via emit. */
export interface YamlAst {
  readonly kind: 'yaml';
  readonly raw: string;
  /**
   * Parsed `yaml.Document` — wraps the comment-preserving CST model.
   */
  readonly doc: Document.Parsed;
  /**
   * `LineCounter` from the `yaml` package. Pass a node's `range[0]`
   * (byte offset) to `lineCounter.linePos(offset)` to get
   * `{ line, col }` (1-based). Lint rules use this to surface accurate
   * line numbers in findings instead of hardcoding `line: 1`.
   */
  readonly lineCounter: LineCounter;
}
