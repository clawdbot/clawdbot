// Discord plugin module implements source-preserving Markdown normalization.
import { fromMarkdown } from "mdast-util-from-markdown";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import {
  convertMarkdownTables,
  FormatCapabilityProfile,
  renderMarkdownWithMarkers,
} from "openclaw/plugin-sdk/text-chunking";

const DISCORD_FORMAT_PROFILE = FormatCapabilityProfile.define({
  mechanism: "markdown",
  constructs: { table: "fallback" },
  chunk: { limit: 2_000, unit: "utf16" },
});

const DISCORD_BOLD_PROBE_TEXT = "openclaw-discord-bold";
const DISCORD_BOLD_PROBE = renderMarkdownWithMarkers(
  {
    text: DISCORD_BOLD_PROBE_TEXT,
    styles: [{ start: 0, end: DISCORD_BOLD_PROBE_TEXT.length, style: "bold" }],
    links: [],
  },
  {
    styleMarkers: { bold: { open: "**", close: "**" } },
    escapeText: (value) => value,
  },
  DISCORD_FORMAT_PROFILE,
);
const DISCORD_BOLD_MARKERS = {
  open: DISCORD_BOLD_PROBE.slice(0, DISCORD_BOLD_PROBE.indexOf(DISCORD_BOLD_PROBE_TEXT)),
  close: DISCORD_BOLD_PROBE.slice(
    DISCORD_BOLD_PROBE.indexOf(DISCORD_BOLD_PROBE_TEXT) + DISCORD_BOLD_PROBE_TEXT.length,
  ),
};

type PositionedMarkdownNode = {
  type: string;
  children?: PositionedMarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  [key: string]: unknown;
};

const DISCORD_NATIVE_TOKEN_RE = /<a?:[A-Za-z0-9_]+:\d+>|<\/[^>]+:\d+>/giu;
const DISCORD_URL_START_RE = /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\.)/giu;

function findDiscordUrlRanges(markdown: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of markdown.matchAll(DISCORD_URL_START_RE)) {
    const start = match.index;
    if (start === undefined) {
      continue;
    }
    const preceding = markdown[start - 1] ?? "";
    if (/[\p{L}\p{N}]/u.test(preceding) || (preceding === "_" && markdown[start - 2] !== "_")) {
      continue;
    }
    let end = start + match[0].length;
    let parenthesisDepth = 0;
    while (end < markdown.length) {
      const char = markdown[end];
      if (!char || /[\s<>]/u.test(char)) {
        break;
      }
      if (char === "(") {
        parenthesisDepth += 1;
      } else if (char === ")") {
        if (parenthesisDepth === 0) {
          break;
        }
        parenthesisDepth -= 1;
      }
      end += 1;
    }
    ranges.push({ start, end });
  }
  return ranges;
}

function markdownSemanticSignature(root: PositionedMarkdownNode): string {
  const parts: string[] = [];
  const pending: Array<{ node: PositionedMarkdownNode; parentStrong: boolean; exiting?: true }> = [
    { node: root, parentStrong: false },
  ];
  while (pending.length > 0) {
    const event = pending.pop();
    if (!event) {
      continue;
    }
    if (event.exiting) {
      parts.push(")");
      continue;
    }
    const { node } = event;
    const redundantStrong = event.parentStrong && node.type === "strong";
    const fields = Object.fromEntries(
      Object.entries(node).filter(([key]) => key !== "children" && key !== "position"),
    );
    const children = node.children ?? [];
    if (!redundantStrong) {
      parts.push(`(${JSON.stringify(fields)}`);
      pending.push({ node, parentStrong: event.parentStrong, exiting: true });
    }
    const parentStrong = event.parentStrong || node.type === "strong";
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) {
        pending.push({ node: child, parentStrong });
      }
    }
  }
  return parts.join("\n");
}

