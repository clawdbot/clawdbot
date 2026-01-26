import { DEFAULT_MAX_LINKS } from "./defaults.js";

// Remove markdown link syntax so only bare URLs are considered.
const MARKDOWN_LINK_RE = /\[[^\]]*]\((https?:\/\/\S+?)\)/gi;
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
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.hostname === "127.0.0.1") return false;
    return true;
  } catch {
    return false;
  }
}

export function extractLinksFromMessage(message: string, opts?: { maxLinks?: number }): string[] {
  const source = message?.trim();
  if (!source) return [];

  const maxLinks = resolveMaxLinks(opts?.maxLinks);
  const sanitized = stripMarkdownLinks(source);
  const seen = new Set<string>();
  const results: string[] = [];

  for (const match of sanitized.matchAll(BARE_LINK_RE)) {
    const raw = match[0]?.trim();
    if (!raw) continue;
    if (!isAllowedUrl(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    results.push(raw);
    if (results.length >= maxLinks) break;
  }

  return results;
}
