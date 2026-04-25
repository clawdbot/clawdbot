import type {
  WebContentExtractionRequest,
  WebContentExtractionResult,
  WebContentExtractorPlugin,
} from "openclaw/plugin-sdk/web-content-extractor";
import {
  htmlToMarkdown,
  normalizeWhitespace,
  sanitizeHtml,
  stripInvisibleUnicode,
} from "openclaw/plugin-sdk/web-content-extractor";

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

function normalizeLowercaseStringOrEmpty(value: string): string {
  return value.trim().toLowerCase();
}

function exceedsEstimatedHtmlNestingDepth(html: string, maxDepth: number): boolean {
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

async function extractWithReadability(
  request: WebContentExtractionRequest,
): Promise<WebContentExtractionResult | null> {
  const cleanHtml = await sanitizeHtml(request.html);
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
      (document as { baseURI?: string }).baseURI = request.url;
    } catch {
      // Best-effort base URI for relative links.
    }
    const reader = new Readability(document, { charThreshold: 0 });
    const parsed = reader.parse();
    if (!parsed?.content) {
      return null;
    }
    const title = parsed.title || undefined;
    if (request.extractMode === "text") {
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

export function createReadabilityWebContentExtractor(): WebContentExtractorPlugin {
  return {
    id: "readability",
    label: "Readability",
    autoDetectOrder: 10,
    extract: extractWithReadability,
  };
}
