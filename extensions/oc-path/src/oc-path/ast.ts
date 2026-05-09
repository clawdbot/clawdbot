/**
 * Markdown AST — addressing index for workspace files.
 *
 * Pure addressing structure; no per-file opinions (those live in lint
 * rules). Byte-fidelity: `emitMd(parse(raw)) === raw`; `raw` on the
 * root preserves the original bytes for round-trip.
 *
 * @module @openclaw/oc-path/ast
 */

/** Parser diagnostic. Severity `warning` for recoverable input; never throws. */
export interface Diagnostic {
  readonly line: number;
  readonly message: string;
  readonly severity: "info" | "warning" | "error";
  readonly code?: string;
}

/** Frontmatter entry. Values unquoted (`"`/`'` stripped) but otherwise verbatim. */
export interface FrontmatterEntry {
  readonly key: string;
  readonly value: string;
  readonly line: number;
}

/**
 * Bullet item. `slug` is the addressing key (kv.key when present, else
 * item text). `kv` is populated for `- key: value` bullets.
 */
export interface AstItem {
  readonly text: string;
  readonly slug: string;
  readonly line: number;
  readonly kv?: { readonly key: string; readonly value: string };
}

/**
 * H2-delimited block. `bodyText` is the verbatim prose between this
 * heading and the next; `items` are extracted for addressing.
 *
 * Tables and code blocks aren't first-class — addressing into them is
 * out of scope. Lint rules re-tokenize `bodyText` if needed.
 */
export interface AstBlock {
  readonly heading: string;
  readonly slug: string;
  readonly line: number;
  readonly bodyText: string;
  readonly items: readonly AstItem[];
}

/** Root AST. `raw` carries the original bytes for byte-identical round-trip. */
export interface MdAst {
  readonly kind: "md";
  readonly raw: string;
  readonly frontmatter: readonly FrontmatterEntry[];
  readonly preamble: string;
  readonly blocks: readonly AstBlock[];
}

export interface ParseResult {
  readonly ast: MdAst;
  readonly diagnostics: readonly Diagnostic[];
}