function normalizeDiscordBold(markdown: string): string {
  // This outbound contract is CommonMark: `__x__` is bold, never Discord-native underline.
  const spans: Array<{ start: number; end: number }> = [];
  const contentEdits: Array<{
    spanId: number;
    start: number;
    marker: string;
    consume: number;
    delimiter: false;
  }> = [];
  const starEmphasisDelimiters = new Set<number>();
  const astLinkRanges: Array<{ start: number; end: number }> = [];
  const sourceTree = fromMarkdown(markdown) as PositionedMarkdownNode;
  const activeSpanIds: number[] = [];
  const pending: Array<{ node: PositionedMarkdownNode; exiting?: number }> = [{ node: sourceTree }];
  while (pending.length > 0) {
    const event = pending.pop();
    if (!event) {
      continue;
    }
    if (event.exiting !== undefined) {
      activeSpanIds.pop();
      continue;
    }
    const { node } = event;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (
      node.type === "link" &&
      start !== undefined &&
      end !== undefined &&
      markdown[start] === "<" &&
      markdown[end - 1] === ">"
    ) {
      astLinkRanges.push({ start, end });
    }
    let enteredSpanId: number | undefined;
    if (
      node.type === "strong" &&
      start !== undefined &&
      end !== undefined &&
      markdown.startsWith("__", start) &&
      markdown.slice(end - 2, end) === "__"
    ) {
      enteredSpanId = spans.length;
      spans.push({ start, end });
      activeSpanIds.push(enteredSpanId);
    }
    const spanId = activeSpanIds.at(-1);
    if (spanId !== undefined && start !== undefined && end !== undefined) {
      if (
        node.type === "strong" &&
        enteredSpanId === undefined &&
        markdown.startsWith("**", start) &&
        markdown.slice(end - 2, end) === "**"
      ) {
        contentEdits.push(
          { spanId, start, marker: "****", consume: 2, delimiter: false },
          { spanId, start: end - 2, marker: "****", consume: 2, delimiter: false },
        );
      } else if (node.type === "emphasis" && markdown[start] === "*" && markdown[end - 1] === "*") {
        starEmphasisDelimiters.add(start);
        starEmphasisDelimiters.add(end - 1);
        const intraword =
          /[\p{L}\p{N}]/u.test(markdown[start - 1] ?? "") ||
          /[\p{L}\p{N}]/u.test(markdown[end] ?? "");
        if (!intraword) {
          contentEdits.push(
            { spanId, start, marker: "_", consume: 1, delimiter: false },
            { spanId, start: end - 1, marker: "_", consume: 1, delimiter: false },
          );
        }
      } else if (node.type === "text") {
        for (let offset = start; offset < end; offset += 1) {
          if (markdown[offset] !== "*") {
            continue;
          }
          let precedingSlashes = 0;
          for (let index = offset - 1; index >= start && markdown[index] === "\\"; index -= 1) {
            precedingSlashes += 1;
          }
          if (precedingSlashes % 2 === 0) {
            contentEdits.push({
              spanId,
              start: offset,
              marker: "\\",
              consume: 0,
              delimiter: false,
            });
          }
        }
      }
    }
    if (enteredSpanId !== undefined) {
      pending.push({ node, exiting: enteredSpanId });
    }
    const children = node.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) {
        pending.push({ node: child });
      }
    }
  }
  if (spans.length === 0) {
    return markdown;
  }
  const strongInteriorStartByEnd = new Map<number, number>();
  for (const span of spans) {
    const interiorStart = span.start + 2;
    strongInteriorStartByEnd.set(
      span.end,
      Math.min(strongInteriorStartByEnd.get(span.end) ?? interiorStart, interiorStart),
    );
  }
  const nativeTokenRanges = [...markdown.matchAll(DISCORD_NATIVE_TOKEN_RE)].flatMap((match) =>
    match.index === undefined ? [] : [{ start: match.index, end: match.index + match[0].length }],
  );
  const protectedRanges = [
    ...findDiscordUrlRanges(markdown),
    ...astLinkRanges,
    ...nativeTokenRanges,
  ]
    .toSorted((left, right) => left.start - right.start)
    .map(({ start, end: rawEnd }) => {
      let end = rawEnd;
      while (/[.,!?;:'"]/u.test(markdown[end - 1] ?? "")) {
        end -= 1;
      }
      let previousEnd = -1;
      while (end !== previousEnd) {
        previousEnd = end;
        while (starEmphasisDelimiters.has(end - 1)) {
          end -= 1;
        }
        let strongInteriorStart = strongInteriorStartByEnd.get(end);
        while (strongInteriorStart !== undefined && start >= strongInteriorStart) {
          end -= 2;
          strongInteriorStart = strongInteriorStartByEnd.get(end);
        }
      }
      return { start, end };
    });
  const edits = [
    ...spans.flatMap((span, spanId) => [
      { spanId, start: span.start, marker: DISCORD_BOLD_MARKERS.open, consume: 2, delimiter: true },
      {
        spanId,
        start: span.end - 2,
        marker: DISCORD_BOLD_MARKERS.close,
        consume: 2,
        delimiter: true,
      },
    ]),
    ...contentEdits,
  ].toSorted((left, right) => left.start - right.start);
  const editsBySpan = new Map<number, Array<(typeof edits)[number]>>();
  for (const edit of edits) {
    const spanEdits = editsBySpan.get(edit.spanId);
    if (spanEdits) {
      spanEdits.push(edit);
    } else {
      editsBySpan.set(edit.spanId, [edit]);
    }
  }
  const protectedSpanIds = new Set<number>();
  const protectedEditKeys = new Set<string>();
  const spansWithProtectedContent = new Set<number>();
  let rangeIndex = 0;
  for (const edit of edits) {
    while ((protectedRanges[rangeIndex]?.end ?? Number.POSITIVE_INFINITY) <= edit.start) {
      rangeIndex += 1;
    }
    const range = protectedRanges[rangeIndex];
    const overlapsRange =
      range &&
      (edit.consume === 0
        ? edit.start >= range.start && edit.start < range.end
        : edit.start < range.end && edit.start + edit.consume > range.start);
    if (overlapsRange) {
      if (edit.delimiter) {
        protectedSpanIds.add(edit.spanId);
      } else {
        protectedEditKeys.add(`${edit.start}:${edit.consume}:${edit.marker}`);
        spansWithProtectedContent.add(edit.spanId);
      }
    }
  }
  for (const spanId of spansWithProtectedContent) {
    const span = spans[spanId];
    if (!span) {
      continue;
    }
    let localCursor = span.start;
    const localRendered =
      (editsBySpan.get(spanId) ?? [])
        .filter((edit) => {
          const key = `${edit.start}:${edit.consume}:${edit.marker}`;
          return !protectedEditKeys.has(key);
        })
        .map((edit) => {
          const chunk = `${markdown.slice(localCursor, edit.start)}${edit.marker}`;
          localCursor = edit.start + edit.consume;
          return chunk;
        })
        .join("") + markdown.slice(localCursor, span.end);
    const localSource = markdown.slice(span.start, span.end);
    if (
      markdownSemanticSignature(fromMarkdown(localRendered) as PositionedMarkdownNode) !==
      markdownSemanticSignature(fromMarkdown(localSource) as PositionedMarkdownNode)
    ) {
      protectedSpanIds.add(spanId);
    }
  }
  let cursor = 0;
  const seenEdits = new Set<string>();
  const rendered =
    edits
      .filter((edit) => {
        const key = `${edit.start}:${edit.consume}:${edit.marker}`;
        if (protectedSpanIds.has(edit.spanId) || protectedEditKeys.has(key) || seenEdits.has(key)) {
          return false;
        }
        seenEdits.add(key);
        return true;
      })
      .map((edit) => {
        const chunk = `${markdown.slice(cursor, edit.start)}${edit.marker}`;
        cursor = edit.start + edit.consume;
        return chunk;
      })
      .join("") + markdown.slice(cursor);
  return markdownSemanticSignature(fromMarkdown(rendered) as PositionedMarkdownNode) ===
    markdownSemanticSignature(sourceTree)
    ? rendered
    : markdown;
}

export function renderDiscordMarkdown(markdown: string, tableMode: MarkdownTableMode): string {
  return normalizeDiscordBold(convertMarkdownTables(markdown, tableMode));
}
