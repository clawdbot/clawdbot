// Web Readability plugin module implements web content extractor behavior.
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  htmlToMarkdown,
  normalizeWhitespace,
  sanitizeHtml,
  stripInvisibleUnicode,
  type WebContentExtractionRequest,
  type WebContentExtractorPlugin,
} from "openclaw/plugin-sdk/web-content-extractor";

const READABILITY_MAX_HTML_CHARS = 1_000_000;
const READABILITY_MAX_ESTIMATED_NESTING_DEPTH = 3_000;
const HTML_VOID_TAGS = new Set([
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

const READABILITY_MODULE = "@mozilla/readability";
const LINKEDOM_MODULE = "linkedom";

const loadReadabilityDeps = createLazyRuntimeModule(() =>
  Promise.all([
    import(READABILITY_MODULE) as Promise<typeof import("@mozilla/readability")>,
    import(LINKEDOM_MODULE) as Promise<typeof import("linkedom")>,
  ]),
);

function exceedsEstimatedHtmlNestingDepth(html: string, maxDepth: number): boolean {
  let depth = 0;
  const len = html.length;
  for (let i = 0; i < len; i++) {
    if (html.charCodeAt(i) !== 60) {
      continue;
    }
    const next = html.charCodeAt(i + 1);
    if (next === 33 || next === 63) {
      continue;
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
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        (c >= 48 && c <= 57) ||
        c === 58 ||
        c === 45;
      if (!isNameChar) {
        break;
      }
      j += 1;
    }

    if (j === nameStart) {
      continue;
    }

    if (closing) {
      if (depth > 0) {
        depth -= 1;
      }
      continue;
    }
    const tagName = html.slice(nameStart, j).toLowerCase();
    if (HTML_VOID_TAGS.has(tagName)) {
      continue;
    }

    let selfClosing = false;
    for (let k = j; k < len && k < j + 200; k++) {
      const c = html.charCodeAt(k);
      if (c === 62) {
        selfClosing = html.charCodeAt(k - 1) === 47;
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

async function extractWithReadability(request: WebContentExtractionRequest) {
  const cleanHtml = await sanitizeHtml(request.html);
  if (
    cleanHtml.length > READABILITY_MAX_HTML_CHARS ||
    exceedsEstimatedHtmlNestingDepth(cleanHtml, READABILITY_MAX_ESTIMATED_NESTING_DEPTH)
  ) {
    return null;
  }
  try {
    const [{ Readability }, { parseHTML }] = await loadReadabilityDeps();
    const { document } = parseHTML(cleanHtml, { location: { href: request.url } });
    const reader = new Readability(document);
    const parsed = reader.parse();
    if (!parsed?.content) {
      return null;
    }
    const title = parsed.title || undefined;
    const rendered =
      request.extractMode === "text"
        ? { text: normalizeWhitespace(parsed.textContent ?? ""), title }
        : htmlToMarkdown(parsed.content);
    const text = stripInvisibleUnicode(rendered.text);
    return text ? { text, title: title ?? rendered.title } : null;
  } catch {
    return null;
  }
}

export function createReadabilityWebContentExtractor(): WebContentExtractorPlugin {
  return {
    id: "readability",
    label: "Readability",
    autoDetectOrder: 10,
    extract: extractWithReadability,
  };
}
