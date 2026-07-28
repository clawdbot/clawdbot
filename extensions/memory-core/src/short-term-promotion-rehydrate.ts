import fs from "node:fs/promises";
import { resolveShortTermSourcePathCandidates } from "./short-term-promotion-record.js";
import type { PromotionCandidate } from "./short-term-promotion-types.js";
import { normalizeSnippet, SHORT_TERM_BASENAME_RE } from "./short-term-promotion-utils.js";

const GENERIC_DAY_HEADING_RE =
  /^(?:(?:mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)(?:,\s+)?)?(?:(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}[/-]\d{2}[/-]\d{2})$/i;
const PROMOTION_LIST_MARKER_RE = /^(?:\d+\.\s+|[-*+]\s+)/;
const MANAGED_DREAMING_HEADINGS = new Set(["light sleep", "rem sleep"]);

function normalizeRangeSnippet(lines: string[], startLine: number, endLine: number): string {
  const startIndex = Math.max(0, startLine - 1);
  const endIndex = Math.min(lines.length, endLine);
  if (startIndex >= endIndex) {
    return "";
  }
  return normalizeSnippet(lines.slice(startIndex, endIndex).join(" "));
}

function normalizeListMarkerFreeRangeSnippet(
  lines: string[],
  startLine: number,
  endLine: number,
): string {
  const startIndex = Math.max(0, startLine - 1);
  const endIndex = Math.min(lines.length, endLine);
  if (startIndex >= endIndex) {
    return "";
  }
  const strippedLines = lines.slice(startIndex, endIndex).map((line) => {
    const trimmed = line.trim();
    const withoutMarker = trimmed.replace(PROMOTION_LIST_MARKER_RE, "");
    return { text: withoutMarker, hadListMarker: withoutMarker !== trimmed };
  });
  const joiner =
    strippedLines.length > 1 && strippedLines.every((line) => line.hadListMarker) ? "; " : " ";
  return normalizeSnippet(strippedLines.map((line) => line.text).join(joiner));
}

function normalizeDailyHeadingForPromotion(line: string): string | null {
  const match = line.trim().match(/^#{1,6}\s+(.+)$/);
  const heading = match?.[1]?.replace(PROMOTION_LIST_MARKER_RE, "").trim() ?? "";
  const normalized = normalizeSnippet(heading);
  if (
    !normalized ||
    SHORT_TERM_BASENAME_RE.test(normalized) ||
    isGenericDailyHeadingForPromotion(normalized)
  ) {
    return null;
  }
  return normalized;
}

function isGenericDailyHeadingForPromotion(heading: string): boolean {
  const normalized = heading.trim().replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();
  if (MANAGED_DREAMING_HEADINGS.has(lower)) {
    return true;
  }
  if (lower === "today" || lower === "yesterday" || lower === "tomorrow") {
    return true;
  }
  if (lower === "morning" || lower === "afternoon" || lower === "evening" || lower === "night") {
    return true;
  }
  return GENERIC_DAY_HEADING_RE.test(normalized);
}

function buildRelocatedDailyHeadingLookup(lines: string[]): (string | null)[] {
  const headings: (string | null)[] = Array.from({ length: lines.length + 1 }, () => null);
  let currentHeading: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    headings[index + 1] = currentHeading;
    const line = lines[index] ?? "";
    if (DREAMING_FENCE_START_RE.test(line) || DREAMING_FENCE_END_RE.test(line)) {
      currentHeading = null;
      continue;
    }
    if (/^#{1,6}\s+.+$/.test(line.trim())) {
      currentHeading = normalizeDailyHeadingForPromotion(line);
    }
  }
  return headings;
}

function buildListMarkerFreeMatchSnippet(
  heading: string | null,
  listMarkerFreeSnippet: string,
): string {
  if (!listMarkerFreeSnippet) {
    return listMarkerFreeSnippet;
  }
  return heading ? normalizeSnippet(`${heading}: ${listMarkerFreeSnippet}`) : listMarkerFreeSnippet;
}

function targetSnippetHasHeadingContext(targetSnippet: string, bodySnippet: string): boolean {
  if (!targetSnippet || !bodySnippet || targetSnippet === bodySnippet) {
    return false;
  }
  const bodyIndex = targetSnippet.indexOf(bodySnippet);
  if (bodyIndex <= 0) {
    return false;
  }
  return targetSnippet.slice(0, bodyIndex).trimEnd().endsWith(":");
}

