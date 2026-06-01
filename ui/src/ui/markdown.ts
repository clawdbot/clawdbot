import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import MarkdownIt from "markdown-it";
import markdownItTaskLists from "markdown-it-task-lists";
import { stripUnsupportedCitationControlMarkers } from "../../../src/shared/text/citation-control-markers.js";
import { i18n, t } from "../i18n/index.ts";
import { truncateText } from "./format.ts";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";

const allowedTags = [
  "a",
  "b",
  "blockquote",
  "br",
  "button",
  "code",
  "del",
  "details",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "i",
  "input",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "summary",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
  "img",
];

const allowedAttrs = [
  "checked",
  "class",
  "disabled",
  "href",
  "rel",
  "target",
  "title",
  "start",
  "src",
  "alt",
  "data-code",
  "type",
  "aria-label",
];
const sanitizeOptions = {
  ALLOWED_TAGS: allowedTags,
  ALLOWED_ATTR: allowedAttrs,
  ADD_DATA_URI_TAGS: ["img"],
};

let hooksInstalled = false;
const MARKDOWN_CHAR_LIMIT = 140_000;
const MARKDOWN_PARSE_LIMIT = 40_000;
const MARKDOWN_CACHE_LIMIT = 200;
const MARKDOWN_CACHE_MAX_CHARS = 50_000;
const INLINE_DATA_IMAGE_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;
const HOST_LOCAL_FILE_HREF_RE =
  /^(?:~\/|\/(?:Users|home|tmp|private\/tmp|var\/folders|private\/var\/folders)\/|\/[A-Za-z]:\/|[A-Za-z]:[\\/])/;
const markdownCache = new Map<string, string>();
const TAIL_LINK_BLUR_CLASS = "chat-link-tail-blur";
const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const FENCE_CONTAINER_PREFIX_RE = /^[ \t]{0,3}(?:(?:>\s?)|(?:(?:[-+*]|\d{1,9}[.)])[ \t]+))/;

export type MarkdownCodeBlockChrome = "copy" | "none";

export type MarkdownRenderOptions = {
  codeBlockChrome?: MarkdownCodeBlockChrome;
};

type MarkdownRenderEnv = {
  codeBlockChrome: MarkdownCodeBlockChrome;
};

// CJK character ranges for URL boundary detection (RFC 3986: CJK is not valid in raw URLs).
// CJK Unified Ideographs, CJK Symbols/Punctuation, Fullwidth Forms, Hiragana, Katakana,
// Hangul Syllables, and CJK Compatibility Ideographs.
const CJK_RE = new RegExp(
  "[\\u2E80-\\u2FFF\\u3000-\\u303F\\u3040-\\u309F\\u30A0-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF\\uFF01-\\uFF60]",
);

function getCachedMarkdown(key: string): string | null {
  const cached = markdownCache.get(key);
  if (cached === undefined) {
    return null;
  }
  markdownCache.delete(key);
  markdownCache.set(key, cached);
  return cached;
}

function setCachedMarkdown(key: string, value: string) {
  markdownCache.set(key, value);
  if (markdownCache.size <= MARKDOWN_CACHE_LIMIT) {
    return;
  }
  const oldest = markdownCache.keys().next().value;
  if (oldest) {
    markdownCache.delete(oldest);
  }
}

function normalizeMarkdownRenderOptions(options: MarkdownRenderOptions = {}): MarkdownRenderEnv {
  return {
    codeBlockChrome: options.codeBlockChrome ?? "copy",
  };
}

function shouldRenderCodeBlockCopy(env: unknown): boolean {
  return (env as Partial<MarkdownRenderEnv> | undefined)?.codeBlockChrome !== "none";
}

function isHostLocalFileHref(href: string): boolean {
  return HOST_LOCAL_FILE_HREF_RE.test(href.trim());
}

function installHooks() {
  if (hooksInstalled) {
    return;
  }
  hooksInstalled = true;

  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (!(node instanceof HTMLAnchorElement)) {
      return;
    }
    const href = node.getAttribute("href");
    if (!href) {
      return;
    }

    if (isHostLocalFileHref(href)) {
      node.removeAttribute("href");
      return;
    }

    // Block dangerous URL schemes (javascript:, data:, vbscript:, etc.)
    try {
      const url = new URL(href, window.location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") {
        node.removeAttribute("href");
        return;
      }
    } catch {
      // Relative URLs are fine; malformed absolute URLs with dangerous schemes
      // will fail to parse and keep their href — but DOMPurify already strips
      // javascript: by default. This is defense-in-depth.
    }

    node.setAttribute("rel", "noreferrer noopener");
    node.setAttribute("target", "_blank");
    if (normalizeLowercaseStringOrEmpty(href).includes("tail")) {
      node.classList.add(TAIL_LINK_BLUR_CLASS);
    }
  });
}

