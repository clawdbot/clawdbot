const TELEGRAM_HTML_ENTITY_PATTERN = /&(#[xX][0-9A-Fa-f]+|#\d+|amp|lt|gt|quot|apos);/g;

// Structural tags that force a line boundary when projecting HTML to plain text
// (assistant transcript protection). Block-counting helpers for rich HTML are gone.
const TELEGRAM_LINE_BREAK_STRUCTURAL_TAGS = new Set([
  "aside",
  "audio",
  "blockquote",
  "caption",
  "col",
  "colgroup",
  "details",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tg-collage",
  "tg-map",
  "tg-math-block",
  "tg-slideshow",
  "tr",
  "ul",
  "video",
]);

export function isTelegramRichLineBreakStructuralTag(rawTag: string, tagName: string): boolean {
  return (
    TELEGRAM_LINE_BREAK_STRUCTURAL_TAGS.has(tagName) ||
    (tagName === "a" && /\sname="[^"]+"/i.test(rawTag))
  );
}

function isValidTelegramHtmlEntityCodePoint(codePoint: number): boolean {
  return (
    Number.isInteger(codePoint) &&
    codePoint >= 0 &&
    codePoint <= 0x10ffff &&
    !(codePoint >= 0xd800 && codePoint <= 0xdfff)
  );
}

function decodeTelegramHtmlEntity(entity: string, fallback: string): string {
  if (entity.startsWith("#x") || entity.startsWith("#X")) {
    const codePoint = Number.parseInt(entity.slice(2), 16);
    return isValidTelegramHtmlEntityCodePoint(codePoint)
      ? String.fromCodePoint(codePoint)
      : fallback;
  }
  if (entity.startsWith("#")) {
    const codePoint = Number.parseInt(entity.slice(1), 10);
    return isValidTelegramHtmlEntityCodePoint(codePoint)
      ? String.fromCodePoint(codePoint)
      : fallback;
  }
  switch (entity) {
    case "amp":
      return "&";
    case "lt":
      return "<";
    case "gt":
      return ">";
    case "quot":
      return '"';
    case "apos":
      return "'";
    default:
      return fallback;
  }
}

export function decodeTelegramHtmlEntities(text: string): string {
  return text.replace(TELEGRAM_HTML_ENTITY_PATTERN, (match, entity: string) =>
    decodeTelegramHtmlEntity(entity, match),
  );
}

export function findTelegramHtmlEntityEnd(text: string, start: number): number {
  if (text[start] !== "&") {
    return -1;
  }
  let index = start + 1;
  if (index >= text.length) {
    return -1;
  }
  if (text[index] === "#") {
    index += 1;
    if (index >= text.length) {
      return -1;
    }
    const isHex = text[index] === "x" || text[index] === "X";
    if (isHex) {
      index += 1;
      const hexStart = index;
      while (/[0-9A-Fa-f]/.test(text[index] ?? "")) {
        index += 1;
      }
      if (index === hexStart) {
        return -1;
      }
    } else {
      const digitStart = index;
      while (/[0-9]/.test(text[index] ?? "")) {
        index += 1;
      }
      if (index === digitStart) {
        return -1;
      }
    }
  } else {
    const nameStart = index;
    while (/[A-Za-z0-9]/.test(text[index] ?? "")) {
      index += 1;
    }
    if (index === nameStart) {
      return -1;
    }
  }
  return text[index] === ";" ? index : -1;
}
