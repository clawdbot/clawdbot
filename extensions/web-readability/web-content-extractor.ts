// Web Readability plugin module implements web content extractor behavior.
import { Tokenizer, type TokenizerCallbacks } from "htmlparser2";
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
// Sole guard before a synchronous, uncancellable Readability parse whose cost
// grows superlinearly with nesting depth: 800 keeps real pages (browsers
// flatten near depth 512) while bounding the worst accepted parse to a few
// seconds. Raising it restores multi-minute gateway event-loop stalls on
// attacker-crafted pages; over-cap pages intentionally use fallback extraction.
const READABILITY_MAX_ESTIMATED_NESTING_DEPTH = 800;
const HTML_VOID_TAGS = new Set([
  "area",
  "base",
  "basefont",
  "br",
  "col",
  "command",
  "embed",
  "frame",
  "hr",
  "img",
  "input",
  "isindex",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const HTML_FOREIGN_CONTEXT_TAGS = new Set(["math", "svg"]);
const HTML_INTEGRATION_TAGS = new Set([
  "mi",
  "mo",
  "mn",
  "ms",
  "mtext",
  "annotation-xml",
  "foreignobject",
  "desc",
  "title",
]);
const HTML_FORM_TAGS = new Set([
  "input",
  "option",
  "optgroup",
  "select",
  "button",
  "datalist",
  "textarea",
]);
const HTML_P_TAG = new Set(["p"]);
const HTML_TABLE_SECTION_TAGS = new Set(["thead", "tbody"]);
const HTML_DD_DT_TAGS = new Set(["dd", "dt"]);
const HTML_RT_RP_TAGS = new Set(["rt", "rp"]);
// Keep these HTML-mode stack transitions aligned with the pinned htmlparser2
// Parser; the Tokenizer supplies exact lexical boundaries, while this indexed
// stack avoids Parser.indexOf scans for attacker-controlled unmatched closes.
const HTML_OPEN_IMPLIES_CLOSE = new Map<string, Set<string>>([
  ["tr", new Set(["tr", "th", "td"])],
  ["th", new Set(["th"])],
  ["td", new Set(["thead", "th", "td"])],
  ["body", new Set(["head", "link", "script"])],
  ["li", new Set(["li"])],
  ["p", HTML_P_TAG],
  ["h1", HTML_P_TAG],
  ["h2", HTML_P_TAG],
  ["h3", HTML_P_TAG],
  ["h4", HTML_P_TAG],
  ["h5", HTML_P_TAG],
  ["h6", HTML_P_TAG],
  ["select", HTML_FORM_TAGS],
  ["input", HTML_FORM_TAGS],
  ["output", HTML_FORM_TAGS],
  ["button", HTML_FORM_TAGS],
  ["datalist", HTML_FORM_TAGS],
  ["textarea", HTML_FORM_TAGS],
  ["option", new Set(["option"])],
  ["optgroup", new Set(["optgroup", "option"])],
  ["dd", HTML_DD_DT_TAGS],
  ["dt", HTML_DD_DT_TAGS],
  ["address", HTML_P_TAG],
  ["article", HTML_P_TAG],
  ["aside", HTML_P_TAG],
  ["blockquote", HTML_P_TAG],
  ["details", HTML_P_TAG],
  ["div", HTML_P_TAG],
  ["dl", HTML_P_TAG],
  ["fieldset", HTML_P_TAG],
  ["figcaption", HTML_P_TAG],
  ["figure", HTML_P_TAG],
  ["footer", HTML_P_TAG],
  ["form", HTML_P_TAG],
  ["header", HTML_P_TAG],
  ["hr", HTML_P_TAG],
  ["main", HTML_P_TAG],
  ["nav", HTML_P_TAG],
  ["ol", HTML_P_TAG],
  ["pre", HTML_P_TAG],
  ["section", HTML_P_TAG],
  ["table", HTML_P_TAG],
  ["ul", HTML_P_TAG],
  ["rt", HTML_RT_RP_TAGS],
  ["rp", HTML_RT_RP_TAGS],
  ["tbody", HTML_TABLE_SECTION_TAGS],
  ["tfoot", HTML_TABLE_SECTION_TAGS],
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
  const openTags: string[] = [];
  const openCounts = new Map<string, number>();
  const foreignContext = [false];
  let pendingOpenTag: string | undefined;
  let exceeded = false;

  const popOpenTag = () => {
    const tagName = openTags.pop();
    if (tagName) {
      openCounts.set(tagName, (openCounts.get(tagName) ?? 1) - 1);
    }
    return tagName;
  };

  const openTag = (tagName: string) => {
    const impliesClose = HTML_OPEN_IMPLIES_CLOSE.get(tagName);
    while (impliesClose?.has(openTags[openTags.length - 1] ?? "")) {
      popOpenTag();
    }
    if (HTML_VOID_TAGS.has(tagName)) {
      return;
    }
    openTags.push(tagName);
    openCounts.set(tagName, (openCounts.get(tagName) ?? 0) + 1);
    if (HTML_FOREIGN_CONTEXT_TAGS.has(tagName)) {
      foreignContext.unshift(true);
    } else if (HTML_INTEGRATION_TAGS.has(tagName)) {
      foreignContext.unshift(false);
    }
    if (openTags.length > maxDepth) {
      exceeded = true;
      tokenizer.pause();
    }
  };

  const ignore = () => {};
  const callbacks: TokenizerCallbacks = {
    onopentagname(start, endIndex) {
      pendingOpenTag = html.slice(start, endIndex).toLowerCase();
      openTag(pendingOpenTag);
    },
    onopentagend() {
      pendingOpenTag = undefined;
    },
    onselfclosingtag() {
      if (foreignContext[0] && pendingOpenTag && openTags[openTags.length - 1] === pendingOpenTag) {
        popOpenTag();
      }
      pendingOpenTag = undefined;
    },
    onclosetag(start, endIndex) {
      const tagName = html.slice(start, endIndex).toLowerCase();
      if (HTML_FOREIGN_CONTEXT_TAGS.has(tagName) || HTML_INTEGRATION_TAGS.has(tagName)) {
        foreignContext.shift();
      }
      // Mirror htmlparser2's HTML-mode stack: a close pops back to the nearest
      // matching open tag; an unmatched close pops nothing. A scalar decrement
      // instead let `<div></x>` net to zero while the parser nests every div.
      // openCounts settles "nothing to pop" without touching the stack, so a
      // flood of unmatched closes cannot scan every open tag per token; the
      // popping loop only ever walks tags it removes.
      if (!openCounts.get(tagName)) {
        return;
      }
      for (let name = popOpenTag(); name !== undefined; name = popOpenTag()) {
        if (name === tagName) {
          break;
        }
      }
    },
    onattribdata: ignore,
    onattribend: ignore,
    onattribentity: ignore,
    onattribname: ignore,
    oncdata: ignore,
    oncomment: ignore,
    ondeclaration: ignore,
    onend: ignore,
    onprocessinginstruction: ignore,
    ontext: ignore,
    ontextentity: ignore,
  };

  // Reuse linkedom's exact lexer so malformed tag names, attributes, raw-text
  // bodies, and self-closing syntax cannot diverge from the guarded parser.
  const tokenizer = new Tokenizer({ xmlMode: false, decodeEntities: true }, callbacks);
  tokenizer.write(html);
  tokenizer.end();
  return exceeded;
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
    const textMode = request.extractMode === "text";
    // Text mode consumes textContent; skip serializing the HTML it would discard.
    const reader = new Readability(document, textMode ? { serializer: () => "" } : undefined);
    const parsed = reader.parse();
    if (!parsed) {
      return null;
    }
    const title = parsed.title || undefined;
    const rendered = textMode
      ? { text: normalizeWhitespace(parsed.textContent ?? ""), title }
      : htmlToMarkdown(parsed.content ?? "");
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
