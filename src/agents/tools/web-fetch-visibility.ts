/**
 * HTML visibility sanitizers for web_fetch.
 *
 * Removes hidden or invisible content before readable-text extraction.
 */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { readTagToken } from "./web-fetch-html-tag.js";

// Compile property matchers once: this list is checked for every styled element.
const HIDDEN_STYLE_PATTERNS = (
  [
    ["display", /^\s*none\s*$/i],
    ["visibility", /^\s*hidden\s*$/i],
    ["opacity", /^\s*0\s*$/],
    ["font-size", /^\s*0(px|em|rem|pt|%)?\s*$/i],
    ["text-indent", /^\s*-\d{4,}px\s*$/],
    ["color", /^\s*transparent\s*$/i],
    ["color", /^\s*rgba\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)\s*$/i],
    ["color", /^\s*hsla\s*\(\s*[\d.]+\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*0(?:\.0+)?\s*\)\s*$/i],
  ] satisfies Array<[string, RegExp]>
).map(([prop, valuePattern]) => {
  const escapedProp = prop.replace(/-/g, "\\-");
  return [new RegExp(`(?:^|;)\\s*${escapedProp}\\s*:\\s*([^;]+)`, "i"), valuePattern] as const;
});

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
  for (const [propertyPattern, valuePattern] of HIDDEN_STYLE_PATTERNS) {
    const match = style.match(propertyPattern);
    const value = match?.at(1);
    if (value && valuePattern.test(value)) {
      return true;
    }
  }

  // clip-path: none is not hidden, but positive percentage inset() clipping hides content.
  const clipPath = style.match(/(?:^|;)\s*clip-path\s*:\s*([^;]+)/i);
  const clipPathValue = clipPath?.at(1);
  if (clipPathValue && !/^\s*none\s*$/i.test(clipPathValue)) {
    if (/inset\s*\(\s*(?:0*\.\d+|[1-9]\d*(?:\.\d+)?)%/i.test(clipPathValue)) {
      return true;
    }
  }

  // transform: scale(0)
  const transform = style.match(/(?:^|;)\s*transform\s*:\s*([^;]+)/i);
  const transformValue = transform?.at(1);
  if (transformValue) {
    if (/scale\s*\(\s*0\s*\)/i.test(transformValue)) {
      return true;
    }
    if (/translateX\s*\(\s*-\d{4,}px\s*\)/i.test(transformValue)) {
      return true;
    }
    if (/translateY\s*\(\s*-\d{4,}px\s*\)/i.test(transformValue)) {
      return true;
    }
  }

  // width:0 + height:0 + overflow:hidden
  const width = style.match(/(?:^|;)\s*width\s*:\s*([^;]+)/i);
  const height = style.match(/(?:^|;)\s*height\s*:\s*([^;]+)/i);
  const overflow = style.match(/(?:^|;)\s*overflow\s*:\s*([^;]+)/i);
  if (
    width &&
    /^\s*0(px)?\s*$/i.test(width.at(1) ?? "") &&
    height &&
    /^\s*0(px)?\s*$/i.test(height.at(1) ?? "") &&
    overflow &&
    /^\s*hidden\s*$/i.test(overflow.at(1) ?? "")
  ) {
    return true;
  }

  // Offscreen positioning: left/top far negative
  const left = style.match(/(?:^|;)\s*left\s*:\s*([^;]+)/i);
  const top = style.match(/(?:^|;)\s*top\s*:\s*([^;]+)/i);
  if (left && /^\s*-\d{4,}px\s*$/i.test(left.at(1) ?? "")) {
    return true;
  }
  if (top && /^\s*-\d{4,}px\s*$/i.test(top.at(1) ?? "")) {
    return true;
  }

  return false;
}

// The fixed visibility attributes share one grammar; each reader compiles it once per process.
function createAttributeReader(attribute: "aria-hidden" | "class" | "hidden" | "style" | "type") {
  const pattern = new RegExp(
    `(?:^|\\s)${attribute}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+)))?`,
    "i",
  );
  return (attrs: string): string | undefined => {
    const match = attrs.match(pattern);
    return match ? (match[1] ?? match[2] ?? match[3] ?? "") : undefined;
  };
}

const readType = createAttributeReader("type");
const readAriaHidden = createAttributeReader("aria-hidden");
const readHidden = createAttributeReader("hidden");
const readClass = createAttributeReader("class");
const readStyle = createAttributeReader("style");

function shouldRemoveElement(tagNameRaw: string, attrs: string): boolean {
  const tagName = normalizeLowercaseStringOrEmpty(tagNameRaw);

  if (["meta", "template", "svg", "canvas", "iframe", "object", "embed"].includes(tagName)) {
    return true;
  }

  if (tagName === "input" && normalizeOptionalLowercaseString(readType(attrs)) === "hidden") {
    return true;
  }

  if (normalizeOptionalLowercaseString(readAriaHidden(attrs)) === "true") {
    return true;
  }

  if (readHidden(attrs) !== undefined) {
    return true;
  }

  const className = readClass(attrs) ?? "";
  if (hasHiddenClass(className)) {
    return true;
  }

  const style = readStyle(attrs) ?? "";
  if (style && isStyleHidden(style)) {
    return true;
  }

  return false;
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

    const read = readTagToken(html, tagStart, "visibility");
    if (!read) {
      if (dropStack.length === 0) {
        output += html.slice(tagStart);
      }
      break;
    }

    const token = html.slice(tagStart, read.next);
    const parsed = read.token;
    if (!parsed) {
      if (dropStack.length === 0) {
        output += token;
      }
      cursor = read.next;
      continue;
    }

    if (dropStack.length > 0) {
      if (parsed.closing) {
        popDroppedElement(dropStack, parsed.name);
      } else if (!parsed.selfClosing && !HTML_VOID_ELEMENTS.has(parsed.name)) {
        dropStack.push(parsed.name);
      }
      cursor = read.next;
      continue;
    }

    if (parsed.closing) {
      output += token;
    } else if (shouldRemoveElement(parsed.name, parsed.attrs)) {
      if (!parsed.selfClosing && !HTML_VOID_ELEMENTS.has(parsed.name)) {
        dropStack.push(parsed.name);
      }
    } else {
      output += token;
    }
    cursor = read.next;
  }

  return output;
}

export async function sanitizeHtml(html: string): Promise<string> {
  return removeMarkedElements(html);
}