// ── markdown-it instance with custom renderers ──

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeMarkdownImageLabel(text?: string | null): string {
  const trimmed = text?.trim();
  return trimmed ? trimmed : "image";
}

function normalizeMarkdownInput(markdownLocal: string): string {
  const input = stripUnsupportedCitationControlMarkers(markdownLocal).trim();
  if (!input) {
    return "";
  }
  const truncated = truncateText(input, MARKDOWN_CHAR_LIMIT);
  const suffix = truncated.truncated
    ? `\n\n… truncated (${truncated.total} chars, showing first ${truncated.text.length}).`
    : "";
  return `${truncated.text}${suffix}`.replace(/\r\n?/g, "\n");
}

function getFenceMarker(line: string): { marker: "`" | "~"; length: number } | null {
  const match = FENCE_OPEN_RE.exec(stripFenceContainerPrefixes(line));
  if (!match) {
    return null;
  }
  const fence = match[1];
  const marker = fence[0] as "`" | "~";
  return { marker, length: fence.length };
}

function stripFenceContainerPrefixes(line: string): string {
  let current = line;
  for (let index = 0; index < 8; index += 1) {
    const next = current.replace(FENCE_CONTAINER_PREFIX_RE, "");
    if (next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

function isFenceClose(line: string, fence: { marker: "`" | "~"; length: number }): boolean {
  const trimmed = stripFenceContainerPrefixes(line).trimEnd();
  const match = FENCE_OPEN_RE.exec(trimmed);
  if (!match) {
    return false;
  }
  const marker = match[1][0];
  if (marker !== fence.marker || match[1].length < fence.length) {
    return false;
  }
  return trimmed.slice(match[0].length).trim() === "";
}

function findStableStreamingMarkdownBoundary(markdownLocal: string): number {
  let boundary = 0;
  let index = 0;
  let openFence: { marker: "`" | "~"; length: number } | null = null;

  while (index < markdownLocal.length) {
    const nextLineBreak = markdownLocal.indexOf("\n", index);
    const lineEnd = nextLineBreak === -1 ? markdownLocal.length : nextLineBreak + 1;
    const line = markdownLocal.slice(index, nextLineBreak === -1 ? lineEnd : nextLineBreak);

    if (openFence) {
      if (isFenceClose(line, openFence)) {
        openFence = null;
        boundary = lineEnd;
      }
      index = lineEnd;
      continue;
    }

    const openingFence = getFenceMarker(line);
    if (openingFence) {
      openFence = openingFence;
      index = lineEnd;
      continue;
    }

    if (line.trim() === "") {
      boundary = lineEnd;
    }
    index = lineEnd;
  }

  return boundary;
}

for (const [language, definition, aliases] of [
  ["bash", bash, ["sh", "shell"]],
  ["cpp", cpp, ["c++", "cxx"]],
  ["css", css, []],
  ["diff", diff, ["patch"]],
  ["go", go, ["golang"]],
  ["java", java, []],
  ["javascript", javascript, ["js", "jsx"]],
  ["json", json, []],
  ["markdown", markdown, ["md"]],
  ["python", python, ["py"]],
  ["rust", rust, ["rs"]],
  ["typescript", typescript, ["ts", "tsx"]],
  ["xml", xml, ["html", "svg"]],
  ["yaml", yaml, ["yml"]],
] as const) {
  hljs.registerLanguage(language, definition);
  if (aliases.length > 0) {
    hljs.registerAliases([...aliases], { languageName: language });
  }
}

function normalizeHighlightLanguage(lang: string): string {
  const normalized = lang.trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  const aliases: Record<string, string> = {
    "c++": "cpp",
    cxx: "cpp",
    js: "javascript",
    jsx: "javascript",
    md: "markdown",
    sh: "bash",
    shell: "bash",
    ts: "typescript",
    tsx: "typescript",
  };
  return aliases[normalized] ?? normalized;
}

const autoHighlightLanguages = [
  "bash",
  "cpp",
  "css",
  "diff",
  "go",
  "java",
  "javascript",
  "json",
  "markdown",
  "python",
  "rust",
  "typescript",
  "xml",
  "yaml",
];

function highlightCode(text: string, lang: string): string {
  const language = normalizeHighlightLanguage(lang);
  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    }
    if (!language && text.trim()) {
      const result = hljs.highlightAuto(text, autoHighlightLanguages);
      if (result.relevance >= 2) {
        return result.value;
      }
    }
  } catch {
    // Fall back to escaped plaintext; malformed input should not break chat rendering.
  }
  return escapeHtml(text);
}

function codeClassAttribute(lang: string, highlighted: string): string {
  const classes = [
    highlighted.includes("hljs-") ? "hljs" : "",
    lang ? `language-${lang}` : "",
  ].filter(Boolean);
  return classes.length > 0 ? ` class="${escapeHtml(classes.join(" "))}"` : "";
}

export const md = new MarkdownIt({
  html: true, // Enable HTML recognition so html_block/html_inline overrides can escape it
  breaks: true,
  linkify: true,
});

// Enable GFM strikethrough (~~text~~) to match original marked.js behavior.
// markdown-it uses <s> tags; we added "s" to allowedTags for DOMPurify.
md.enable("strikethrough");

// Disable fuzzy link detection to prevent bare filenames like "README.md"
// from being auto-linked as "http://README.md". URLs with explicit protocol
// (https://...) and emails are still linkified.
//
// Alternative considered: extensions/matrix/src/matrix/format.ts uses fuzzyLink
// with a file-extension blocklist to filter false positives at render time.
// We chose the www-only approach instead because:
// 1. Matches original marked.js GFM behavior exactly (bare domains were never linked)
// 2. No blocklist to maintain — new TLDs like .ai, .io, .dev would need constant updates
// 3. Predictable behavior — users can always use explicit https:// for any URL
md.linkify.set({ fuzzyLink: false });

// Re-enable www. prefix detection per GFM spec: bare URLs without protocol
// must start with "www." to be auto-linked. This avoids false positives on
// filenames while preserving expected behavior for "www.example.com".
// GFM spec: valid domain = alphanumeric/underscore/hyphen segments separated
// by periods, at least one period, no underscores in last two segments.
md.linkify.add("www", {
  validate(text, pos) {
    const tail = text.slice(pos);
    // Match: . followed by domain and optional path, matching marked.js behavior.
    // Stops at whitespace, < (HTML tag boundary), or CJK characters (RFC 3986:
    // raw CJK is not valid in URLs; percent-encoded CJK like %E4%BD%A0 is fine).
    const match = tail.match(
      /^\.(?:[a-zA-Z0-9-]+\.?)+[^\s<\u2E80-\u2FFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF01-\uFF60]*/,
    );
    if (!match) {
      return 0;
    }
    let len = match[0].length;

    // Strip trailing punctuation per GFM extended autolink spec.
    // GFM says: ?, !, ., ,, :, *, _, ~ are not part of the autolink if trailing.

    // Balance checking config: closeChar -> openChar mapping.
    // Strip trailing close chars only when unbalanced (more closes than opens).
    // For self-matching pairs like "", open === close (strip if odd count).
    const balancePairs: Record<string, string> = {
      ")": "(",
      "]": "[",
      "}": "{",
      '"': '"',
      "'": "'",
    };

    // Pre-count balanced pairs to avoid O(n²) rescans.
    // balance[closeChar] = count(open) - count(close), negative means unbalanced
    const balance: Record<string, number> = {};
    for (const [close, open] of Object.entries(balancePairs)) {
      balance[close] = 0;
      for (let i = 0; i < len; i++) {
        const c = tail[i];
        if (open === close) {
          // Self-matching pair (e.g., "") — toggle between 0 and 1
          if (c === open) {
            balance[close] = balance[close] === 0 ? 1 : 0;
          }
        } else if (c === open) {
          // Distinct open/close (e.g., ())
          balance[close]++;
        } else if (c === close) {
          balance[close]--;
        }
      }
    }

    while (len > 0) {
      const ch = tail[len - 1];
      // GFM trailing punctuation: ?, !, ., ,, :, *, _, ~ stripped unconditionally.
      // Semicolon is handled specially below (entity reference rule).
      if (/[?!.,:*_~]/.test(ch)) {
        len--;
        continue;
      }
      // GFM entity reference rule: strip trailing &entity; sequences.
      // Only strip ; when preceded by &<alphanumeric>+ (e.g., &amp; &lt; &hl;).
      if (ch === ";") {
        // Backward scan to find & (O(n) total, avoids string allocation)
        let j = len - 2;
        while (j >= 0 && /[a-zA-Z0-9]/.test(tail[j])) {
          j--;
        }
        // j < len - 2 ensures at least one alphanumeric between & and ;
        if (j >= 0 && tail[j] === "&" && j < len - 2) {
          len = j;
          continue;
        }
        // Not an entity reference, stop stripping
        break;
      }
      // Handle balanced pairs — only strip close char if unbalanced.
      const open = balancePairs[ch];
      if (open !== undefined) {
        if (open === ch) {
          // Self-matching: strip if odd count (unbalanced)
          if (balance[ch] !== 0) {
            balance[ch] = 0;
            len--;
            continue;
          }
        } else if (balance[ch] < 0) {
          // Distinct pair: strip if more closes than opens
          balance[ch]++;
          len--;
          continue;
        }
      }
      break;
    }
    return len;
  },
  normalize(match) {
    match.url = "http://" + match.url;
  },
});

// Override default link validator to allow all URLs through to renderers.
// marked.js does not validate URLs at all — it generates <a>/<img> tags for
// everything and relies on DOMPurify to strip dangerous schemes.
//
// We match this behavior exactly:
// - All URLs pass validation, including javascript:, vbscript:, file:, data:
// - Images: renderer.rules.image shows alt text for non-data-image URLs
// - Links: DOMPurify strips dangerous href schemes, leaving safe anchor text
// - Blocking at validateLink would skip token generation entirely, causing raw
//   markdown source to appear instead of graceful fallbacks.
md.validateLink = () => true;

// Trim trailing CJK characters from auto-linked URLs (RFC 3986: raw CJK is
// not valid in URLs). markdown-it's built-in linkify for https:// URLs may
// swallow adjacent CJK text into the URL. This core rule runs after linkify
// and splits the CJK suffix back into a plain text token.
md.core.ruler.after("linkify", "linkify-cjk-trim", (state) => {
  for (const blockToken of state.tokens) {
    if (blockToken.type !== "inline" || !blockToken.children) {
      continue;
    }
    const children = blockToken.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const token = children[i];
      if (token.type !== "link_open") {
        continue;
      }
      // Only trim linkify-generated autolinks, not explicit markdown links
      // like [OpenClaw中文](https://docs.openclaw.ai) where CJK in display
      // text is intentional and href must not be rewritten.
      if (token.markup !== "linkify") {
        continue;
      }
      // Use the display text to find CJK boundary (href may be percent-encoded)
      const textToken = children[i + 1];
      if (!textToken || textToken.type !== "text") {
        continue;
      }
      const displayText = textToken.content;
      // Scan backward to find trailing CJK suffix only.
      // Middle CJK must be preserved (e.g. https://example.com/你/test stays intact);
      // only strip a contiguous CJK tail adjacent to non-URL text.
      let cjkIdx = displayText.length;
      while (cjkIdx > 0 && CJK_RE.test(displayText[cjkIdx - 1])) {
        cjkIdx--;
      }
      if (cjkIdx <= 0 || cjkIdx === displayText.length) {
        continue;
      }
      // Split: URL part and CJK tail from display text
      const trimmedDisplay = displayText.slice(0, cjkIdx);
      const cjkTail = displayText.slice(cjkIdx);
      // Rebuild href by preserving the scheme prefix that linkify added but
      // display text omits (e.g. "mailto:" for emails, "http://" for www links).
      const href = token.attrGet("href") ?? "";
      const prefixLen = href.indexOf(displayText);
      const hrefPrefix = prefixLen > 0 ? href.slice(0, prefixLen) : "";
      token.attrSet("href", hrefPrefix + trimmedDisplay);
      textToken.content = trimmedDisplay;
      // Find link_close and insert CJK text after it
      for (let j = i + 1; j < children.length; j++) {
        if (children[j].type === "link_close") {
          const tailToken = new state.Token("text", "", 0);
          tailToken.content = cjkTail;
          children.splice(j + 1, 0, tailToken);
          break;
        }
      }
    }
  }
});

