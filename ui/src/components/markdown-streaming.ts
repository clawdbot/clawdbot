import remend, { type RemendOptions } from "remend";
import { findMarkdownCodeSpans } from "../../../packages/markdown-core/src/reasoning-tags.js";
import {
  markdownDisclosureTagKind,
  MAX_MARKDOWN_DETAILS_DEPTH,
  scanMarkdownDisclosureLine,
} from "./markdown-details.ts";

const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const FENCE_CONTAINER_PREFIX_RE = /^[ \t]{0,3}(?:(?:>\s?)|(?:(?:[-+*]|\d{1,9}[.)])[ \t]+))/;
const LIST_ITEM_OPEN_RE = /^[ \t]{0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/u;
const LINK_REFERENCE_CANDIDATE_RE = /^[ \t]*\[/u;

type DetailsFrame = { hasSummary: boolean };
type FenceMarker = { length: number; marker: "`" | "~" };
type StrippedMarkdownLine = { content: string; offset: number };

function stripMarkdownContainerPrefixes(line: string): StrippedMarkdownLine {
  let current = line;
  let offset = 0;
  for (let index = 0; index < 8; index += 1) {
    const match = FENCE_CONTAINER_PREFIX_RE.exec(current)?.[0];
    if (!match) {
      return { content: current, offset };
    }
    current = current.slice(match.length);
    offset += match.length;
  }
  return { content: current, offset };
}

function getFenceMarker(line: string): FenceMarker | null {
  const fence = FENCE_OPEN_RE.exec(stripMarkdownContainerPrefixes(line).content)?.[1];
  return fence ? { length: fence.length, marker: fence.charAt(0) as FenceMarker["marker"] } : null;
}

function isFenceClose(line: string, fence: FenceMarker): boolean {
  const trimmed = stripMarkdownContainerPrefixes(line).content.trimEnd();
  const match = FENCE_OPEN_RE.exec(trimmed);
  const marker = match?.[1];
  if (!match || !marker) {
    return false;
  }
  return (
    marker.charAt(0) === fence.marker &&
    marker.length >= fence.length &&
    trimmed.slice(match[0].length).trim() === ""
  );
}

function updateDetailsStack(
  line: string,
  stack: DetailsFrame[],
  allowPendingSummary: boolean,
  codeSpans: ReadonlyArray<readonly [number, number]>,
  lineOffset: number,
): boolean {
  const stripped = stripMarkdownContainerPrefixes(line);
  const tags = scanMarkdownDisclosureLine(
    stripped.content,
    codeSpans,
    lineOffset + stripped.offset,
  );
  if (!tags) {
    return false;
  }
  const kinds = tags.map((tag) => markdownDisclosureTagKind(tag.raw));
  const nextSummaryClose = Array.from({ length: tags.length }, () => -1);
  let nearestSummaryClose = -1;
  for (let index = tags.length - 1; index >= 0; index -= 1) {
    nextSummaryClose[index] = nearestSummaryClose;
    if (kinds[index] === "summary_close") {
      nearestSummaryClose = index;
    }
  }
  for (let index = 0; index < tags.length; index += 1) {
    const kind = kinds[index];
    if (
      (kind === "details_open" || kind === "details_open_expanded") &&
      stack.length < MAX_MARKDOWN_DETAILS_DEPTH
    ) {
      stack.push({ hasSummary: false });
    } else if (kind === "details_close" && stack.length > 0) {
      stack.pop();
    } else if (kind === "summary_open") {
      const frame = stack.at(-1);
      if (!frame || frame.hasSummary) {
        continue;
      }
      const closeIndex = nextSummaryClose[index] ?? -1;
      if (closeIndex >= 0) {
        frame.hasSummary = true;
        index = closeIndex;
      } else if (allowPendingSummary) {
        return true;
      }
    }
  }
  return false;
}

type StreamingMarkdownSplit = {
  /** Offset just past the last blank line outside a fence/details block; the prefix is stable. */
  boundary: number;
  /** Absolute offset where remend may start, or null while a fence remains open. */
  tailRepairStart: number | null;
};

export function splitStableStreamingMarkdown(markdownLocal: string): StreamingMarkdownSplit {
  let boundary = 0;
  let index = 0;
  let openFence: FenceMarker | null = null;
  const detailsStack: DetailsFrame[] = [];
  const codeSpans = findMarkdownCodeSpans(markdownLocal);
  let lastFenceOffset = 0;
  let firstListOffset: number | null = null;
  let hasLinkReferenceDefinition = false;

  while (index < markdownLocal.length) {
    const nextLineBreak = markdownLocal.indexOf("\n", index);
    const lineEnd = nextLineBreak === -1 ? markdownLocal.length : nextLineBreak + 1;
    const line = markdownLocal.slice(index, nextLineBreak === -1 ? lineEnd : nextLineBreak);

    if (openFence) {
      if (isFenceClose(line, openFence)) {
        openFence = null;
        lastFenceOffset = lineEnd;
        if (detailsStack.length === 0) {
          boundary = lineEnd;
        }
      }
      index = lineEnd;
      continue;
    }

    if (firstListOffset === null && LIST_ITEM_OPEN_RE.test(line)) {
      firstListOffset = index;
    }

    const openingFence = getFenceMarker(line);
    if (openingFence) {
      openFence = openingFence;
      lastFenceOffset = lineEnd;
      index = lineEnd;
      continue;
    }

    updateDetailsStack(line, detailsStack, false, codeSpans, index);
    if (detailsStack.length === 0) {
      if (LINK_REFERENCE_CANDIDATE_RE.test(stripMarkdownContainerPrefixes(line).content)) {
        hasLinkReferenceDefinition = true;
      }
      if (line.trim() === "") {
        boundary = lineEnd;
      }
    }
    index = lineEnd;
  }

  // A bracket-leading line can start a multiline or escaped reference label.
  // Keep its complete document together rather than guessing label boundaries.
  if (hasLinkReferenceDefinition) {
    boundary = 0;
  } else if (firstListOffset !== null) {
    // Blank lines cannot prove a list has ended: loose items, continuation
    // indentation, and nested blocks all share the original list container.
    boundary = Math.min(boundary, firstListOffset);
  }

  return {
    boundary,
    tailRepairStart: openFence ? null : Math.max(boundary, lastFenceOffset),
  };
}

// Streaming-tail repair config: math is not rendered by this pipeline, so
// completing `$$` would inject visible characters into ordinary prose.
const streamingRemendOptions = { katex: false, linkMode: "text-only" } satisfies RemendOptions;

// Preserve completed fences verbatim while repairing only the prose after them.
export function repairStreamingMarkdownTail(tail: string, repairStart = 0): string {
  const repaired =
    tail.slice(0, repairStart) + remend(tail.slice(repairStart), streamingRemendOptions);
  const detailsStack: DetailsFrame[] = [];
  const codeSpans = findMarkdownCodeSpans(repaired);
  let openFence: FenceMarker | null = null;
  let pendingSummary = false;
  let index = 0;
  while (index < repaired.length) {
    const nextLineBreak = repaired.indexOf("\n", index);
    const lineEnd = nextLineBreak === -1 ? repaired.length : nextLineBreak + 1;
    const line = repaired.slice(index, nextLineBreak === -1 ? lineEnd : nextLineBreak);
    if (openFence) {
      if (isFenceClose(line, openFence)) {
        openFence = null;
      }
    } else {
      openFence = getFenceMarker(line);
      if (!openFence) {
        pendingSummary = updateDetailsStack(
          line,
          detailsStack,
          lineEnd === repaired.length,
          codeSpans,
          index,
        );
      }
    }
    index = lineEnd;
  }
  return pendingSummary ? `${repaired}</summary>` : repaired;
}
