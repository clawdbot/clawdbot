/**
 * JSONL parser — splits on `\n`, parses each non-empty line as JSONC
 * (allowing comments/trailing-comma is harmless and matches what
 * openclaw session logs actually emit). Soft-error policy: malformed
 * lines surface as `kind: 'malformed'` AST entries plus a diagnostic.
 *
 * @module @openclaw/oc-path/jsonl/parse
 */

import type { Diagnostic } from "../ast.js";
import { parseJsonc } from "../jsonc/parse.js";
import type { JsonlAst, JsonlLine } from "./ast.js";

export interface JsonlParseResult {
  readonly ast: JsonlAst;
  readonly diagnostics: readonly Diagnostic[];
}

export function parseJsonl(raw: string): JsonlParseResult {
  const diagnostics: Diagnostic[] = [];
  // Detect the line-ending convention from the input. Windows-authored
  // datasets use CRLF; Unix and most cross-platform tooling use LF. We
  // count CRLF occurrences and call CRLF if the majority of newlines
  // are CRLF — this handles mixed-ending files (e.g., a Unix log
  // edited once on Windows) by picking the dominant convention.
  // Without this, `setJsonlOcPath` rebuilds a CRLF input via render
  // mode which joins with `\n`, producing mixed endings on a
  // previously-CRLF file.
  const crlfCount = (raw.match(/\r\n/g) ?? []).length;
  const lfCount = (raw.match(/\n/g) ?? []).length;
  const lineEnding: "\r\n" | "\n" = crlfCount > 0 && crlfCount * 2 >= lfCount ? "\r\n" : "\n";

  // Trim trailing newline so we don't fabricate a blank line at EOF
  // for files that end with `\n` (which is most of them).
  let body = raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  // Normalize line endings to LF for consistent splitting; per-line
  // `raw` is stored without the trailing `\r`, and render mode
  // restores the original convention via `lineEnding`.
  body = body.replace(/\r\n/g, "\n");
  const lines: JsonlLine[] = [];

  if (body.length === 0) {
    return { ast: { kind: "jsonl", raw, lines, lineEnding }, diagnostics };
  }

  const parts = body.split("\n");
  parts.forEach((lineText, idx) => {
    const lineNo = idx + 1;
    if (lineText.trim().length === 0) {
      lines.push({ kind: "blank", line: lineNo, raw: lineText });
      return;
    }
    const r = parseJsonc(lineText);
    if (r.ast.root === null) {
      lines.push({ kind: "malformed", line: lineNo, raw: lineText });
      diagnostics.push({
        line: lineNo,
        message: `line ${lineNo} could not be parsed as JSON`,
        severity: "warning",
        code: "OC_JSONL_LINE_MALFORMED",
      });
      return;
    }
    lines.push({
      kind: "value",
      line: lineNo,
      value: r.ast.root,
      raw: lineText,
    });
  });

  return { ast: { kind: "jsonl", raw, lines, lineEnding }, diagnostics };
}
