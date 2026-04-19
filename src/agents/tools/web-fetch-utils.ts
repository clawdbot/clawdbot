import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { sanitizeHtml, stripInvisibleUnicode } from "./web-fetch-visibility.js";

export type ExtractMode = "markdown" | "text";

const READABILITY_MAX_HTML_CHARS = 1_000_000;
const READABILITY_MAX_ESTIMATED_NESTING_DEPTH = 3_000;

type ParsedHtml = {
  document: Document;
};

type ParseHtml = (html: string) => ParsedHtml;

type ReadabilityResult = {
  content?: string;
  textContent?: string | null;
  title?: string | null;
};

type ReadabilityInstance = {
  parse(): ReadabilityResult | null;
};

type ReadabilityConstructor = new (
  document: Document,
  options: { charThreshold: number },
) => ReadabilityInstance;

type ReadabilityModule = {
  Readability: ReadabilityConstructor;
};

type LinkedomModule = {
  parseHTML: ParseHtml;
};

const READABILITY_MODULE = "@mozilla/readability";
const LINKEDOM_MODULE = "linkedom";

let readabilityDepsPromise:
  | Promise<{
      Readability: ReadabilityConstructor;
      parseHTML: ParseHtml;
    }>
  | undefined;

async function loadReadabilityDeps(): Promise<{
  Readability: ReadabilityConstructor;
  parseHTML: ParseHtml;
}> {
  if (!readabilityDepsPromise) {
    readabilityDepsPromise = Promise.all([
      import(READABILITY_MODULE) as Promise<ReadabilityModule>,
      import(LINKEDOM_MODULE) as Promise<LinkedomModule>,
    ]).then(([readability, linkedom]) => ({
      Readability: readability.Readability,
      parseHTML: linkedom.parseHTML,
    }));
  }
  try {
    return await readabilityDepsPromise;
  } catch (error) {
    readabilityDepsPromise = undefined;
    throw error;
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gi, (_, dec) => String.fromCharCode(Number.parseInt(dec, 10)));
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ""));
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function htmlToMarkdown(html: string): { text: string; title?: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? normalizeWhitespace(stripTags(titleMatch[1])) : undefined;
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
    const label = normalizeWhitespace(stripTags(body));
    if (!label) {
      return href;
    }
    return `[${label}](${href})`;
  });
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
    const prefix = "#".repeat(Math.max(1, Math.min(6, Number.parseInt(level, 10))));
    const label = normalizeWhitespace(stripTags(body));
    return `\n${prefix} ${label}\n`;
  });
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
    const label = normalizeWhitespace(stripTags(body));
    return label ? `\n- ${label}` : "";
  });
  text = text
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|table|tr|ul|ol)>/gi, "\n");
  text = stripTags(text);
  text = normalizeWhitespace(text);
  return { text, title };
}

export function markdownToText(markdown: string): string {
  let text = markdown;
  text = text.replace(/!\[[^\]]*]\([^)]+\)/g, "");
  text = text.replace(/\[([^\]]+)]\([^)]+\)/g, "$1");
  text = text.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/```[^\n]*\n?/g, "").replace(/```/g, ""),
  );
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  return normalizeWhitespace(text);
}

export function truncateText(
  value: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, maxChars), truncated: true };
}

function exceedsEstimatedHtmlNestingDepth(html: string, maxDepth: number): boolean {
  // Cheap heuristic to skip Readability+DOM parsing on pathological HTML (deep nesting => stack/memory blowups).
  // Not an HTML parser; tuned to catch attacker-controlled "<div><div>..." cases.
  const voidTags = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);

  let depth = 0;
  const len = html.length;
  for (let i = 0; i < len; i++) {
    if (html.charCodeAt(i) !== 60) {
      continue; // '<'
    }
    const next = html.charCodeAt(i + 1);
    if (next === 33 || next === 63) {
      continue; // <! ...> or <? ...>
    }

    let j = i + 1;
    let closing = false;
    if (html.charCodeAt(j) === 47) {
      closing = true;
      j += 1;
    }

    while (j < len && html.charCodeAt(j) <= 32) {
      j += 1;
    }

    const nameStart = j;
    while (j < len) {
      const c = html.charCodeAt(j);
      const isNameChar =
        (c >= 65 && c <= 90) || // A-Z
        (c >= 97 && c <= 122) || // a-z
        (c >= 48 && c <= 57) || // 0-9
        c === 58 || // :
        c === 45; // -
      if (!isNameChar) {
        break;
      }
      j += 1;
    }

    const tagName = normalizeLowercaseStringOrEmpty(html.slice(nameStart, j));
    if (!tagName) {
      continue;
    }

    if (closing) {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (voidTags.has(tagName)) {
      continue;
    }

    // Best-effort self-closing detection: scan a short window for "/>".
    let selfClosing = false;
    for (let k = j; k < len && k < j + 200; k++) {
      const c = html.charCodeAt(k);
      if (c === 62) {
        if (html.charCodeAt(k - 1) === 47) {
          selfClosing = true;
        }
        break;
      }
    }
    if (selfClosing) {
      continue;
    }

    depth += 1;
    if (depth > maxDepth) {
      return true;
    }
  }
  return false;
}

export async function extractBasicHtmlContent(params: {
  html: string;
  extractMode: ExtractMode;
}): Promise<{ text: string; title?: string } | null> {
  const cleanHtml = await sanitizeHtml(params.html);
  const rendered = htmlToMarkdown(cleanHtml);
  if (params.extractMode === "text") {
    const text =
      stripInvisibleUnicode(markdownToText(rendered.text)) ||
      stripInvisibleUnicode(normalizeWhitespace(stripTags(cleanHtml)));
    return text ? { text, title: rendered.title } : null;
  }
  const text = stripInvisibleUnicode(rendered.text);
  return text ? { text, title: rendered.title } : null;
}

export async function extractReadableContent(params: {
  html: string;
  url: string;
  extractMode: ExtractMode;
}): Promise<{ text: string; title?: string } | null> {
  const cleanHtml = await sanitizeHtml(params.html);
  if (
    cleanHtml.length > READABILITY_MAX_HTML_CHARS ||
    exceedsEstimatedHtmlNestingDepth(cleanHtml, READABILITY_MAX_ESTIMATED_NESTING_DEPTH)
  ) {
    return null;
  }
  try {
    const { Readability, parseHTML } = await loadReadabilityDeps();
    const { document } = parseHTML(cleanHtml);
    try {
      (document as { baseURI?: string }).baseURI = params.url;
    } catch {
      // Best-effort base URI for relative links.
    }
    const reader = new Readability(document, { charThreshold: 0 });
    const parsed = reader.parse();
    if (!parsed?.content) {
      return null;
    }
    const title = parsed.title || undefined;
    if (params.extractMode === "text") {
      const text = stripInvisibleUnicode(normalizeWhitespace(parsed.textContent ?? ""));
      return text ? { text, title } : null;
    }
    const rendered = htmlToMarkdown(parsed.content);
    const text = stripInvisibleUnicode(rendered.text);
    return text ? { text, title: title ?? rendered.title } : null;
  } catch {
    return null;
  }
}
