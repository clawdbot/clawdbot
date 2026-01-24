export type ExtractMode = "markdown" | "text";

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
    if (!label) return href;
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
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}

export async function extractReadableContent(params: {
  html: string;
  url: string;
  extractMode: ExtractMode;
}): Promise<{ text: string; title?: string } | null> {
  const fallback = (): { text: string; title?: string } => {
    const rendered = htmlToMarkdown(params.html);
    if (params.extractMode === "text") {
      const text = markdownToText(rendered.text) || normalizeWhitespace(stripTags(params.html));
      return { text, title: rendered.title };
    }
    return rendered;
  };
  try {
    const [{ Readability }, { parseHTML }] = await Promise.all([
      import("@mozilla/readability"),
      import("linkedom"),
    ]);
    const { document } = parseHTML(params.html);
    try {
      (document as { baseURI?: string }).baseURI = params.url;
    } catch {
      // Best-effort base URI for relative links.
    }
    const reader = new Readability(document, { charThreshold: 0 });
    const parsed = reader.parse();
    if (!parsed?.content) return fallback();
    const title = parsed.title || undefined;
    if (params.extractMode === "text") {
      const text = normalizeWhitespace(parsed.textContent ?? "");
      return text ? { text, title } : fallback();
    }
    const rendered = htmlToMarkdown(parsed.content);
    return { text: rendered.text, title: title ?? rendered.title };
  } catch {
    return fallback();
  }
}
