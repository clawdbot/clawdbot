// Feishu plugin module: single source for content_v2 inline extension parsing.
// Image extraction/replacement and native mention extraction share the same
// code-region boundary so literals never affect downloads or mention gating.
import { findCodeRegions, isInsideCode } from "openclaw/plugin-sdk/text-chunking";
import { normalizeFeishuExternalKey } from "./external-keys.js";

const MARKDOWN_MENTION_RE = /<at\s+user_id\s*=\s*"([^"]+)"\s*>[^<]*<\/at\s*>/giu;

type MarkdownImageReference = {
  start: number;
  end: number;
  keyStart: number;
  keyEnd: number;
  key: string;
};

function isEscapedMarkdownMarker(text: string, index: number): boolean {
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

// content_v2 uses ![alt](image_key). Scan the alt label instead of using a regex so
// escaped and nested closing brackets do not hide an otherwise valid image reference.
function parseMarkdownImageReferences(text: string): MarkdownImageReference[] {
  const references: MarkdownImageReference[] = [];
  let searchIndex = 0;
  while (searchIndex < text.length) {
    const start = text.indexOf("![", searchIndex);
    if (start < 0) {
      break;
    }
    searchIndex = start + 2;
    if (isEscapedMarkdownMarker(text, start)) {
      continue;
    }

    let depth = 1;
    let cursor = start + 2;
    for (; cursor < text.length && depth > 0; cursor += 1) {
      const char = text[cursor];
      if (char === "\\") {
        cursor += 1;
      } else if (char === "[") {
        depth += 1;
      } else if (char === "]") {
        depth -= 1;
      }
    }
    if (depth !== 0 || text[cursor] !== "(") {
      continue;
    }
    const keyStart = cursor + 1;
    cursor = keyStart;
    while (cursor < text.length && text[cursor] !== ")" && !/\s/.test(text[cursor] ?? "")) {
      cursor += 1;
    }
    if (cursor === keyStart || text[cursor] !== ")") {
      continue;
    }
    references.push({
      start,
      end: cursor + 1,
      keyStart,
      keyEnd: cursor,
      key: text.slice(keyStart, cursor),
    });
    searchIndex = cursor + 1;
  }
  return references;
}

/** Non-code-block image_keys in order, deduped (one image referenced twice is one download). */
export function extractMarkdownImageKeys(text: string): string[] {
  const codeRegions = findCodeRegions(text);
  const keys = new Set<string>();
  for (const reference of parseMarkdownImageReferences(text)) {
    if (isInsideCode(reference.start, codeRegions)) {
      continue;
    }
    const key = normalizeFeishuExternalKey(reference.key);
    if (key) {
      keys.add(key);
    }
  }
  return [...keys];
}

/** Native content_v2 mention ids outside fenced and inline code, in first-seen order. */
export function extractMarkdownMentionIds(text: string): string[] {
  const codeRegions = findCodeRegions(text);
  const ids = new Set<string>();
  for (const match of text.matchAll(MARKDOWN_MENTION_RE)) {
    const start = match.index ?? -1;
    if (start < 0 || isEscapedMarkdownMarker(text, start) || isInsideCode(start, codeRegions)) {
      continue;
    }
    const id = normalizeFeishuExternalKey(match[1]);
    if (id) {
      ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Rewrite non-code-block ![alt](image_key) to ![alt](local_path) in place. Code-block
 * text (fenced/inline) stays literal; a key with no path (download failed) keeps its
 * ref. Only the parenthesized URL segment is spliced — alt text containing "(key)" is
 * left intact, and the path is inserted literally (no String.replace pattern semantics,
 * so "$" in a local path can't corrupt output).
 */
export function inlineReplacePostImages(text: string, keyToPath: Map<string, string>): string {
  if (keyToPath.size === 0) {
    return text;
  }
  const codeRegions = findCodeRegions(text);
  let out = "";
  let last = 0;
  for (const reference of parseMarkdownImageReferences(text)) {
    if (isInsideCode(reference.start, codeRegions)) {
      continue;
    }
    const path = keyToPath.get(normalizeFeishuExternalKey(reference.key) || reference.key);
    out += text.slice(last, reference.start);
    if (path) {
      out +=
        text.slice(reference.start, reference.keyStart) +
        path +
        text.slice(reference.keyEnd, reference.end);
    } else {
      out += text.slice(reference.start, reference.end); // download failed: keep original ref
    }
    last = reference.end;
  }
  out += text.slice(last);
  return out;
}
