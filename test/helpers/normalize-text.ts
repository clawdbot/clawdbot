// Text normalization helper strips terminal control sequences from test output.
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";

// Snapshot text normalization for terminal output tests.

/** Strip ANSI, normalize line endings, ellipses, and emoji/surrogate pairs. */
export function normalizeTestText(input: string): string {
  return stripAnsi(input)
    .replaceAll("\r\n", "\n")
    .replaceAll("…", "...")
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "?")
    .replace(/[\uD800-\uDFFF]/g, "?");
}