// Enable GFM task list checkboxes (- [x] / - [ ]).
// enabled: false keeps checkboxes read-only (disabled="") — task lists in
// chat messages are display-only, not interactive forms.
// label: false avoids wrapping item text in <label>, which would break
// accessibility when the item contains links (MDN warns against anchors inside labels).
md.use(markdownItTaskLists, { enabled: false, label: false });

// Mark the <input> html_inline token inside task-list items as trusted so the
// html_inline override lets it through. With label: false, the plugin generates
// only a single <input ...> token per item.
// We identify task-list items by the class="task-list-item" the plugin sets.
md.core.ruler.after("github-task-lists", "task-list-allowlist", (state) => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    if (tokens[i].type !== "inline" || !tokens[i].children) {
      continue;
    }
    if (tokens[i - 1].type !== "paragraph_open") {
      continue;
    }
    if (tokens[i - 2].type !== "list_item_open") {
      continue;
    }
    const listItem = tokens[i - 2];
    const cls = listItem.attrGet("class") ?? "";
    if (!cls.includes("task-list-item")) {
      continue;
    }
    // Only trust the checkbox <input> token from the plugin, not other user-supplied HTML.
    // The plugin inserts an <input> at the start; user HTML elsewhere must stay escaped.
    for (const child of tokens[i].children!) {
      if (child.type === "html_inline" && /^<input\s/i.test(child.content)) {
        child.meta = { taskListPlugin: true };
        break; // Only one checkbox per item
      }
    }
  }
});

