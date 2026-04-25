import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../../shared/string-coerce.js";

// CSS property values that indicate an element is hidden
const HIDDEN_STYLE_PATTERNS: Array<[string, RegExp]> = [
  ["display", /^\s*none\s*$/i],
  ["visibility", /^\s*hidden\s*$/i],
  ["opacity", /^\s*0\s*$/],
  ["font-size", /^\s*0(px|em|rem|pt|%)?\s*$/i],
  ["text-indent", /^\s*-\d{4,}px\s*$/],
  ["color", /^\s*transparent\s*$/i],
  ["color", /^\s*rgba\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)\s*$/i],
  ["color", /^\s*hsla\s*\(\s*[\d.]+\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*0(?:\.0+)?\s*\)\s*$/i],
];

// Class names associated with visually hidden content
const HIDDEN_CLASS_NAMES = new Set([
  "sr-only",
  "visually-hidden",
  "d-none",
  "hidden",
  "invisible",
  "screen-reader-only",
  "offscreen",
]);
const HTML_VOID_ELEMENTS = new Set([
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

function hasHiddenClass(className: string): boolean {
  const classes = normalizeLowercaseStringOrEmpty(className).split(/\s+/);
  return classes.some((cls) => HIDDEN_CLASS_NAMES.has(cls));
}

function isStyleHidden(style: string): boolean {
  for (const [prop, pattern] of HIDDEN_STYLE_PATTERNS) {
    const escapedProp = prop.replace(/-/g, "\\-");
    const match = style.match(new RegExp(`(?:^|;)\\s*${escapedProp}\\s*:\\s*([^;]+)`, "i"));
    if (match && pattern.test(match[1])) {
      return true;
    }
  }

  // clip-path: none is not hidden, but positive percentage inset() clipping hides content.
  const clipPath = style.match(/(?:^|;)\s*clip-path\s*:\s*([^;]+)/i);
  if (clipPath && !/^\s*none\s*$/i.test(clipPath[1])) {
    if (/inset\s*\(\s*(?:0*\.\d+|[1-9]\d*(?:\.\d+)?)%/i.test(clipPath[1])) {
      return true;
    }
  }

  // transform: scale(0)
  const transform = style.match(/(?:^|;)\s*transform\s*:\s*([^;]+)/i);
  if (transform) {
    if (/scale\s*\(\s*0\s*\)/i.test(transform[1])) {
      return true;
    }
    if (/translateX\s*\(\s*-\d{4,}px\s*\)/i.test(transform[1])) {
      return true;
    }
    if (/translateY\s*\(\s*-\d{4,}px\s*\)/i.test(transform[1])) {
      return true;
    }
  }

  // width:0 + height:0 + overflow:hidden
  const width = style.match(/(?:^|;)\s*width\s*:\s*([^;]+)/i);
  const height = style.match(/(?:^|;)\s*height\s*:\s*([^;]+)/i);
  const overflow = style.match(/(?:^|;)\s*overflow\s*:\s*([^;]+)/i);
  if (
    width &&
    /^\s*0(px)?\s*$/i.test(width[1]) &&
    height &&
    /^\s*0(px)?\s*$/i.test(height[1]) &&
    overflow &&
    /^\s*hidden\s*$/i.test(overflow[1])
  ) {
    return true;
  }

  // Offscreen positioning: left/top far negative
  const left = style.match(/(?:^|;)\s*left\s*:\s*([^;]+)/i);
  const top = style.match(/(?:^|;)\s*top\s*:\s*([^;]+)/i);
  if (left && /^\s*-\d{4,}px\s*$/i.test(left[1])) {
    return true;
  }
  if (top && /^\s*-\d{4,}px\s*$/i.test(top[1])) {
    return true;
  }

  return false;
}

function readAttribute(attrs: string, name: string): string | undefined {
  const escapedName = name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const unquotedAttributeValue = "[^\\s\"'=<>`]+";
  const match = attrs.match(
    new RegExp(
      `(?:^|\\s)${escapedName}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|(${unquotedAttributeValue})))?`,
      "i",
    ),
  );
  if (!match) {
    return undefined;
  }
  return match[1] ?? match[2] ?? match[3] ?? "";
}

function hasAttribute(attrs: string, name: string): boolean {
  return readAttribute(attrs, name) !== undefined;
}

function shouldRemoveElement(tagNameRaw: string, attrs: string): boolean {
  const tagName = normalizeLowercaseStringOrEmpty(tagNameRaw);

  if (["meta", "template", "svg", "canvas", "iframe", "object", "embed"].includes(tagName)) {
    return true;
  }

  if (
    tagName === "input" &&
    normalizeOptionalLowercaseString(readAttribute(attrs, "type")) === "hidden"
  ) {
    return true;
  }

  if (normalizeOptionalLowercaseString(readAttribute(attrs, "aria-hidden")) === "true") {
    return true;
  }

  if (hasAttribute(attrs, "hidden")) {
    return true;
  }

  const className = readAttribute(attrs, "class") ?? "";
  if (hasHiddenClass(className)) {
    return true;
  }

  const style = readAttribute(attrs, "style") ?? "";
  if (style && isStyleHidden(style)) {
    return true;
  }

  return false;
}

type HtmlTagToken = {
  tagName: string;
  attrs: string;
  closing: boolean;
  selfClosing: boolean;
};

function findTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = start + 1; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") {
      return index;
    }
  }
  return -1;
}

