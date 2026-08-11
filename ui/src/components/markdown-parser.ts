import MarkdownIt from "markdown-it";
import markdownItTaskLists from "markdown-it-task-lists";
import type Token from "markdown-it/lib/token.mjs";
import { t } from "../i18n/index.ts";
import { fileKindForPath, shortestFileLabels } from "./file-kind.ts";
import {
  installAssistantTranscriptRoleImageRenderer,
  installAssistantTranscriptRoleMarkdown,
} from "./markdown-assistant-transcript.ts";
import { markdownCodeBlockCopyText, renderMarkdownCodeBlock } from "./markdown-code-blocks.ts";
import { installMarkdownDetails } from "./markdown-details.ts";
import {
  isHostLocalMarkdownFileHref,
  MARKDOWN_FILE_LINK_SCAN_RE,
  parseMarkdownFileLinkTarget,
  splitMarkdownFileLineSuffix,
} from "./markdown-file-links.ts";
import type { MarkdownRenderEnv } from "./markdown-render-options.ts";
import { escapeMarkdownHtml } from "./markdown-text.ts";

const INLINE_DATA_IMAGE_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;
// CJK character ranges for URL boundary detection (RFC 3986: CJK is not valid in raw URLs).
// CJK Unified Ideographs, CJK Symbols/Punctuation, Fullwidth Forms, Hiragana, Katakana,
// Hangul Syllables, and CJK Compatibility Ideographs.
const CJK_RE = new RegExp(
  "[\\u2E80-\\u2FFF\\u3000-\\u303F\\u3040-\\u309F\\u30A0-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF\\uFF01-\\uFF60]",
);

// Anchors carrying this class get the decorative GitHub mark painted by CSS
// (styles/chat/text.css). The mark is never emitted as markup so it stays out
// of the accessibility tree and out of copied text.
const GITHUB_LINK_CLASS = "markdown-github-link";
// Marks anchors whose visible text is the URL itself, which CSS may break at
// any character. Authored labels keep normal word wrapping.
const BARE_URL_CLASS = "markdown-bare-url";

// Inline-code file links are rendered by the code_inline rule, which runs after
// every core rule. The core rule therefore parks the resolved target here so the
// renderer never re-parses a path the core rule already classified.
type MarkdownFileLinkMeta = {
  path: string;
  line: number | null;
  // Full original reference, set only when the visible label was shortened.
  title: string | null;
};

// Shortening a label needs every file link in the message, so the core rule
// collects targets first and applies labels in a second pass.
type MarkdownFileLinkDecoration = {
  path: string;
  reference: string;
  applyLabel: (label: string) => void;
};

/** Visible text of the link opened at `openIndex`, used to tell an authored
 *  label apart from one that merely repeats the reference. */
function linkLabelText(children: readonly Token[], openIndex: number): string {
  let label = "";
  for (let cursor = openIndex + 1; cursor < children.length; cursor++) {
    const token = children[cursor];
    if (!token || token.type === "link_close") {
      break;
    }
    if (token.type === "text" || token.type === "code_inline") {
      label += token.content;
    }
  }
  return label.trim();
}

function normalizeMarkdownImageLabel(text?: string | null): string {
  const trimmed = text?.trim();
  return trimmed ? trimmed : "image";
}

function parseWebLinkHref(href: string): URL | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    // Relative and malformed hrefs are not web destinations at this stage; the
    // docs shortlink rewrite in markdown.ts runs later and only targets docs.
    return null;
  }
  return url.protocol === "https:" || url.protocol === "http:" ? url : null;
}

function isFileLinkBoundaryBefore(value: string, index: number): boolean {
  const char = value[index - 1];
  return char === undefined || /\s/.test(char) || "([{<\"'`".includes(char);
}

function isFileLinkBoundaryAfter(value: string, index: number): boolean {
  const char = value[index];
  return char === undefined || /\s/.test(char) || ".,;:!?)]}>\"'".includes(char);
}