// Override html_block and html_inline to escape raw HTML (#13937).
// Exception: html_inline tokens marked by a trusted plugin (meta.taskListPlugin)
// are allowed through — they are generated by our own plugin pipeline, not user input,
// and DOMPurify provides the final safety net regardless.
md.renderer.rules.html_block = (tokens, idx) => {
  return escapeHtml(tokens[idx].content) + "\n";
};
md.renderer.rules.html_inline = (tokens, idx) => {
  const token = tokens[idx];
  if (token.meta?.taskListPlugin === true) {
    return token.content;
  }
  return escapeHtml(token.content);
};

// Override image to only allow base64 data URIs (#15437)
md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx];
  const src = token.attrGet("src")?.trim() ?? "";
  // Use token.content which preserves raw markdown formatting (e.g. **bold**)
  // to match original marked.js behavior.
  const alt = normalizeMarkdownImageLabel(token.content);
  if (!INLINE_DATA_IMAGE_RE.test(src)) {
    return escapeHtml(alt);
  }
  return `<img class="markdown-inline-image" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`;
};

// Override fenced code blocks with copy button + JSON collapse
md.renderer.rules.fence = (tokens, idx, _options, env) => {
  const token = tokens[idx];
  // token.info contains the full fence info string (e.g., "json title=foo");
  // extract only the first whitespace-separated token as the language.
  const lang = token.info.trim().split(/\s+/)[0] || "";
  const text = token.content;
  const highlighted = highlightCode(text, lang);
  const classAttr = codeClassAttribute(lang, highlighted);
  const codeBlock = `<pre><code${classAttr}>${highlighted}</code></pre>`;
  if (!shouldRenderCodeBlockCopy(env)) {
    return codeBlock;
  }
  const langLabel = lang ? `<span class="code-block-lang">${escapeHtml(lang)}</span>` : "";
  const attrSafe = escapeHtml(text);
  const copyBtn = `<button type="button" class="code-block-copy" data-code="${attrSafe}" aria-label="${escapeHtml(t("common.copyCode"))}"><span class="code-block-copy__idle">${escapeHtml(t("common.copy"))}</span><span class="code-block-copy__done">${escapeHtml(t("common.copied"))}</span></button>`;
  const header = `<div class="code-block-header">${langLabel}${copyBtn}</div>`;

  const trimmed = text.trim();
  const isJson =
    lang === "json" ||
    (!lang &&
      ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))));

  if (isJson) {
    const lineCount = text.split("\n").length;
    const label = lineCount > 1 ? `JSON &middot; ${lineCount} lines` : "JSON";
    return `<details class="json-collapse"><summary>${label}</summary><div class="code-block-wrapper">${header}${codeBlock}</div></details>`;
  }

  return `<div class="code-block-wrapper">${header}${codeBlock}</div>`;
};

