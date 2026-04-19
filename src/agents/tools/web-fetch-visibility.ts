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

type ParsedHtml = {
  document: Document;
};

type ParseHtml = (html: string) => ParsedHtml;

type LinkedomModule = {
  parseHTML: ParseHtml;
};

const LINKEDOM_MODULE = "linkedom";

let parseHtmlPromise: Promise<ParseHtml> | null = null;

async function loadParseHTML(): Promise<ParseHtml> {
  parseHtmlPromise ??= (import(LINKEDOM_MODULE) as Promise<LinkedomModule>).then(
    ({ parseHTML }) => parseHTML,
  );
  return parseHtmlPromise;
}

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

function shouldRemoveElement(element: Element): boolean {
  const tagName = normalizeLowercaseStringOrEmpty(element.tagName);

  // Always-remove tags
  if (["meta", "template", "svg", "canvas", "iframe", "object", "embed"].includes(tagName)) {
    return true;
  }

  // input type=hidden
  if (
    tagName === "input" &&
    normalizeOptionalLowercaseString(element.getAttribute("type")) === "hidden"
  ) {
    return true;
  }

  // aria-hidden=true
  if (element.getAttribute("aria-hidden") === "true") {
    return true;
  }

  // hidden attribute
  if (element.hasAttribute("hidden")) {
    return true;
  }

  // class-based hiding
  const className = element.getAttribute("class") ?? "";
  if (hasHiddenClass(className)) {
    return true;
  }

  // inline style-based hiding
  const style = element.getAttribute("style") ?? "";
  if (style && isStyleHidden(style)) {
    return true;
  }

  return false;
}

export async function sanitizeHtml(html: string): Promise<string> {
  // Strip HTML comments
  let sanitized = html.replace(/<!--[\s\S]*?-->/g, "");

  let document: Document;
  try {
    const parseHTML = await loadParseHTML();
    ({ document } = parseHTML(sanitized) as { document: Document });
  } catch {
    return sanitized;
  }

  // Walk all elements and remove hidden ones (bottom-up to avoid re-walking removed subtrees)
  const all = Array.from(document.querySelectorAll("*"));
  for (let i = all.length - 1; i >= 0; i--) {
    const el = all[i];
    if (shouldRemoveElement(el)) {
      el.parentNode?.removeChild(el);
    }
  }

  return (document as unknown as { toString(): string }).toString();
}

// Zero-width and invisible Unicode characters used in prompt injection attacks
const INVISIBLE_UNICODE_RE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu;

export function stripInvisibleUnicode(text: string): string {
  return text.replace(INVISIBLE_UNICODE_RE, "");
}
