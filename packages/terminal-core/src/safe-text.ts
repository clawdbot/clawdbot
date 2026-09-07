import { stripAnsi } from "./ansi.js";

/** Return whether text contains C0 or C1 terminal control characters. */
export function hasTerminalControl(input: string): boolean {
  return input.search(/\p{Cc}/u) !== -1;
}

/**
 * Normalize untrusted text for single-line terminal/log rendering.
 */
export function sanitizeTerminalText(input: string): string {
  // Strip escapes first so removed bytes cannot become a new ANSI sequence.
  return stripAnsi(input).replace(/\p{Cc}/gu, (control) =>
    control === "\r" ? "\\r" : control === "\n" ? "\\n" : control === "\t" ? "\\t" : "",
  );
}