// Override indented code blocks (code_block) with the same treatment as fence
md.renderer.rules.code_block = (tokens, idx, _options, env) => {
  const token = tokens[idx];
  const text = token.content;
  const highlighted = highlightCode(text, "");
  const classAttr = codeClassAttribute("", highlighted);
  const codeBlock = `<pre><code${classAttr}>${highlighted}</code></pre>`;
  if (!shouldRenderCodeBlockCopy(env)) {
    return codeBlock;
  }
  const attrSafe = escapeHtml(text);
  const copyBtn = `<button type="button" class="code-block-copy" data-code="${attrSafe}" aria-label="${escapeHtml(t("common.copyCode"))}"><span class="code-block-copy__idle">${escapeHtml(t("common.copy"))}</span><span class="code-block-copy__done">${escapeHtml(t("common.copied"))}</span></button>`;
  const header = `<div class="code-block-header">${copyBtn}</div>`;

  const trimmed = text.trim();
  const isJson =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));

  if (isJson) {
    const lineCount = text.split("\n").length;
    const label = lineCount > 1 ? `JSON &middot; ${lineCount} lines` : "JSON";
    return `<details class="json-collapse"><summary>${label}</summary><div class="code-block-wrapper">${header}${codeBlock}</div></details>`;
  }

  return `<div class="code-block-wrapper">${header}${codeBlock}</div>`;
};

