import { expectDefined } from "@openclaw/normalization-core";
import { iterateAnsiSegments } from "../../packages/terminal-core/src/ansi-sequences.js";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";

/** Allow one level of balanced parentheses inside a URL so markdown link
 *  targets like `https://en.wikipedia.org/wiki/URL_(disambiguation)` are
 *  fully captured instead of truncated at the first `)`. */
const URL_PATH_WITH_PARENS =
  /https?:\/\/[^()\s<>\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+(?:\([^()\s<>\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]*\)[^()\s<>\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]*)*/g;

/** Strip GFM sentence punctuation and unmatched closing parentheses from bare
 *  URLs, while preserving balanced parentheses and exact authored Markdown
 *  destinations. `(see https://example.com/path).` must link only the URL,
 *  but `[label](https://example.com/path.)` must retain its authored dot. */
function trimUrlTrailingPunctuation(url: string, knownUrls?: string[]): string {
  let open = 0;
  for (let index = 0; index < url.length; index++) {
    const ch = url[index];
    if (ch === "(") {
      open++;
    } else if (ch === ")") {
      if (open === 0) {
        const authoredUrl = url.slice(0, index);
        return knownUrls?.includes(authoredUrl)
          ? authoredUrl
          : trimUrlTrailingPunctuation(authoredUrl, knownUrls);
      }
      open--;
    }
  }
  const trimmed = url.replace(/[?!.,:;*_~]+$/u, "");
  return knownUrls?.includes(url) && !knownUrls.includes(trimmed) ? url : trimmed;
}

function hasUrlContent(url: string): boolean {
  const authority = expectDefined(
    url.slice(url.indexOf("://") + 3).split(/[/?#]/, 1)[0],
    'url.slice(url.index of("://") + 3).split(/[/?#]/, 1) entry at 0',
  );
  return /[\p{L}\p{N}]/u.test(authority) || /^\[[0-9a-f:.]+\](?::\d+)?$/i.test(authority);
}

/**
 * Extract all unique URLs from raw markdown text.
 * Finds both bare URLs and markdown link hrefs [text](url).
 */
export function extractUrls(markdown: string): string[] {
  const urls = new Set<string>();

  // Markdown link hrefs: [text](url), with optional <...> and optional title.
  const mdLinkRe = new RegExp(
    `\\[(?:[^\\]]*)\\]\\(\\s*<?(${URL_PATH_WITH_PARENS.source})>?(?:\\s+["'][^"']*["'])?\\s*\\)`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = mdLinkRe.exec(markdown)) !== null) {
    if (hasUrlContent(expectDefined(m[1], "m capture group 1"))) {
      urls.add(expectDefined(m[1], "m capture group 1"));
    }
  }

  // Bare URLs (remove markdown links first to avoid double-matching)
  const stripped = markdown.replace(mdLinkRe, "");
  const bareRe =
    /https?:\/\/(?:\[[0-9a-f:.]+\](?::\d+)?[^\s\]>\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]*|[^\s[\]>\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+)/gi;
  while ((m = bareRe.exec(stripped)) !== null) {
    const url = trimUrlTrailingPunctuation(m[0]);
    if (hasUrlContent(url)) {
      urls.add(url);
    }
  }

  return [...urls];
}

interface UrlRange {
  start: number; // visible text start index
  end: number; // visible text end index (exclusive)
  url: string; // full URL to link to
}

/**
 * Find URL ranges in a line's visible text, handling cross-line URL splits.
 */
function findUrlRanges(
  visibleText: string,
  knownUrls: string[],
  pending: { url: string; consumed: number } | null,
  nextVisibleText?: string,
): { ranges: UrlRange[]; pending: { url: string; consumed: number } | null } {
  const ranges: UrlRange[] = [];
  let newPending: { url: string; consumed: number } | null = null;
  let searchFrom = 0;

  // Handle continuation of a URL broken from the previous line
  if (pending) {
    const remaining = pending.url.slice(pending.consumed);
    const trimmed = visibleText.trimStart();
    const leadingSpaces = visibleText.length - trimmed.length;

    let matchLen = 0;
    for (let j = 0; j < remaining.length && j < trimmed.length; j++) {
      if (remaining[j] === trimmed[j]) {
        matchLen++;
      } else {
        break;
      }
    }

    if (matchLen > 0) {
      ranges.push({
        start: leadingSpaces,
        end: leadingSpaces + matchLen,
        url: pending.url,
      });
      searchFrom = leadingSpaces + matchLen;

      if (pending.consumed + matchLen < pending.url.length) {
        newPending = { url: pending.url, consumed: pending.consumed + matchLen };
      }
    }
  }

  // Find new URL starts in visible text
  const urlRe =
    /https?:\/\/(?:\[[0-9a-f:.]+\](?::\d+)?[^\s\]>\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]*|[^\s[\]>\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]*)/gi;
  urlRe.lastIndex = searchFrom;
  let match: RegExpExecArray | null;

  while ((match = urlRe.exec(visibleText)) !== null) {
    const fragment = trimUrlTrailingPunctuation(match[0], knownUrls);
    const start = match.index;

    // Resolve fragment to a known URL (exact > prefix > superstring)
    let resolvedUrl = fragment;
    let found = false;

    // A wrap may split immediately after the scheme. Only accept that fragment
    // when the next line actually continues a known URL; otherwise a stray
    // `https://` could inherit an unrelated target from the URL list.
    if (!hasUrlContent(fragment)) {
      const hasUnpunctuatedSchemeAtLineEnd =
        fragment === match[0] && visibleText.slice(start + match[0].length).trim().length === 0;
      if (!hasUnpunctuatedSchemeAtLineEnd) {
        continue;
      }
      const nextToken =
        nextVisibleText
          ?.trimStart()
          .match(/^[^\s\]>\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/)?.[0] ?? "";
      const nextFragment = trimUrlTrailingPunctuation(nextToken);
      for (const known of knownUrls) {
        if (!known.startsWith(fragment)) {
          continue;
        }
        const remaining = known.slice(fragment.length);
        const continuesKnownUrl = nextFragment.length > 0 && remaining.startsWith(nextFragment);
        if (continuesKnownUrl && known.length > resolvedUrl.length) {
          resolvedUrl = known;
          found = true;
        }
      }
      if (!found) {
        continue;
      }
    }

    if (!found && knownUrls.includes(fragment)) {
      found = true;
    }
    if (!found) {
      let bestLen = 0;
      for (const known of knownUrls) {
        if (known.startsWith(fragment) && known.length > bestLen) {
          resolvedUrl = known;
          bestLen = known.length;
          found = true;
        }
      }
    }
    if (!found) {
      let bestLen = 0;
      for (const known of knownUrls) {
        if (fragment.startsWith(known) && known.length > bestLen) {
          resolvedUrl = known;
          bestLen = known.length;
        }
      }
    }

    ranges.push({ start, end: start + fragment.length, url: resolvedUrl });

    // If fragment is a strict prefix of the resolved URL, it may be split
    if (resolvedUrl.length > fragment.length && resolvedUrl.startsWith(fragment)) {
      newPending = { url: resolvedUrl, consumed: fragment.length };
    }
  }

  return { ranges, pending: newPending };
}

/**
 * Apply OSC 8 hyperlink sequences to a line based on visible-text URL ranges.
 * Preserve renderer-owned hyperlinks while linking remaining visible URL ranges.
 */
function applyOsc8Ranges(line: string, ranges: UrlRange[]): string {
  if (ranges.length === 0) {
    return line;
  }

  let result = "";
  let visiblePos = 0;
  let activeUrl: string | null = null;
  let rendererLink = false;
  let rangeIndex = 0;
  let range = ranges[rangeIndex];

  for (const segment of iterateAnsiSegments(line)) {
    if (segment.kind === "ansi") {
      let code = segment.value;
      if (code.startsWith("\x1b]8;")) {
        if (activeUrl !== null) {
          result += "\x1b]8;;\x07";
        }
        code = code.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
        const body = code.slice(4, code.endsWith("\x1b\\") ? -2 : -1);
        rendererLink = body.slice(body.indexOf(";") + 1).length > 0;
        // The parsed Markdown href owns this span, even when its label is another URL.
        activeUrl = null;
      }
      result += code;
      continue;
    }

    let offset = 0;
    while (offset < segment.value.length) {
      while (range && visiblePos >= range.end) {
        range = ranges[++rangeIndex];
      }
      const targetUrl = !rendererLink && range && visiblePos >= range.start ? range.url : null;
      if (targetUrl !== activeUrl) {
        if (activeUrl !== null) {
          result += "\x1b]8;;\x07";
        }
        if (targetUrl !== null) {
          result += `\x1b]8;;${targetUrl}\x07`;
        }
        activeUrl = targetUrl;
      }
      let end =
        rendererLink || !range
          ? segment.value.length
          : Math.min(
              segment.value.length,
              offset + (visiblePos < range.start ? range.start : range.end) - visiblePos,
            );
      // UTF-16 range boundaries must keep whole code points, even when a wrapped
      // continuation matched only a leading surrogate.
      const last = segment.value.charCodeAt(end - 1);
      const next = segment.value.charCodeAt(end);
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        end += 1;
      }
      result += segment.value.slice(offset, end);
      visiblePos += end - offset;
      offset = end;
    }
  }

  if (activeUrl !== null) {
    result += "\x1b]8;;\x07";
  }

  return result;
}

/**
 * Add OSC 8 hyperlinks to rendered lines using a pre-extracted URL list.
 *
 * For each line, finds URL-like substrings in the visible text, matches them
 * against known URLs, and wraps each fragment with OSC 8 escape sequences.
 * Handles URLs broken across multiple lines by pi-tui's word wrapping.
 */
export function addOsc8Hyperlinks(lines: string[], urls: string[]): string[] {
  if (urls.length === 0) {
    return lines;
  }

  let pending: { url: string; consumed: number } | null = null;
  const visibleLines = lines.map(stripAnsi);

  return lines.map((line, index) => {
    const result = findUrlRanges(
      expectDefined(visibleLines[index], "visible lines entry at index"),
      urls,
      pending,
      visibleLines[index + 1],
    );
    pending = result.pending;
    return applyOsc8Ranges(line, result.ranges);
  });
}
