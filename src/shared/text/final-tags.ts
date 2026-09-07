// Final tag helpers detect final-answer tag regions in assistant text.
import { findCodeRegions } from "./code-regions.js";

type FinalTagMatch = {
  index: number;
  text: string;
  isClose: boolean;
  isSelfClosing: boolean;
};

const FINAL_TAG_CANDIDATE_RE = /<[^<>]*>/g;

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function parseAttributeList(text: string): boolean {
  let index = 0;
  while (index < text.length) {
    while (index < text.length && isWhitespace(text[index] ?? "")) {
      index += 1;
    }
    if (index >= text.length) {
      return true;
    }

    const nameStart = index;
    while (index < text.length) {
      const char = text[index] ?? "";
      if (isWhitespace(char) || char === "=") {
        break;
      }
      if (char === "/" || char === '"' || char === "'" || char === "<" || char === ">") {
        return false;
      }
      index += 1;
    }
    if (index === nameStart) {
      return false;
    }

    while (index < text.length && isWhitespace(text[index] ?? "")) {
      index += 1;
    }
    if (text[index] !== "=") {
      continue;
    }
    index += 1;
    while (index < text.length && isWhitespace(text[index] ?? "")) {
      index += 1;
    }
    if (index >= text.length) {
      return false;
    }

    const quote = text[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      const end = text.indexOf(quote, index);
      if (end === -1) {
        return false;
      }
      index = end + 1;
      continue;
    }

    const valueStart = index;
    while (index < text.length && !isWhitespace(text[index] ?? "")) {
      const char = text[index] ?? "";
      if (char === '"' || char === "'" || char === "<" || char === ">") {
        return false;
      }
      index += 1;
    }
    if (index === valueStart) {
      return false;
    }
  }
  return true;
}

/** Parses a candidate `<final>` tag while rejecting lookalike names and malformed attributes. */
function parseFinalTag(text: string): Omit<FinalTagMatch, "index" | "text"> | null {
  if (!text.startsWith("<") || !text.endsWith(">")) {
    return null;
  }

  let body = text.slice(1, -1).trimStart();
  let isClose = false;
  if (body.startsWith("/")) {
    isClose = true;
    body = body.slice(1).trimStart();
  }

  if (!body.toLowerCase().startsWith("final")) {
    return null;
  }
  const boundary = body[5] ?? "";
  if (boundary && !isWhitespace(boundary) && boundary !== "/") {
    return null;
  }

  let rest = body.slice(5);
  if (isClose) {
    return rest.trim().length === 0 ? { isClose: true, isSelfClosing: false } : null;
  }

  const trimmedRest = rest.trimEnd();
  const isSelfClosing = trimmedRest.endsWith("/");
  rest = isSelfClosing ? trimmedRest.slice(0, -1) : rest;
  if (!parseAttributeList(rest)) {
    return null;
  }
  return { isClose: false, isSelfClosing };
}

/** Finds valid `<final>` control tags so callers can strip only actual model markers. */
export function findFinalTagMatches(text: string): FinalTagMatch[] {
  const matches: FinalTagMatch[] = [];
  for (const match of text.matchAll(FINAL_TAG_CANDIDATE_RE)) {
    const tagText = match[0];
    const parsed = parseFinalTag(tagText);
    if (!parsed) {
      continue;
    }
    matches.push({
      index: match.index ?? 0,
      text: tagText,
      ...parsed,
    });
  }
  return matches;
}

/** Removes final-answer markers outside Markdown code while preserving their enclosed answer. */
export function stripFinalTags(text: string): string {
  const matches = findFinalTagMatches(text);
  if (matches.length === 0) {
    return text;
  }
  // Literal examples must survive the final delivery sanitizer, just as they do reasoning cleanup.
  const codeRegions = findCodeRegions(text);
  let codeIndex = 0;
  let output = "";
  let lastIndex = 0;
  for (const match of matches) {
    // Both lists are ordered; advance once rather than rescanning every code region per tag.
    let codeRegion = codeRegions[codeIndex];
    while (codeRegion && codeRegion.end <= match.index) {
      codeIndex += 1;
      codeRegion = codeRegions[codeIndex];
    }
    if (codeRegion && codeRegion.start <= match.index) {
      continue;
    }
    output += text.slice(lastIndex, match.index);
    lastIndex = match.index + match.text.length;
  }
  output += text.slice(lastIndex);
  return output;
}
