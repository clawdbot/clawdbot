/**
 * Line-ending detection and restoration shared by the file-mutating agent tools.
 */

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) {
    return "\n";
  }
  if (crlfIdx === -1) {
    return "\n";
  }
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function hasOnlyCrlfLineEndings(text: string): boolean {
  const withoutCrlf = text.replaceAll("\r\n", "");
  return withoutCrlf.length !== text.length && !/[\r\n]/.test(withoutCrlf);
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}
