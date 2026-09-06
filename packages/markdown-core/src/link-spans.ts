import { fromMarkdown } from "mdast-util-from-markdown";

type PositionedMarkdownNode = {
  type: string;
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  children?: PositionedMarkdownNode[];
};

/** Returns parser-owned source spans for inline links, autolinks, and images. */
export function findMarkdownLinkSourceSpans(markdown: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const tree: PositionedMarkdownNode = fromMarkdown(markdown);
  const pending = [tree];

  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) {
      continue;
    }
    if (node.type === "link" || node.type === "image") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (start !== undefined && end !== undefined) {
        spans.push([start, end]);
      }
      // The outer link owns nested image source, so overlapping spans are not useful to callers.
      continue;
    }
    for (const child of node.children ?? []) {
      pending.push(child);
    }
  }

  return spans.toSorted((left, right) => left[0] - right[0]);
}