function extractTargetHeadingBodySnippet(
  targetSnippet: string,
  bodySnippet: string,
): string | null {
  if (!targetSnippet || !bodySnippet || targetSnippet === bodySnippet) {
    return null;
  }
  if (bodySnippet.startsWith(targetSnippet)) {
    return null;
  }
  const normalizedBody = normalizeSnippet(bodySnippet);
  for (let separatorIndex = targetSnippet.indexOf(": "); separatorIndex > 0;) {
    const targetBody = normalizeSnippet(targetSnippet.slice(separatorIndex + 2));
    if (targetBody && normalizedBody.startsWith(targetBody)) {
      return targetBody;
    }
    separatorIndex = targetSnippet.indexOf(": ", separatorIndex + 2);
  }
  return null;
}

function compareCandidateWindow(
  targetSnippet: string,
  windowSnippet: string,
): { matched: boolean; quality: number } {
  if (!targetSnippet || !windowSnippet) {
    return { matched: false, quality: 0 };
  }
  if (windowSnippet === targetSnippet) {
    return { matched: true, quality: 3 };
  }
  if (windowSnippet.includes(targetSnippet)) {
    return { matched: true, quality: 2 };
  }
  if (targetSnippet.includes(windowSnippet)) {
    return { matched: true, quality: 1 };
  }
  return { matched: false, quality: 0 };
}

function relocateCandidateRange(
  lines: string[],
  candidate: PromotionCandidate,
): { startLine: number; endLine: number; snippet: string } | null {
  const targetSnippet = normalizeSnippet(candidate.snippet);
  const preferredSpan = Math.max(1, candidate.endLine - candidate.startLine + 1);
  if (targetSnippet.length === 0) {
    const fallbackSnippet = normalizeRangeSnippet(lines, candidate.startLine, candidate.endLine);
    if (!fallbackSnippet) {
      return null;
    }
    return {
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      snippet: fallbackSnippet,
    };
  }

  const exactSnippet = normalizeRangeSnippet(lines, candidate.startLine, candidate.endLine);
  if (exactSnippet === targetSnippet) {
    return {
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      snippet: exactSnippet,
    };
  }

  const maxSpan = Math.min(lines.length, Math.max(preferredSpan + 3, 8));
  const headingLookup = buildRelocatedDailyHeadingLookup(lines);
  let bestMatch:
    | { startLine: number; endLine: number; snippet: string; quality: number; distance: number }
    | undefined;
  for (let startIndex = 0; startIndex < lines.length; startIndex += 1) {
    for (let span = 1; span <= maxSpan && startIndex + span <= lines.length; span += 1) {
      const startLine = startIndex + 1;
      const endLine = startIndex + span;
      const snippet = normalizeRangeSnippet(lines, startLine, endLine);
      const comparison = compareCandidateWindow(targetSnippet, snippet);
      const listMarkerFreeSnippet = normalizeListMarkerFreeRangeSnippet(lines, startLine, endLine);
      const listMarkerFreeMatchSnippet = buildListMarkerFreeMatchSnippet(
        headingLookup[startLine] ?? null,
        listMarkerFreeSnippet,
      );
      const listMarkerFreeComparison =
        listMarkerFreeSnippet === snippet
          ? { matched: false, quality: 0 }
          : compareCandidateWindow(targetSnippet, listMarkerFreeSnippet);
      const listMarkerFreeContextComparison =
        listMarkerFreeMatchSnippet === listMarkerFreeSnippet
          ? { matched: false, quality: 0 }
          : compareCandidateWindow(targetSnippet, listMarkerFreeMatchSnippet);
      const targetHeadingBodySnippet = extractTargetHeadingBodySnippet(
        targetSnippet,
        listMarkerFreeSnippet,
      );
      const targetHeadingBodyComparison =
        targetHeadingBodySnippet && listMarkerFreeMatchSnippet !== listMarkerFreeSnippet
          ? compareCandidateWindow(targetHeadingBodySnippet, listMarkerFreeSnippet)
          : { matched: false, quality: 0 };
      const useTargetHeadingBodyContext =
        targetHeadingBodyComparison.matched &&
        targetHeadingBodyComparison.quality >= comparison.quality &&
        targetHeadingBodyComparison.quality >= listMarkerFreeComparison.quality;
      const useListMarkerFreeContext =
        !useTargetHeadingBodyContext &&
        listMarkerFreeContextComparison.quality > comparison.quality &&
        listMarkerFreeContextComparison.quality >= listMarkerFreeComparison.quality;
      const useListMarkerFree =
        !useListMarkerFreeContext && listMarkerFreeComparison.quality > comparison.quality;
      const bestComparison = useTargetHeadingBodyContext
        ? targetHeadingBodyComparison
        : useListMarkerFreeContext
          ? listMarkerFreeContextComparison
          : useListMarkerFree
            ? listMarkerFreeComparison
            : comparison;
      if (!bestComparison.matched) {
        continue;
      }
      const matchedSnippet =
        useTargetHeadingBodyContext || useListMarkerFreeContext
          ? listMarkerFreeMatchSnippet
          : useListMarkerFree
            ? targetSnippetHasHeadingContext(targetSnippet, listMarkerFreeSnippet)
              ? listMarkerFreeMatchSnippet
              : listMarkerFreeSnippet
            : snippet;
      const distance = Math.abs(startLine - candidate.startLine);
      if (
        !bestMatch ||
        bestComparison.quality > bestMatch.quality ||
        (bestComparison.quality === bestMatch.quality && distance < bestMatch.distance) ||
        (bestComparison.quality === bestMatch.quality &&
          distance === bestMatch.distance &&
          Math.abs(span - preferredSpan) <
            Math.abs(bestMatch.endLine - bestMatch.startLine + 1 - preferredSpan))
      ) {
        bestMatch = {
          startLine,
          endLine,
          snippet: matchedSnippet,
          quality: bestComparison.quality,
          distance,
        };
      }
    }
  }

  if (!bestMatch) {
    return null;
  }
  return {
    startLine: bestMatch.startLine,
    endLine: bestMatch.endLine,
    snippet: bestMatch.snippet,
  };
}