export function toSanitizedMarkdownHtml(
  markdownLocal: string,
  options: MarkdownRenderOptions = {},
): string {
  const renderOptions = normalizeMarkdownRenderOptions(options);
  const input = stripUnsupportedCitationControlMarkers(markdownLocal).trim();
  if (!input) {
    return "";
  }
  installHooks();
  const cacheKey = `${i18n.getLocale()}\0${renderOptions.codeBlockChrome}\0${input}`;
  if (input.length <= MARKDOWN_CACHE_MAX_CHARS) {
    const cached = getCachedMarkdown(cacheKey);
    if (cached !== null) {
      return cached;
    }
  }
  const truncated = truncateText(input, MARKDOWN_CHAR_LIMIT);
  const suffix = truncated.truncated
    ? `\n\n… truncated (${truncated.total} chars, showing first ${truncated.text.length}).`
    : "";
  if (truncated.text.length > MARKDOWN_PARSE_LIMIT) {
    // Large plain-text replies should stay readable without inheriting the
    // capped code-block chrome, while still preserving whitespace for logs
    // and other structured text that commonly trips the parse guard.
    const html = toEscapedPlainTextHtml(`${truncated.text}${suffix}`);
    const sanitized = DOMPurify.sanitize(html, sanitizeOptions);
    if (input.length <= MARKDOWN_CACHE_MAX_CHARS) {
      setCachedMarkdown(cacheKey, sanitized);
    }
    return sanitized;
  }
  let rendered: string;
  try {
    rendered = md.render(`${truncated.text}${suffix}`, renderOptions);
  } catch (err) {
    // Fall back to escaped plain text when md.render() throws (#36213).
    console.warn("[markdown] md.render failed, falling back to plain text:", err);
    const escaped = escapeHtml(`${truncated.text}${suffix}`);
    rendered = `<pre class="code-block">${escaped}</pre>`;
  }
  const sanitized = DOMPurify.sanitize(rendered, sanitizeOptions);
  if (input.length <= MARKDOWN_CACHE_MAX_CHARS) {
    setCachedMarkdown(cacheKey, sanitized);
  }
  return sanitized;
}

export function toEscapedPlainTextHtml(value: string): string {
  return `<div class="markdown-plain-text-fallback">${escapeHtml(value.replace(/\r\n?/g, "\n"))}</div>`;
}

export function toStreamingPlainTextHtml(markdownLocal: string): string {
  const input = normalizeMarkdownInput(markdownLocal);
  if (!input) {
    return "";
  }
  return toEscapedPlainTextHtml(input);
}

export function toStreamingMarkdownHtml(
  markdownLocal: string,
  options: MarkdownRenderOptions = {},
): string {
  const input = normalizeMarkdownInput(markdownLocal);
  if (!input) {
    return "";
  }

  const boundary = findStableStreamingMarkdownBoundary(input);
  if (boundary <= 0) {
    return toEscapedPlainTextHtml(input);
  }

  const stableMarkdown = input.slice(0, boundary);
  const streamingTail = input.slice(boundary);
  const stableHtml = toSanitizedMarkdownHtml(stableMarkdown, options);
  if (!streamingTail.trim()) {
    return stableHtml;
  }
  return `${stableHtml}${toEscapedPlainTextHtml(streamingTail)}`;
}
