// Matrix helper module resolves source ranges owned by Markdown table blocks.
import MarkdownIt from "markdown-it";

const tableParser = new MarkdownIt({ html: false, linkify: false, typographer: false });

export function findMatrixTableSourceRanges(
  markdown: string,
): Array<{ start: number; end: number }> {
  const lineStarts = [0];
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }
  lineStarts.push(markdown.length);
  return tableParser.parse(markdown, {}).flatMap((token) => {
    if (token.type !== "table_open" || !token.map) {
      return [];
    }
    const start = lineStarts[token.map[0]] ?? 0;
    return [{ start, end: lineStarts[token.map[1]] ?? markdown.length }];
  });
}
