// Markdown code spans/fences that survive embedded backticks.

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const char of value) {
    if (char === "`") {
      current += 1;
      longest = Math.max(longest, current);
      continue;
    }
    current = 0;
  }
  return longest;
}

/**
 * Wraps text in an inline code span whose delimiter is longer than any
 * backtick run inside it. Edge backticks and newlines get spacer padding so
 * renderers do not glue the delimiter onto the content.
 */
export function formatInlineCodeSpan(value: string): string {
  const delimiter = "`".repeat(longestBacktickRun(value) + 1);
  const padding = value.startsWith("`") || value.endsWith("`") || value.includes("\n") ? " " : "";
  return `${delimiter}${padding}${value}${padding}${delimiter}`;
}

/** Wraps text in a fenced code block whose fence is longer than any run inside it. */
export function formatFencedCodeBlock(text: string, language?: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}${language ?? ""}\n${text}\n${fence}`;
}