function readTagName(source: string, start: number): { tagName: string; end: number } | null {
  let end = start;
  while (end < source.length) {
    const code = source.charCodeAt(end);
    const isNameChar =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      source[end] === "-" ||
      source[end] === "_" ||
      source[end] === ":";
    if (!isNameChar) {
      break;
    }
    end += 1;
  }
  if (end === start) {
    return null;
  }
  return {
    tagName: normalizeLowercaseStringOrEmpty(source.slice(start, end)),
    end,
  };
}

function parseHtmlTagToken(token: string): HtmlTagToken | null {
  let inner = token.slice(1, -1).trim();
  if (!inner || inner.startsWith("!") || inner.startsWith("?")) {
    return null;
  }

  const closing = inner.startsWith("/");
  if (closing) {
    inner = inner.slice(1).trimStart();
  }

  const name = readTagName(inner, 0);
  if (!name) {
    return null;
  }

  const attrs = closing ? "" : inner.slice(name.end);
  return {
    tagName: name.tagName,
    attrs,
    closing,
    selfClosing: !closing && attrs.trimEnd().endsWith("/"),
  };
}

function popDroppedElement(dropStack: string[], tagName: string): void {
  const index = dropStack.lastIndexOf(tagName);
  if (index >= 0) {
    dropStack.length = index;
  }
}

function removeMarkedElements(html: string): string {
  let output = "";
  let cursor = 0;
  const dropStack: string[] = [];

  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart < 0) {
      if (dropStack.length === 0) {
        output += html.slice(cursor);
      }
      break;
    }

    if (dropStack.length === 0) {
      output += html.slice(cursor, tagStart);
    }

    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4);
      cursor = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }

    const tagEnd = findTagEnd(html, tagStart);
    if (tagEnd < 0) {
      if (dropStack.length === 0) {
        output += html.slice(tagStart);
      }
      break;
    }

    const token = html.slice(tagStart, tagEnd + 1);
    const parsed = parseHtmlTagToken(token);
    if (!parsed) {
      if (dropStack.length === 0) {
        output += token;
      }
      cursor = tagEnd + 1;
      continue;
    }

    if (dropStack.length > 0) {
      if (parsed.closing) {
        popDroppedElement(dropStack, parsed.tagName);
      } else if (!parsed.selfClosing && !HTML_VOID_ELEMENTS.has(parsed.tagName)) {
        dropStack.push(parsed.tagName);
      }
      cursor = tagEnd + 1;
      continue;
    }

    if (parsed.closing) {
      output += token;
    } else if (shouldRemoveElement(parsed.tagName, parsed.attrs)) {
      if (!parsed.selfClosing && !HTML_VOID_ELEMENTS.has(parsed.tagName)) {
        dropStack.push(parsed.tagName);
      }
    } else {
      output += token;
    }
    cursor = tagEnd + 1;
  }

  return output;
}

export async function sanitizeHtml(html: string): Promise<string> {
  return removeMarkedElements(html);
}

// Zero-width and invisible Unicode characters used in prompt injection attacks
const INVISIBLE_UNICODE_RE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu;

export function stripInvisibleUnicode(text: string): string {
  return text.replace(INVISIBLE_UNICODE_RE, "");
}
