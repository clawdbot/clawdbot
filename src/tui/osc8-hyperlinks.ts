// Regex patterns for ANSI escape sequences (constructed from strings to
import { expectDefined } from "@openclaw/normalization-core";
// satisfy the no-control-regex lint rule).
const SGR_PATTERN = "\\x1b\\[[0-9;]*m";
const OSC8_PATTERN = "\\x1b\\]8;;.*?(?:\\x07|\\x1b\\\\)";
const ANSI_RE = new RegExp(`${SGR_PATTERN}|${OSC8_PATTERN}`, "g");
const SGR_START_RE = new RegExp(`^${SGR_PATTERN}`);
const OSC8_START_RE = new RegExp(`^${OSC8_PATTERN}`);

/** Allow one level of balanced parentheses inside a URL so markdown link
 *  targets like `https://en.wikipedia.org/wiki/URL_(disambiguation)` are
 *  fully captured instead of truncated at the first `)`. */
const URL_PATH_WITH_PARENS = /https?:\/\/[^()\s<>]+(?:\([^()\s<>]*\)[^()\s<>]*)*/g;

/** Strip the suffix starting at a `)` without a matching `(` in the URL.
 *  Bare URLs in prose can pick up a trailing `)` that belongs to surrounding
 *  punctuation, e.g. `(see https://example.com/path)` — the `)` after `path`
 *  and anything after it are sentence punctuation, not part of the URL. */
function trimUnbalancedTrailingParens(url: string): string {
  let open = 0;
  for (let index = 0; index < url.length; index++) {
    const ch = url[index];
    if (ch === "(") {
      open++;
    } else if (ch === ")") {
      if (open === 0) {
        return url.slice(0, index);
      }
      open--;
    }
  }
  return url;
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
  const bareRe = /https?:\/\/(?:\[[0-9a-f:.]+\](?::\d+)?[^\s\]>]*|[^\s[\]>]+)/gi;
  while ((m = bareRe.exec(stripped)) !== null) {
    const url = trimUnbalancedTrailingParens(m[0]);
    if (hasUrlContent(url)) {
      urls.add(url);
    }
  }

  return [...urls];
}

/** Strip ANSI SGR and OSC 8 sequences to get visible text. */
function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, "");
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
  const urlRe = /https?:\/\/(?:\[[0-9a-f:.]+\](?::\d+)?[^\s\]>]*|[^\s[\]>]*)/gi;
  urlRe.lastIndex = searchFrom;
  let match: RegExpExecArray | null;

  while ((match = urlRe.exec(visibleText)) !== null) {
    const fragment = trimUnbalancedTrailingParens(match[0]);
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
      const nextToken = nextVisibleText?.trimStart().match(/^[^\s\]>]+/)?.[0] ?? "";
      const nextFragment = trimUnbalancedTrailingParens(nextToken);
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

    if (!found) {
      for (const known of knownUrls) {
        if (known === fragment) {
          resolvedUrl = known;
          found = true;
          break;
        }
      }
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
 * Walks through the raw string character by character, inserting OSC 8
 * open/close sequences at URL range boundaries while preserving ANSI codes.
 */
function applyOsc8Ranges(line: string, ranges: UrlRange[]): string {
  if (ranges.length === 0) {
    return line;
  }

  // Build a lookup: visible position → URL
  const urlAt = new Map<number, string>();
  for (const r of ranges) {
    for (let p = r.start; p < r.end; p++) {
      urlAt.set(p, r.url);
    }
  }

  let result = "";
  let visiblePos = 0;
  let activeUrl: string | null = null;
  let i = 0;

  while (i < line.length) {
    // Fast path: only check for escape sequences when we see ESC
    if (line.charCodeAt(i) === 0x1b) {
      // ANSI SGR sequence
      const sgr = line.slice(i).match(SGR_START_RE);
      if (sgr) {
        result += sgr[0];
        i += sgr[0].length;
        continue;
      }

      // Existing OSC 8 sequence (pass through)
      const osc = line.slice(i).match(OSC8_START_RE);
      if (osc) {
        result += osc[0];
        i += osc[0].length;
        continue;
      }
    }

    // Visible character — toggle OSC 8 at range boundaries
    const targetUrl = urlAt.get(visiblePos) ?? null;
    if (targetUrl !== activeUrl) {
      if (activeUrl !== null) {
        result += "\x1b]8;;\x07";
      }
      if (targetUrl !== null) {
        result += `\x1b]8;;${targetUrl}\x07`;
      }
      activeUrl = targetUrl;
    }

    result += line[i];
    visiblePos++;
    i++;
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
