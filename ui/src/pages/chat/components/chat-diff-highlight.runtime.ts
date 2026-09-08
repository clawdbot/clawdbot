import { classHighlighter, highlightCode } from "@lezer/highlight";
import { html } from "lit";
import { loadCodeLanguage } from "../../../components/code-language.ts";
import type { DiffLine } from "../../../lib/chat/tool-call-diff.ts";

// Syntax is optional decoration; keep oversized/minified diffs readable without
// synchronously parsing an unbounded source string on the UI thread.
const MAX_HIGHLIGHT_CHARS = 120_000;

export async function highlightDiffLines(lines: readonly DiffLine[], path: string, oldPath = path) {
  const highlighted = new Map<DiffLine, unknown>();
  let size = 0;
  for (const line of lines) {
    size += line.text.length + 1;
    if (size > MAX_HIGHLIGHT_CHARS) {
      return highlighted;
    }
  }
  let section: { path: string; oldPath: string; lines: DiffLine[] } = { path, oldPath, lines: [] };
  const sections: (typeof section)[] = [];
  for (const line of lines) {
    if (line.kind === "file" || line.kind === "skip") {
      sections.push(section);
      section =
        line.kind === "file"
          ? { path: line.path ?? "", oldPath: line.oldPath ?? line.path ?? "", lines: [] }
          : { ...section, lines: [] };
    } else {
      section.lines.push(line);
    }
  }
  sections.push(section);
  await Promise.all(
    sections.map(async (part) => {
      if (!part.lines.length) {
        return;
      }
      // Parse each side independently so deleted comments/strings cannot color
      // added code. Renames retain each language; shared context uses the new side.
      // A gap starts a new parse: omitted source is unknown.
      for (const excluded of ["add", "del"]) {
        const support = await loadCodeLanguage(excluded === "add" ? part.oldPath : part.path);
        if (!support) {
          continue;
        }
        const side = part.lines.filter((line) => line.kind !== excluded);
        const code = side.map((line) => line.text).join("\n");
        const tokens: unknown[][] = [[]];
        highlightCode(
          code,
          support.language.parser.parse(code),
          classHighlighter,
          (text, classes) =>
            tokens.at(-1)!.push(classes ? html`<span class=${classes}>${text}</span>` : text),
          () => {
            tokens.push([]);
          },
        );
        side.forEach((line, index) => {
          if (line.text && (excluded === "del" || line.kind === "del")) {
            highlighted.set(line, tokens[index]);
          }
        });
      }
    }),
  );
  return highlighted;
}