const DREAMING_FENCE_START_RE = /<!--\s*openclaw:dreaming:[a-z][a-z0-9-]*:start\s*-->/i;
const DREAMING_FENCE_END_RE = /<!--\s*openclaw:dreaming:[a-z][a-z0-9-]*:end\s*-->/i;

function lineRangeOverlapsDreamingFence(
  lines: string[],
  startLine: number,
  endLine: number,
): boolean {
  if (lines.length === 0) {
    return false;
  }
  const safeStart = Math.max(1, Math.min(startLine, lines.length));
  const safeEnd = Math.max(safeStart, Math.min(endLine, lines.length));
  let insideFence = false;
  for (let i = 0; i < safeEnd; i += 1) {
    const line = lines[i] ?? "";
    const oneIndexed = i + 1;
    const isStart = DREAMING_FENCE_START_RE.test(line);
    const isEnd = DREAMING_FENCE_END_RE.test(line);
    if (isStart || isEnd) {
      // The marker line itself is managed-block content. A relocated range
      // that includes a `<!-- openclaw:dreaming:*:start/end -->` marker would
      // build its snippet from raw lines that contain that marker text and
      // leak it into MEMORY.md alongside any adjacent fenced content captured
      // by the same window. (#80613)
      if (oneIndexed >= safeStart && oneIndexed <= safeEnd) {
        return true;
      }
      insideFence = isStart;
      continue;
    }
    if (insideFence && oneIndexed >= safeStart && oneIndexed <= safeEnd) {
      return true;
    }
  }
  return false;
}

export async function rehydratePromotionCandidate(
  workspaceDir: string,
  candidate: PromotionCandidate,
): Promise<PromotionCandidate | null> {
  const sourcePaths = resolveShortTermSourcePathCandidates(workspaceDir, candidate.path);
  for (const sourcePath of sourcePaths) {
    let rawSource: string;
    try {
      rawSource = await fs.readFile(sourcePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        continue;
      }
      throw err;
    }

    const lines = rawSource.split(/\r?\n/);
    const relocated = relocateCandidateRange(lines, candidate);
    if (!relocated) {
      continue;
    }
    // Managed dreaming blocks in daily memory files are scratchwork, not durable
    // content. If rehydration lands inside an openclaw:dreaming fence (for example
    // because file edits shifted lines between ranking and apply), refuse the
    // candidate so dream artifacts cannot be promoted into MEMORY.md.
    if (lineRangeOverlapsDreamingFence(lines, relocated.startLine, relocated.endLine)) {
      continue;
    }
    return {
      ...candidate,
      startLine: relocated.startLine,
      endLine: relocated.endLine,
      snippet: relocated.snippet,
    };
  }
  return null;
}
