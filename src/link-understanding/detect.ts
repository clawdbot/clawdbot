// Link detection extracts unique safe bare HTTP(S) URLs from inbound text while filtering SSRF targets.
import { findMarkdownLinkSourceSpans } from "../../packages/markdown-core/src/link-spans.js";
import { isBlockedHostnameOrIp } from "../infra/net/ssrf.js";
import { DEFAULT_MAX_LINKS } from "./defaults.js";

const BARE_LINK_RE = /https?:\/\/\S+/gi;

function stripMarkdownLinks(message: string): string {
  const chunks: string[] = [];
  let cursor = 0;
  for (const [start, end] of findMarkdownLinkSourceSpans(message)) {
    chunks.push(message.slice(cursor, start), " ");
    cursor = end;
  }
  chunks.push(message.slice(cursor));
  return chunks.join("");
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
