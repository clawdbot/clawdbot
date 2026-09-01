// Link detection extracts unique safe bare HTTP(S) URLs from inbound text while filtering SSRF targets.
import { isBlockedHostnameOrIp } from "../infra/net/ssrf.js";
import { DEFAULT_MAX_LINKS } from "./defaults.js";

// Remove markdown link syntax so only bare URLs are considered.
// The link-text portion allows "]" that is not the closing "](" boundary so
// markdown links whose label contains brackets (e.g. "[my notes [v2]](...)")
// are still stripped instead of leaking their URL to BARE_LINK_RE.
// The destination may be followed by a CommonMark title ("[doc](url \"Docs\")"),
// which must be consumed too or the URL leaks out as a bare link. A title may
// contain backslash-escaped delimiters, so each alternative pairs a backslash with
// the character after it ("s" lets that be a newline) and tolerates one unpaired
// backslash before the closing delimiter. The escape and non-escape branches never
// start on the same character, so the alternation stays linear on hostile input.
const MARKDOWN_LINK_RE =
  /\[(?:[^\]]|](?!\())*]\((https?:\/\/\S+?)(?:\s+(?:"(?:[^"\\]|\\.)*\\?"|'(?:[^'\\]|\\.)*\\?'|\((?:[^()\\]|\\.)*\\?\)))?\s*\)/gis;
const BARE_LINK_RE = /https?:\/\/\S+/gi;

function stripMarkdownLinks(message: string): string {
  return message.replace(MARKDOWN_LINK_RE, " ");
}

function resolveMaxLinks(value?: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return DEFAULT_MAX_LINKS;
}

function isAllowedUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    if (isBlockedHostnameOrIp(parsed.hostname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Extracts unique, SSRF-filtered bare HTTP(S) links from inbound text.
 * Markdown links are ignored so display-only citations do not trigger fetches.
 */
export function extractLinksFromMessage(message: string, opts?: { maxLinks?: number }): string[] {
  const source = message?.trim();
  if (!source) {
    return [];
  }

  const maxLinks = resolveMaxLinks(opts?.maxLinks);
  const sanitized = stripMarkdownLinks(source);
  const seen = new Set<string>();
  const results: string[] = [];

  for (const match of sanitized.matchAll(BARE_LINK_RE)) {
    const raw = match[0]?.trim();
    if (!raw) {
      continue;
    }
    if (!isAllowedUrl(raw)) {
      continue;
    }
    if (seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    results.push(raw);
    if (results.length >= maxLinks) {
      break;
    }
  }

  return results;
}
