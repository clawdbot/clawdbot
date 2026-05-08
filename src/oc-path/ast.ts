/**
 * Workspace-Markdown AST — generic addressing index over the 8 workspace
 * files openclaw treats as opaque text in `loadWorkspaceBootstrapFiles`.
 *
 * **The AST is purely an addressing index.** It does NOT encode opinions
 * about what a "valid" SOUL.md / AGENTS.md / MEMORY.md looks like; it
 * exposes the markdown features (frontmatter, sections, items, tables,
 * code blocks) that any `OcPath` (`{ file, section?, item?, field? }`) can
 * resolve over. Per-file lint opinions ride in @openclaw/oc-lint, not
 * here.
 *
 * **Byte-fidelity contract**: `emitMd(parse(raw)) === raw` for every input
 * the parser accepts. The parser preserves the original bytes on the
 * root node (`raw`) so emitters can round-trip even content the AST
 * doesn't structurally model (foreign content, idiosyncratic whitespace).
 *
 * @module @openclaw/oc-path/ast
 */

/**
 * Diagnostic emitted by the parser. Used by lint rules and parse-error
 * surfacing alike. Severity is `info` by default; the parser emits
 * `warning` for suspicious-but-recoverable inputs (e.g., unclosed
 * frontmatter fence) and never throws.
 */
export interface Diagnostic {
  readonly line: number;
  readonly message: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly code?: string;
}

/**
 * A frontmatter key/value pair. Keys are preserved as written; values
 * are unquoted (surrounding `"` or `'` stripped) but otherwise verbatim.
 */
export interface FrontmatterEntry {
  readonly key: string;
  readonly value: string;
  readonly line: number;
}

/**
 * A bullet-list item inside a section. Items are addressable via OcPath
 * `{ file, section, item }` where `item` is the slug of the bullet's
 * text (or the slug of `kv.key` when the bullet is in `- key: value`
 * shape).
 *
 * `kv` is populated when the bullet matches `- <key>: <value>` (the
 * common pattern in AGENTS.md / TOOLS.md / USER.md). Lint rules use it
 * for field-level addressing via `OcPath.field`.
 */
export interface AstItem {
  readonly text: string;
  readonly slug: string;
  readonly line: number;
  readonly kv?: { readonly key: string; readonly value: string };
}

/**
 * A markdown table. Tables surface in `## Tool Guidance` blocks and
 * elsewhere; lint rules can address rows by header value if needed.
 */
export interface AstTable {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly line: number;
}

/**
 * A fenced code block. Carries the language tag (or `null`) and the
 * verbatim body.
 */
export interface AstCodeBlock {
  readonly lang: string | null;
  readonly text: string;
  readonly line: number;
}

/**
 * An H2-delimited block. The `slug` is the kebab-case lowercase form of
 * `heading` and is what OcPath `section` matches against. `bodyText` is
 * the prose between this heading and the next H2 (or end of file),
 * verbatim. `items`, `tables`, `codeBlocks` are extracted from
 * `bodyText` for addressing convenience but the raw text is preserved.
 */
export interface AstBlock {
  readonly heading: string;
  readonly slug: string;
  readonly line: number;
  readonly bodyText: string;
  readonly items: readonly AstItem[];
  readonly tables: readonly AstTable[];
  readonly codeBlocks: readonly AstCodeBlock[];
}

/**
 * The root AST node. Always carries `raw` for byte-identical round-trip.
 * `frontmatter` is empty when the file has none. `preamble` is the
 * prose before the first H2 (may be empty). `blocks` is the H2 tree in
 * document order.
 *
 * `kind: 'md'` discriminator matches the jsonc / jsonl / yaml AST
 * shapes; the universal `setOcPath` / `resolveOcPath` verbs dispatch
 * via this tag at runtime so callers don't have to thread kind
 * through the call site.
 *
 * The generic shape is the same for all 9 workspace files; opinions
 * (`AGENTS_TOOLS_SECTION_EMPTY`, etc.) ride in lint rules, not here.
 */
export interface MdAst {
  readonly kind: 'md';
  readonly raw: string;
  readonly frontmatter: readonly FrontmatterEntry[];
  readonly preamble: string;
  readonly blocks: readonly AstBlock[];
}

/**
 * Parser output: the AST plus any diagnostics from the parse pass.
 */
export interface ParseResult {
  readonly ast: MdAst;
  readonly diagnostics: readonly Diagnostic[];
}