export function createMarkdownParser(): MarkdownIt {
  const markdownParser = new MarkdownIt({
    html: true, // Enable HTML recognition so html_block/html_inline overrides can escape it
    breaks: true,
    linkify: true,
  });
  const defaultCodeInlineRenderer = markdownParser.renderer.rules.code_inline!;

  // Enable GFM strikethrough (~~text~~) to match original marked.js behavior.
  // markdown-it uses <s> tags; we added "s" to the sanitizer allowlist.
  markdownParser.enable("strikethrough");
  installAssistantTranscriptRoleMarkdown(markdownParser, escapeMarkdownHtml);
  installMarkdownDetails(markdownParser);

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
  markdownParser.linkify.set({ fuzzyLink: false });

  // Re-enable www. prefix detection per GFM spec: bare URLs without protocol
  // must start with "www." to be auto-linked. This avoids false positives on
  // filenames while preserving expected behavior for "www.example.com".
  // GFM spec: valid domain = alphanumeric/underscore/hyphen segments separated
  // by periods, at least one period, no underscores in last two segments.
  markdownParser.linkify.add("www", {
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
      let length = match[0].length;

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
        for (let index = 0; index < length; index++) {
          const character = tail.charAt(index);
          if (open === close) {
            // Self-matching pair (e.g., "") — toggle between 0 and 1
            if (character === open) {
              balance[close] = balance[close] === 0 ? 1 : 0;
            }
          } else if (character === open) {
            balance[close] = (balance[close] ?? 0) + 1;
          } else if (character === close) {
            balance[close] = (balance[close] ?? 0) - 1;
          }
        }
      }

      while (length > 0) {
        const character = tail.charAt(length - 1);
        // GFM trailing punctuation: ?, !, ., ,, :, *, _, ~ stripped unconditionally.
        if (/[?!.,:*_~]/.test(character)) {
          length--;
          continue;
        }
        // GFM entity reference rule: strip trailing &entity; sequences.
        if (character === ";") {
          // Backward scan to find & (O(n) total, avoids string allocation)
          let index = length - 2;
          while (index >= 0 && /[a-zA-Z0-9]/.test(tail.charAt(index))) {
            index--;
          }
          // index < length - 2 ensures at least one alphanumeric between & and ;
          if (index >= 0 && tail.charAt(index) === "&" && index < length - 2) {
            length = index;
            continue;
          }
          // Not an entity reference, stop stripping
          break;
        }
        // Handle balanced pairs — only strip close char if unbalanced.
        const open = balancePairs[character];
        if (open !== undefined) {
          if (open === character) {
            if ((balance[character] ?? 0) !== 0) {
              balance[character] = 0;
              length--;
              continue;
            }
          } else if ((balance[character] ?? 0) < 0) {
            balance[character] = (balance[character] ?? 0) + 1;
            length--;
            continue;
          }
        }
        break;
      }
      return length;
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
  markdownParser.validateLink = () => true;

  // Trim trailing CJK characters from auto-linked URLs (RFC 3986: raw CJK is
  // not valid in URLs). markdown-it's built-in linkify for https:// URLs may
  // swallow adjacent CJK text into the URL. This core rule runs after linkify
  // and splits the CJK suffix back into a plain text token.
  markdownParser.core.ruler.after("linkify", "linkify-cjk-trim", (state) => {
    for (const blockToken of state.tokens) {
      if (blockToken.type !== "inline" || !blockToken.children) {
        continue;
      }
      const children = blockToken.children;
      for (let index = children.length - 1; index >= 0; index--) {
        const token = children[index];
        if (!token || token.type !== "link_open") {
          continue;
        }
        // Only trim linkify-generated autolinks, not explicit markdown links
        // like [OpenClaw中文](https://docs.openclaw.ai) where CJK in display
        // text is intentional and href must not be rewritten.
        if (token.markup !== "linkify") {
          continue;
        }
        // Use the display text to find CJK boundary (href may be percent-encoded)
        const textToken = children[index + 1];
        if (!textToken || textToken.type !== "text") {
          continue;
        }
        const displayText = textToken.content;
        // Scan backward to find trailing CJK suffix only.
        // Middle CJK must be preserved (e.g. https://example.com/你/test stays intact);
        // only strip a contiguous CJK tail adjacent to non-URL text.
        let cjkIndex = displayText.length;
        while (cjkIndex > 0 && CJK_RE.test(displayText.charAt(cjkIndex - 1))) {
          cjkIndex--;
        }
        if (cjkIndex <= 0 || cjkIndex === displayText.length) {
          continue;
        }
        // Split: URL part and CJK tail from display text
        const trimmedDisplay = displayText.slice(0, cjkIndex);
        const cjkTail = displayText.slice(cjkIndex);
        // Rebuild href by preserving the scheme prefix that linkify added but
        // display text omits (e.g. "mailto:" for emails, "http://" for www links).
        const href = token.attrGet("href") ?? "";
        const prefixLength = href.indexOf(displayText);
        const hrefPrefix = prefixLength > 0 ? href.slice(0, prefixLength) : "";
        token.attrSet("href", hrefPrefix + trimmedDisplay);
        textToken.content = trimmedDisplay;
        // Find link_close and insert CJK text after it
        for (let closeIndex = index + 1; closeIndex < children.length; closeIndex++) {
          if (children[closeIndex]?.type === "link_close") {
            const tailToken = new state.Token("text", "", 0);
            tailToken.content = cjkTail;
            children.splice(closeIndex + 1, 0, tailToken);
            break;
          }
        }
      }
    }
  });

  markdownParser.core.ruler.after("linkify", "file-links", (state) => {
    const env = state.env as Partial<MarkdownRenderEnv> | undefined;
    if (env?.fileLinks !== true) {
      return;
    }
    const decorations: MarkdownFileLinkDecoration[] = [];
    for (const blockToken of state.tokens) {
      if (blockToken.type !== "inline" || !blockToken.children) {
        continue;
      }
      const children = blockToken.children;
      let linkDepth = 0;
      for (let index = 0; index < children.length; index++) {
        const token = children[index];
        if (!token) {
          continue;
        }
        if (token.type === "link_open") {
          const href = token.attrGet("href");
          if (href) {
            let decodedHref = href;
            try {
              decodedHref = decodeURIComponent(href);
            } catch {
              // Keep the raw href when malformed percent escapes cannot be decoded.
            }
            if (!decodedHref.includes("://")) {
              const target =
                parseMarkdownFileLinkTarget(decodedHref) ??
                (isHostLocalMarkdownFileHref(decodedHref)
                  ? splitMarkdownFileLineSuffix(decodedHref.trim())
                  : null);
              if (target) {
                token.attrs = token.attrs?.filter(([name]) => name !== "href") ?? null;
                token.attrJoin("class", "markdown-file-link");
                token.attrSet("role", "button");
                token.attrSet("tabindex", "0");
                token.attrSet("data-file-path", target.path);
                token.attrSet("data-file-kind", fileKindForPath(target.path));
                if (target.line !== null) {
                  token.attrSet("data-file-line", String(target.line));
                }
                // The author wrote this label, so it is never rewritten; the
                // tooltip is the only place the reference behind it survives —
                // and it is skipped when the label already is that reference,
                // matching the shortened links below.
                const reference = decodedHref.trim();
                if (linkLabelText(children, index) !== reference) {
                  token.attrSet("title", reference);
                }
              }
            }
          }
          linkDepth += 1;
          continue;
        }
        if (token.type === "link_close") {
          linkDepth = Math.max(0, linkDepth - 1);
          continue;
        }
        if (linkDepth > 0) {
          continue;
        }
        if (token.type === "code_inline") {
          const target = parseMarkdownFileLinkTarget(token.content);
          if (target) {
            const reference = token.content.trim();
            const meta: MarkdownFileLinkMeta = {
              path: target.path,
              line: target.line,
              title: null,
            };
            token.meta = { ...token.meta, fileLink: meta };
            decorations.push({
              path: target.path,
              reference,
              applyLabel: (label) => {
                token.content = label;
                meta.title = label === reference ? null : reference;
              },
            });
          }
          continue;
        }
        if (token.type !== "text") {
          continue;
        }

        const replacements: typeof children = [];
        let cursor = 0;
        MARKDOWN_FILE_LINK_SCAN_RE.lastIndex = 0;
        for (const match of token.content.matchAll(MARKDOWN_FILE_LINK_SCAN_RE)) {
          const matchIndex = match.index;
          const matched = match[0];
          const matchEnd = matchIndex + matched.length;
          if (
            !isFileLinkBoundaryBefore(token.content, matchIndex) ||
            !isFileLinkBoundaryAfter(token.content, matchEnd)
          ) {
            continue;
          }
          const target = parseMarkdownFileLinkTarget(matched);
          if (!target) {
            continue;
          }
          if (matchIndex > cursor) {
            const leading = new state.Token("text", "", 0);
            leading.content = token.content.slice(cursor, matchIndex);
            replacements.push(leading);
          }
          const open = new state.Token("link_open", "a", 1);
          open.markup = "file-link";
          open.attrSet("class", "markdown-file-link");
          open.attrSet("role", "button");
          open.attrSet("tabindex", "0");
          open.attrSet("data-file-path", target.path);
          open.attrSet("data-file-kind", fileKindForPath(target.path));
          if (target.line !== null) {
            open.attrSet("data-file-line", String(target.line));
          }
          const label = new state.Token("text", "", 0);
          label.content = matched;
          const close = new state.Token("link_close", "a", -1);
          close.markup = "file-link";
          replacements.push(open, label, close);
          decorations.push({
            path: target.path,
            reference: matched,
            applyLabel: (text) => {
              label.content = text;
              if (text !== matched) {
                open.attrSet("title", matched);
              }
            },
          });
          cursor = matchEnd;
        }
        if (replacements.length === 0) {
          continue;
        }
        if (cursor < token.content.length) {
          const trailing = new state.Token("text", "", 0);
          trailing.content = token.content.slice(cursor);
          replacements.push(trailing);
        }
        children.splice(index, 1, ...replacements);
        index += replacements.length - 1;
      }
    }
    // A path carries far more characters than identity: the basename is what a
    // reader scans for, and the glyph already says "workspace file". Paths that
    // share a basename keep just enough trailing segments to stay distinct.
    const labels = shortestFileLabels(decorations.map((decoration) => decoration.path));
    for (const decoration of decorations) {
      const label = labels.get(decoration.path) ?? decoration.path;
      // Line suffixes (":42") are part of the reference, not the path, and stay
      // on the visible label because they are what makes the link specific.
      decoration.applyLabel(label + decoration.reference.slice(decoration.path.length));
    }
  });

  // Classify web anchors for presentation; runs after linkify so bare URLs are
  // already anchors. The GitHub mark skips links whose only content is an image
  // (badges/shields), where a mark beside a mark reads as noise. Code spans and
  // fences need no exclusion: markdown-it does not linkify inside them.
  markdownParser.core.ruler.after("linkify", "web-link-classes", (state) => {
    for (const blockToken of state.tokens) {
      if (blockToken.type !== "inline" || !blockToken.children) {
        continue;
      }
      const children = blockToken.children;
      for (let index = 0; index < children.length; index++) {
        const open = children[index];
        if (open?.type !== "link_open") {
          continue;
        }
        const href = open.attrGet("href");
        const url = href ? parseWebLinkHref(href) : null;
        if (!url) {
          continue;
        }
        if (open.markup === "linkify" || open.markup === "autolink") {
          open.attrJoin("class", BARE_URL_CLASS);
        }
        const host = url.hostname.toLowerCase();
        if (host !== "github.com" && host !== "www.github.com") {
          continue;
        }
        for (let cursor = index + 1; cursor < children.length; cursor++) {
          const token = children[cursor];
          if (!token || token.type === "link_close") {
            break;
          }
          if (
            (token.type === "text" || token.type === "code_inline") &&
            token.content.trim() !== ""
          ) {
            open.attrJoin("class", GITHUB_LINK_CLASS);
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
  markdownParser.use(markdownItTaskLists, { enabled: false, label: false });

  // The plugin inserts its checkbox as the first inline child. Trust only that
  // generated token so later user-authored HTML remains escaped.
  markdownParser.core.ruler.after("github-task-lists", "task-list-allowlist", (state) => {
    for (const [index, listItem] of state.tokens.entries()) {
      if (listItem.type !== "list_item_open" || listItem.attrGet("class") !== "task-list-item") {
        continue;
      }
      const checkbox = state.tokens[index + 2]?.children?.[0];
      if (checkbox?.type === "html_inline") {
        checkbox.meta = { taskListPlugin: true };
      }
    }
  });

  // Override html_block and html_inline to escape raw HTML (#13937).
  // Exception: html_inline tokens marked by a trusted plugin (meta.taskListPlugin)
  // are allowed through — they are generated by our own plugin pipeline, not user input,
  // and DOMPurify provides the final safety net regardless.
  // Renderer rules degrade to empty output on impossible token misses instead of
  // throwing mid-render; markdown input is untrusted and the chat view must not crash.
  markdownParser.renderer.rules.html_block = (tokens, index) => {
    const token = tokens[index];
    return token ? escapeMarkdownHtml(token.content) + "\n" : "";
  };
  markdownParser.renderer.rules.html_inline = (tokens, index) => {
    const token = tokens[index];
    return token?.meta?.taskListPlugin === true
      ? token.content
      : escapeMarkdownHtml(token?.content ?? "");
  };
  markdownParser.renderer.rules.code_inline = (tokens, index, options, env, self) => {
    const rendered = defaultCodeInlineRenderer(tokens, index, options, env, self);
    const target = tokens[index]?.meta?.fileLink as MarkdownFileLinkMeta | undefined;
    if (!target) {
      return rendered;
    }
    const lineAttribute =
      target.line === null ? "" : ` data-file-line="${escapeMarkdownHtml(String(target.line))}"`;
    const titleAttribute =
      target.title === null ? "" : ` title="${escapeMarkdownHtml(target.title)}"`;
    return `<a class="markdown-file-link" role="button" tabindex="0" data-file-path="${escapeMarkdownHtml(target.path)}" data-file-kind="${fileKindForPath(target.path)}"${lineAttribute}${titleAttribute}>${rendered}</a>`;
  };

  // Message rendering allows only inline data images (#15437). Document
  // previews preserve authored image URLs and rely on DOMPurify's URI policy.
  installAssistantTranscriptRoleImageRenderer(markdownParser, {
    escapeHtml: escapeMarkdownHtml,
    isInlineDataImage: (src) => INLINE_DATA_IMAGE_RE.test(src),
    normalizeLabel: normalizeMarkdownImageLabel,
    assistantLabel: () => t("sessionsView.assistant"),
    openImageLabel: (alt, hasAlt) =>
      t("chat.imageLightbox.open", {
        title: hasAlt ? alt : t("chat.imageLightbox.untitled"),
      }),
    interactiveImages: (env) =>
      (env as Partial<MarkdownRenderEnv> | undefined)?.interactiveImages === true,
    allowRemoteImages: (env) =>
      (env as Partial<MarkdownRenderEnv> | undefined)?.mode === "document",
  });

  // Override fenced code blocks with copy button + JSON collapse
  markdownParser.renderer.rules.fence = (tokens, index, _options, env) => {
    const token = tokens[index];
    if (!token) {
      return "";
    }
    // token.info contains the full fence info string (e.g., "json title=foo");
    // extract only the first whitespace-separated token as the language.
    const language = token.info.trim().split(/\s+/)[0] || "";
    return renderMarkdownCodeBlock(token.content, language, env, {
      copyText: markdownCodeBlockCopyText(token.content),
    });
  };
  // Override indented code blocks (code_block) with the same treatment as fence
  markdownParser.renderer.rules.code_block = (tokens, index, _options, env) => {
    const content = tokens[index]?.content;
    if (content === undefined) {
      return "";
    }
    return renderMarkdownCodeBlock(content, "", env, {
      copyText: markdownCodeBlockCopyText(content),
    });
  };

  return markdownParser;
}
