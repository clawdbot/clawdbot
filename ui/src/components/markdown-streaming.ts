import remend, { type RemendOptions } from "remend";

const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const FENCE_CONTAINER_PREFIX_RE = /^[ \t]{0,3}(?:(?:>\s?)|(?:(?:[-+*]|\d{1,9}[.)])[ \t]+))/;

function stripFenceContainerPrefixes(line: string): string {
  let current = line;
  for (let index = 0; index < 8; index += 1) {
    const next = current.replace(FENCE_CONTAINER_PREFIX_RE, "");
    if (next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

function getFenceMarker(line: string): { marker: "`" | "~"; length: number } | null {
  const match = FENCE_OPEN_RE.exec(stripFenceContainerPrefixes(line));
  if (!match) {
    return null;
  }
  const fence = match[1];
  if (!fence) {
    return null;
  }
  const marker = fence.charAt(0) as "`" | "~";
  return { marker, length: fence.length };
}

function isFenceClose(line: string, fence: { marker: "`" | "~"; length: number }): boolean {
  const trimmed = stripFenceContainerPrefixes(line).trimEnd();
  const match = FENCE_OPEN_RE.exec(trimmed);
  if (!match) {
    return false;
  }
  const markerText = match[1];
  if (!markerText) {
    return false;
  }
  const marker = markerText.charAt(0);
  if (marker !== fence.marker || markerText.length < fence.length) {
    return false;
  }
  return trimmed.slice(match[0].length).trim() === "";
}

type StreamingMarkdownSplit = {
  /** Offset just past the last blank line outside a code fence; the prefix is block-stable. */
  boundary: number;
  /** True when the text after the boundary contains a code fence that has not closed yet. */
  tailHasOpenFence: boolean;
};

export function splitStableStreamingMarkdown(markdownLocal: string): StreamingMarkdownSplit {
  let boundary = 0;
  let index = 0;
  let openFence: { marker: "`" | "~"; length: number } | null = null;

  while (index < markdownLocal.length) {
    const nextLineBreak = markdownLocal.indexOf("\n", index);
    const lineEnd = nextLineBreak === -1 ? markdownLocal.length : nextLineBreak + 1;
    const line = markdownLocal.slice(index, nextLineBreak === -1 ? lineEnd : nextLineBreak);

    if (openFence) {
      if (isFenceClose(line, openFence)) {
        openFence = null;
        boundary = lineEnd;
      }
      index = lineEnd;
      continue;
    }

    const openingFence = getFenceMarker(line);
    if (openingFence) {
      openFence = openingFence;
      index = lineEnd;
      continue;
    }

    if (line.trim() === "") {
      boundary = lineEnd;
    }
    index = lineEnd;
  }

  return { boundary, tailHasOpenFence: openFence !== null };
}

// Streaming-tail repair config: math is not rendered by this pipeline, so
// completing `$$` would inject visible characters into ordinary prose.
const streamingRemendOptions = { katex: false, linkMode: "text-only" } satisfies RemendOptions;

// Renders the in-flight block live. remend closes/strips unterminated inline
// constructs (`**bold`, half links, …) so partially streamed markup styles
// immediately instead of flashing raw markers. Inside an open code fence the
// tail is code, not prose: skip remend (it only understands top-level ```
// fences) and let markdown-it auto-close the fence at end of input (CommonMark
// allows unterminated fences), so code streams with live highlighting.
// Invariant: the tail never contains a *closed* fence — the split boundary
// advances past every fence close — so remend (which cannot see ~~~ fences)
// never runs across completed fenced code.
export function repairStreamingMarkdownTail(tail: string): string {
  return remend(tail, streamingRemendOptions);
}
