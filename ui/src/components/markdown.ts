// Control UI module implements markdown behavior.
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
import remend, { type RemendOptions } from "remend";
import { stripUnsupportedCitationControlMarkers } from "../../../src/shared/text/citation-control-markers.js";
import { routeIdFromPath } from "../app-route-paths.ts";
import { resolveControlUiBasePath } from "../app/browser.ts";
import { i18n, t } from "../i18n/index.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { truncateText } from "../lib/format.ts";
import { normalizeLowercaseStringOrEmpty } from "../lib/string-coerce.ts";

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
  "data-code-encoding",
  "data-file-line",
  "data-file-path",
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
const BLOCK_ART_LINE_RE = /^[\t \u00a0▀▄█]+$/u;
const BLOCK_ART_GLYPH_RE = /[▀▄█]/u;
const blockArtCopyPayloadPrefix = "openclaw:block-art-code:";
const blockArtCodeBlockCopyPayloadEncoding = "block-art-json";
const HOST_LOCAL_FILE_HREF_RE =
  /^(?:~\/|\/(?:Users|home|tmp|private\/tmp|var\/folders|private\/var\/folders)\/|\/[A-Za-z]:\/|[A-Za-z]:[\\/])/;
const FILE_SEGMENT_SOURCE = "[A-Za-z0-9_.@#+-]+";
const FILE_EXTENSION_SOURCE = "[A-Za-z0-9]{1,8}";
const FILE_LINE_SUFFIX_SOURCE = ":\\d{1,6}(?::\\d{1,6})?";
const FILE_NAME_SOURCE = `${FILE_SEGMENT_SOURCE}\\.${FILE_EXTENSION_SOURCE}`;
const PREFIXED_FILE_SOURCE = `(?:~\\/|\\.\\.\\/|\\.\\/|\\/)(?:${FILE_SEGMENT_SOURCE}\\/)*${FILE_NAME_SOURCE}`;
const UNPREFIXED_FILE_SOURCE = `${FILE_SEGMENT_SOURCE}(?:\\/${FILE_SEGMENT_SOURCE})*\\/${FILE_NAME_SOURCE}`;
const WINDOWS_ABSOLUTE_FILE_SOURCE = `[A-Za-z]:[\\\\/](?:${FILE_SEGMENT_SOURCE}[\\\\/])*${FILE_NAME_SOURCE}`;
const MULTI_SEGMENT_FILE_SOURCE = `(?:${PREFIXED_FILE_SOURCE}|${WINDOWS_ABSOLUTE_FILE_SOURCE}|${UNPREFIXED_FILE_SOURCE})(?:${FILE_LINE_SUFFIX_SOURCE})?`;
const BARE_FILE_WITH_LINE_SOURCE = `${FILE_SEGMENT_SOURCE}\\.${FILE_EXTENSION_SOURCE}${FILE_LINE_SUFFIX_SOURCE}`;
const MULTI_SEGMENT_FILE_RE = new RegExp(`^${MULTI_SEGMENT_FILE_SOURCE}$`);
const BARE_FILE_WITH_LINE_RE = new RegExp(`^${BARE_FILE_WITH_LINE_SOURCE}$`);
const BARE_FILENAME_RE = new RegExp(`^${FILE_SEGMENT_SOURCE}\\.(${FILE_EXTENSION_SOURCE})$`, "i");
const FILE_LINK_SCAN_RE = new RegExp(
  `${MULTI_SEGMENT_FILE_SOURCE}|${BARE_FILE_WITH_LINE_SOURCE}`,
  "g",
);
const FILE_LINE_SUFFIX_RE = /:(\d{1,6})(?::\d{1,6})?$/;
const BARE_FILE_EXTENSIONS = new Set([
  "astro",
  "bash",
  "c",
  "cc",
  "cfg",
  "cjs",
  "conf",
  "cpp",
  "cs",
  "css",
  "diff",
  "fish",
  "go",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsonc",
  "jsx",
  "kt",
  "kts",
  "less",
  "lock",
  "log",
  "markdown",
  "md",
  "mdx",
  "mjs",
  "patch",
  "plist",
  "proto",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svelte",
  "svg",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);
const DOCS_ORIGIN = "https://docs.openclaw.ai";
const DOCS_ROOT_SEGMENTS = new Set([
  "agent-runtime-architecture",
  "announcements",
  "auth-credential-semantics",
  "automation",
  "brave-search",
  "channels",
  "ci",
  "clawhub",
  "cli",
  "concepts",
  "date-time",
  "debug",
  "diagnostics",
  "gateway",
  "help",
  "index",
  "install",
  "logging",
  "maturity-scorecard",
  "network",
  "nodes",
  "openclaw-agent-runtime",
  "perplexity",
  "plan",
  "platforms",
  "plugins",
  "prose",
  "providers",
  "refactor",
  "reference",
  "security",
  "specs",
  "start",
  "tools",
  "tts",
  "vps",
  "web",
]);
const DOCS_SHORTLINK_PATHS = new Set([
  "/AGENTS.default",
  "/RELEASING",
  "/agent",
  "/agent-loop",
  "/agent-send",
  "/agent-workspace",
  "/android",
  "/anthropic",
  "/architecture",
  "/audio",
  "/auth-monitoring",
  "/azure",
  "/background-process",
  "/bash",
  "/bonjour",
  "/browser",
  "/browser-linux-troubleshooting",
  "/bun",
  "/camera",
  "/clawd",
  "/clawdhub",
  "/compaction",
  "/configuration",
  "/context",
  "/context-engine",
  "/control-ui",
  "/cron",
  "/cron-jobs",
  "/cron-vs-heartbeat",
  "/dashboard",
  "/device-models",
  "/discord",
  "/discovery",
  "/docker",
  "/doctor",
  "/duckduckgo-search",
  "/elevated",
  "/exa-search",
  "/experiments/plans/cron-add-hardening",
  "/experiments/plans/group-policy-hardening",
  "/faq",
  "/gateway-lock",
  "/gcp",
  "/gemini-search",
  "/getting-started",
  "/glm",
  "/gmail-pubsub",
  "/grammy",
  "/grok-search",
  "/group-messages",
  "/groups",
  "/health",
  "/heartbeat",
  "/hubs",
  "/images",
  "/imessage",
  "/ios",
  "/kimi-search",
  "/line",
  "/linux",
  "/location",
  "/location-command",
  "/lore",
  "/mac/bun",
  "/mac/canvas",
  "/mac/child-process",
  "/mac/dev-setup",
  "/mac/health",
  "/mac/icon",
  "/mac/logging",
  "/mac/menu-bar",
  "/mac/peekaboo",
  "/mac/permissions",
  "/mac/release",
  "/mac/remote",
  "/mac/signing",
  "/mac/skills",
  "/mac/voice-overlay",
  "/mac/voicewake",
  "/mac/webchat",
  "/mac/xpc",
  "/macos",
  "/mattermost",
  "/mcp",
  "/message",
  "/messages",
  "/minimax",
  "/mistral",
  "/model",
  "/model-failover",
  "/models",
  "/moonshot",
  "/multi-agent",
  "/nix",
  "/northflank",
  "/oauth",
  "/onboarding",
  "/openai",
  "/opencode",
  "/opencode-go",
  "/openrouter",
  "/pairing",
  "/pi",
  "/pi-dev",
  "/plugin",
  "/podman",
  "/poll",
  "/presence",
  "/provider-routing",
  "/qianfan",
  "/queue",
  "/quickstart",
  "/railway",
  "/remote",
  "/remote-gateway-readme",
  "/render",
  "/rpc",
  "/sandbox",
  "/sandboxing",
  "/session",
  "/session-tool",
  "/sessions",
  "/setup",
  "/showcase",
  "/signal",
  "/skill-workshop",
  "/skills",
  "/skills-config",
  "/slack",
  "/slash-commands",
  "/subagents",
  "/tailscale",
  "/talk",
  "/telegram",
  "/templates/AGENTS",
  "/templates/BOOT",
  "/templates/BOOTSTRAP",
  "/templates/HEARTBEAT",
  "/templates/IDENTITY",
  "/templates/SOUL",
  "/templates/TOOLS",
  "/templates/USER",
  "/test",
  "/thinking",
  "/timezone",
  "/troubleshooting",
  "/tui",
  "/typebox",
  "/updating",
  "/voicewake",
  "/web-fetch",
  "/webchat",
  "/webhook",
  "/whatsapp",
  "/windows",
  "/wizard",
  "/xiaomi",
  "/zai",
]);
const APP_RESOURCE_ROOT_SEGMENTS = new Set([
  "__openclaw",
  "__openclaw__",
  "_next",
  "api",
  "apple-touch-icon.png",
  "assets",
  "avatar",
  "favicon-32.png",
  "favicon.ico",
  "favicon.svg",
  "manifest.json",
  "manifest.webmanifest",
  "media",
  "res",
  "socket.io",
  "sw.js",
  "static",
  "ws",
]);
const APP_RESOURCE_PATH_PREFIXES = [
  ["plugins", "diffs"],
  ["plugins", "diffs-language-pack"],
];
const markdownCache = new Map<string, string>();
const TAIL_LINK_BLUR_CLASS = "chat-link-tail-blur";
const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const FENCE_CONTAINER_PREFIX_RE = /^[ \t]{0,3}(?:(?:>\s?)|(?:(?:[-+*]|\d{1,9}[.)])[ \t]+))/;

type MarkdownCodeBlockChrome = "copy" | "none";

export type MarkdownRenderOptions = {
  codeBlockChrome?: MarkdownCodeBlockChrome;
  fileLinks?: boolean;
};

type MarkdownRenderEnv = {
  codeBlockChrome: MarkdownCodeBlockChrome;
  fileLinks: boolean;
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
    fileLinks: options.fileLinks ?? false,
  };
}

function shouldRenderCodeBlockCopy(env: unknown): boolean {
  return (env as Partial<MarkdownRenderEnv> | undefined)?.codeBlockChrome !== "none";
}

function encodeBlockArtCodeBlockCopyPayload(value: string): string {
  return `${blockArtCopyPayloadPrefix}${JSON.stringify(value)}`;
}

function decodeCodeBlockCopyPayload(value: string, encoding?: string): string {
  if (
    encoding !== blockArtCodeBlockCopyPayloadEncoding ||
    !value.startsWith(blockArtCopyPayloadPrefix)
  ) {
    return value;
  }
  try {
    const decoded = JSON.parse(value.slice(blockArtCopyPayloadPrefix.length));
    return typeof decoded === "string" ? decoded : value;
  } catch {
    return value;
  }
}

export function handleMarkdownCodeBlockCopy(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const button = target.closest<HTMLElement>(".code-block-copy");
  if (!button) {
    return;
  }
  const code = decodeCodeBlockCopyPayload(button.dataset.code ?? "", button.dataset.codeEncoding);
  void copyToClipboard(code).then((copied) => {
    if (!copied) {
      return;
    }
    button.classList.add("copied");
    setTimeout(() => button.classList.remove("copied"), 1500);
  });
}

export function markdownFileLinkFromEvent(
  event: Event,
): { path: string; line: number | null } | null {
  const target = event.target;
  if (!(target instanceof Element)) {
    return null;
  }
  const link = target.closest<HTMLAnchorElement>("a[data-file-path]");
  const path = link?.dataset.filePath;
  if (!path) {
    return null;
  }
  const line = link.dataset.fileLine;
  return { path, line: line ? Number.parseInt(line, 10) : null };
}

function splitFileLineSuffix(raw: string): { path: string; line: number | null } {
  const match = FILE_LINE_SUFFIX_RE.exec(raw);
  const line = match?.[1];
  return match && line
    ? { path: raw.slice(0, match.index), line: Number.parseInt(line, 10) }
    : { path: raw, line: null };
}

function isAllowlistedBareFilename(raw: string): boolean {
  if (raw.includes("/") || raw.includes("\\")) {
    return false;
  }
  const match = BARE_FILENAME_RE.exec(raw);
  return Boolean(match?.[1] && BARE_FILE_EXTENSIONS.has(match[1].toLowerCase()));
}

function parseFileLinkTarget(raw: string): { path: string; line: number | null } | null {
  const target = raw.trim();
  if (
    !MULTI_SEGMENT_FILE_RE.test(target) &&
    !BARE_FILE_WITH_LINE_RE.test(target) &&
    !isAllowlistedBareFilename(target)
  ) {
    return null;
  }
  return splitFileLineSuffix(target);
}

function isHostLocalFileHref(href: string): boolean {
  return HOST_LOCAL_FILE_HREF_RE.test(href.trim());
}

function isControlUiRoutePath(pathname: string): boolean {
  if (routeIdFromPath(pathname) !== null) {
    return true;
  }
  const basePath = currentControlUiBasePath();
  if (!basePath) {
    return false;
  }
  if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
    return false;
  }
  return routeIdFromPath(pathname, basePath) !== null;
}

function currentControlUiBasePath(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return resolveControlUiBasePath(window.location.pathname);
}

function pathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

function stripCurrentControlUiBasePath(pathname: string): string[] {
  const segments = pathSegments(pathname);
  const baseSegments = pathSegments(currentControlUiBasePath());
  if (
    baseSegments.length === 0 ||
    baseSegments.some((segment, index) => segments[index] !== segment)
  ) {
    return segments;
  }
  return segments.slice(baseSegments.length);
}

function segmentsStartWith(segments: string[], prefix: string[]): boolean {
  return prefix.every((segment, index) => segments[index] === segment);
}

function isControlUiResourcePath(segments: string[]): boolean {
  if (segments.includes("__openclaw__") || segments.includes("__openclaw")) {
    return true;
  }
  const segment = segments[0];
  if (!segment || APP_RESOURCE_ROOT_SEGMENTS.has(segment)) {
    return true;
  }
  return APP_RESOURCE_PATH_PREFIXES.some((prefix) => segmentsStartWith(segments, prefix));
}

function isDocsRootPath(normalizedPath: string, segments: string[]): boolean {
  if (DOCS_SHORTLINK_PATHS.has(normalizedPath)) {
    return true;
  }
  const segment = segments[0];
  return segment ? DOCS_ROOT_SEGMENTS.has(segment) : false;
}

function normalizeDocsRootHref(href: string): string {
  const trimmed = href.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return href;
  }
  try {
    const url = new URL(trimmed, DOCS_ORIGIN);
    if (url.origin !== DOCS_ORIGIN) {
      return href;
    }
    const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
    if (isControlUiRoutePath(normalizedPath)) {
      return href;
    }
    const segments = pathSegments(normalizedPath);
    const resourceSegments = stripCurrentControlUiBasePath(normalizedPath);
    if (isControlUiResourcePath(resourceSegments)) {
      return href;
    }
    if (isDocsRootPath(normalizedPath, segments)) {
      return url.href;
    }
    return href;
  } catch {
    return href;
  }
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

    const normalizedHref = normalizeDocsRootHref(href);
    if (normalizedHref !== href) {
      node.setAttribute("href", normalizedHref);
    }

    // Block dangerous URL schemes (javascript:, data:, vbscript:, etc.)
    try {
      const url = new URL(normalizedHref, window.location.href);
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

function normalizeMarkdownLineBreaks(value: string): string {
  return value.replace(/\r\n?|[\u2028\u2029]/g, "\n");
}

function formatTruncatedMarkdownInput(input: string): string {
  const truncated = truncateText(input, MARKDOWN_CHAR_LIMIT);
  return appendMarkdownTruncationNotice(truncated);
}

function appendMarkdownTruncationNotice(truncated: {
  text: string;
  truncated: boolean;
  total: number;
}): string {
  const notice = truncated.truncated
    ? `\n\n… truncated (${truncated.total} chars, showing first ${truncated.text.length}).`
    : "";
  return `${truncated.text}${notice}`;
}

export function isMarkdownBlockArtText(value: string): boolean {
  const lines = normalizeMarkdownLineBreaks(value).split("\n");
  const artLines = lines.filter((line) => line.trim().length > 0);
  if (artLines.length < 2) {
    return false;
  }

  // QR generators commonly use spaces plus upper/lower/full block glyphs.
  // Require multiple glyph-only lines so ordinary prose with a stray block character stays markdown.
  let glyphCount = 0;
  for (const line of artLines) {
    if (!BLOCK_ART_LINE_RE.test(line) || !BLOCK_ART_GLYPH_RE.test(line)) {
      return false;
    }
    glyphCount += Array.from(line).filter((char) => BLOCK_ART_GLYPH_RE.test(char)).length;
  }
  return glyphCount >= 8;
}

function getFenceMarker(line: string): { marker: "`" | "~"; length: number } | null {
  const match = FENCE_OPEN_RE.exec(stripFenceContainerPrefixes(line));
  if (!match) {
    return null;
  }
  const fence = match[1];
  if (!fence) {
    return null;
  }
  const marker = fence.charAt(0) as "`" | "~";
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
  const markerText = match[1];
  if (!markerText) {
    return false;
  }
  const marker = markerText.charAt(0);
  if (marker !== fence.marker || markerText.length < fence.length) {
    return false;
  }
  return trimmed.slice(match[0].length).trim() === "";
}

type StreamingMarkdownSplit = {
  /** Offset just past the last blank line outside a code fence; the prefix is block-stable. */
  boundary: number;
  /** True when the text after the boundary contains a code fence that has not closed yet. */
  tailHasOpenFence: boolean;
};

function splitStableStreamingMarkdown(markdownLocal: string): StreamingMarkdownSplit {
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

  return { boundary, tailHasOpenFence: openFence !== null };
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

function renderCodeElement(
  text: string,
  lang: string,
  options: { blockArt?: boolean } = {},
): string {
  if (options.blockArt || isMarkdownBlockArtText(text)) {
    return `<pre><code class="markdown-block-art">${escapeHtml(text)}</code></pre>`;
  }
  const highlighted = highlightCode(text, lang);
  const classAttr = codeClassAttribute(lang, highlighted);
  return `<pre><code${classAttr}>${highlighted}</code></pre>`;
}

function renderCodeBlock(
  text: string,
  lang: string,
  env: unknown,
  options: { blockArt?: boolean; copyText?: string } = {},
): string {
  const blockArt = options.blockArt || isMarkdownBlockArtText(text);
  const codeBlock = renderCodeElement(text, lang, { blockArt });
  if (!shouldRenderCodeBlockCopy(env)) {
    return codeBlock;
  }
  const langLabel = lang ? `<span class="code-block-lang">${escapeHtml(lang)}</span>` : "";
  const copyText = options.copyText ?? text;
  const copyPayload = blockArt ? encodeBlockArtCodeBlockCopyPayload(copyText) : copyText;
  const attrSafe = escapeHtml(copyPayload);
  const encodingAttr = blockArt
    ? ` data-code-encoding="${blockArtCodeBlockCopyPayloadEncoding}"`
    : "";
  const copyBtn = `<button type="button" class="code-block-copy" data-code="${attrSafe}"${encodingAttr} aria-label="${escapeHtml(t("common.copyCode"))}"><span class="code-block-copy__idle">${escapeHtml(t("common.copy"))}</span><span class="code-block-copy__done">${escapeHtml(t("common.copied"))}</span></button>`;
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
}

function codeBlockCopyTextFromMarkdownToken(content: string): string {
  return content.endsWith("\n") ? content.slice(0, -1) : content;
}

const md = new MarkdownIt({
  html: true, // Enable HTML recognition so html_block/html_inline overrides can escape it
  breaks: true,
  linkify: true,
});
const defaultCodeInlineRenderer = md.renderer.rules.code_inline!;

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
        const c = tail.charAt(i);
        if (open === close) {
          // Self-matching pair (e.g., "") — toggle between 0 and 1
          if (c === open) {
            balance[close] = balance[close] === 0 ? 1 : 0;
          }
        } else if (c === open) {
          // Distinct open/close (e.g., ())
          balance[close] = (balance[close] ?? 0) + 1;
        } else if (c === close) {
          balance[close] = (balance[close] ?? 0) - 1;
        }
      }
    }

    while (len > 0) {
      const ch = tail.charAt(len - 1);
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
        while (j >= 0 && /[a-zA-Z0-9]/.test(tail.charAt(j))) {
          j--;
        }
        // j < len - 2 ensures at least one alphanumeric between & and ;
        if (j >= 0 && tail.charAt(j) === "&" && j < len - 2) {
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
          if ((balance[ch] ?? 0) !== 0) {
            balance[ch] = 0;
            len--;
            continue;
          }
        } else if ((balance[ch] ?? 0) < 0) {
          // Distinct pair: strip if more closes than opens
          balance[ch] = (balance[ch] ?? 0) + 1;
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
      if (!token) {
        continue;
      }
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
      while (cjkIdx > 0 && CJK_RE.test(displayText.charAt(cjkIdx - 1))) {
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
        if (children[j]?.type === "link_close") {
          const tailToken = new state.Token("text", "", 0);
          tailToken.content = cjkTail;
          children.splice(j + 1, 0, tailToken);
          break;
        }
      }
    }
  }
});

function isFileLinkBoundaryBefore(value: string, index: number): boolean {
  const char = value[index - 1];
  return char === undefined || /\s/.test(char) || "([{<\"'`".includes(char);
}

function isFileLinkBoundaryAfter(value: string, index: number): boolean {
  const char = value[index];
  return char === undefined || /\s/.test(char) || ".,;:!?)]}>\"'".includes(char);
}

md.core.ruler.after("linkify", "file-links", (state) => {
  const env = state.env as Partial<MarkdownRenderEnv> | undefined;
  if (env?.fileLinks !== true) {
    return;
  }
  for (const blockToken of state.tokens) {
    if (blockToken.type !== "inline" || !blockToken.children) {
      continue;
    }
    const children = blockToken.children;
    let linkDepth = 0;
    for (let index = 0; index < children.length; index += 1) {
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
              parseFileLinkTarget(decodedHref) ??
              (isHostLocalFileHref(decodedHref) ? splitFileLineSuffix(decodedHref.trim()) : null);
            if (target) {
              token.attrs = token.attrs?.filter(([name]) => name !== "href") ?? null;
              token.attrJoin("class", "markdown-file-link");
              token.attrSet("data-file-path", target.path);
              if (target.line !== null) {
                token.attrSet("data-file-line", String(target.line));
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
      if (linkDepth > 0 || token.type !== "text") {
        continue;
      }

      const replacements: typeof children = [];
      let cursor = 0;
      FILE_LINK_SCAN_RE.lastIndex = 0;
      for (const match of token.content.matchAll(FILE_LINK_SCAN_RE)) {
        const matchIndex = match.index;
        const matched = match[0];
        const matchEnd = matchIndex + matched.length;
        if (
          !isFileLinkBoundaryBefore(token.content, matchIndex) ||
          !isFileLinkBoundaryAfter(token.content, matchEnd)
        ) {
          continue;
        }
        const target = parseFileLinkTarget(matched);
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
        open.attrSet("data-file-path", target.path);
        if (target.line !== null) {
          open.attrSet("data-file-line", String(target.line));
        }
        const label = new state.Token("text", "", 0);
        label.content = matched;
        const close = new state.Token("link_close", "a", -1);
        close.markup = "file-link";
        replacements.push(open, label, close);
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
    const token = tokens[i];
    const paragraph = tokens[i - 1];
    const listItem = tokens[i - 2];
    if (!token || !paragraph || !listItem) {
      continue;
    }
    if (token.type !== "inline" || !token.children) {
      continue;
    }
    if (paragraph.type !== "paragraph_open") {
      continue;
    }
    if (listItem.type !== "list_item_open") {
      continue;
    }
    const cls = listItem.attrGet("class") ?? "";
    if (!cls.includes("task-list-item")) {
      continue;
    }
    // Only trust the checkbox <input> token from the plugin, not other user-supplied HTML.
    // The plugin inserts an <input> at the start; user HTML elsewhere must stay escaped.
    for (const child of token.children) {
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
// Renderer rules degrade to empty output on impossible token misses instead of
// throwing mid-render; markdown input is untrusted and the chat view must not crash.
md.renderer.rules.html_block = (tokens, idx) => {
  const token = tokens[idx];
  return token ? escapeHtml(token.content) + "\n" : "";
};
md.renderer.rules.html_inline = (tokens, idx) => {
  const token = tokens[idx];
  if (!token) {
    return "";
  }
  if (token.meta?.taskListPlugin === true) {
    return token.content;
  }
  return escapeHtml(token.content);
};

md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
  const rendered = defaultCodeInlineRenderer(tokens, idx, options, env, self);
  const renderEnv = env as Partial<MarkdownRenderEnv> | undefined;
  const token = tokens[idx];
  const target = token && renderEnv?.fileLinks === true ? parseFileLinkTarget(token.content) : null;
  if (!target) {
    return rendered;
  }
  const lineAttr =
    target.line === null ? "" : ` data-file-line="${escapeHtml(String(target.line))}"`;
  return `<a class="markdown-file-link" data-file-path="${escapeHtml(target.path)}"${lineAttr}>${rendered}</a>`;
};

// Override image to only allow base64 data URIs (#15437)
md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx];
  if (!token) {
    return "";
  }
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
  if (!token) {
    return "";
  }
  // token.info contains the full fence info string (e.g., "json title=foo");
  // extract only the first whitespace-separated token as the language.
  const lang = token.info.trim().split(/\s+/)[0] || "";
  return renderCodeBlock(token.content, lang, env, {
    copyText: codeBlockCopyTextFromMarkdownToken(token.content),
  });
};

// Override indented code blocks (code_block) with the same treatment as fence
md.renderer.rules.code_block = (tokens, idx, _options, env) => {
  const content = tokens[idx]?.content;
  if (content === undefined) {
    return "";
  }
  return renderCodeBlock(content, "", env, {
    copyText: codeBlockCopyTextFromMarkdownToken(content),
  });
};

// Uncached render core shared by the static and streaming paths. The streaming
// tail changes on every delta, so routing it through here (instead of the cached
// wrapper) keeps per-message churn out of the LRU cache.
function renderSanitizedMarkdown(renderInput: string, renderOptions: MarkdownRenderEnv): string {
  installHooks();
  const truncated = truncateText(renderInput, MARKDOWN_CHAR_LIMIT);
  const input = appendMarkdownTruncationNotice(truncated);
  if (isMarkdownBlockArtText(truncated.text)) {
    return DOMPurify.sanitize(
      renderCodeBlock(input, "", renderOptions, { blockArt: true }),
      sanitizeOptions,
    );
  }
  if (truncated.text.length > MARKDOWN_PARSE_LIMIT) {
    // Large plain-text replies should stay readable without inheriting the
    // capped code-block chrome, while still preserving whitespace for logs
    // and other structured text that commonly trips the parse guard.
    return DOMPurify.sanitize(toEscapedPlainTextHtml(input), sanitizeOptions);
  }
  let rendered: string;
  try {
    rendered = md.render(input, renderOptions);
  } catch (err) {
    // Fall back to escaped plain text when md.render() throws (#36213).
    console.warn("[markdown] md.render failed, falling back to plain text:", err);
    rendered = `<pre class="code-block">${escapeHtml(input)}</pre>`;
  }
  return DOMPurify.sanitize(rendered, sanitizeOptions);
}

export function toSanitizedMarkdownHtml(
  markdownLocal: string,
  options: MarkdownRenderOptions = {},
): string {
  const renderOptions = normalizeMarkdownRenderOptions(options);
  const rawInput = normalizeMarkdownLineBreaks(
    stripUnsupportedCitationControlMarkers(markdownLocal),
  );
  const input = rawInput.trim();
  if (!input) {
    return "";
  }
  const renderInput = isMarkdownBlockArtText(rawInput) ? rawInput : input;
  const cacheable = input.length <= MARKDOWN_CACHE_MAX_CHARS;
  const cacheKey = `${i18n.getLocale()}\0${renderOptions.codeBlockChrome}\0${renderOptions.fileLinks}\0${renderInput}`;
  if (cacheable) {
    const cached = getCachedMarkdown(cacheKey);
    if (cached !== null) {
      return cached;
    }
  }
  const sanitized = renderSanitizedMarkdown(renderInput, renderOptions);
  if (cacheable) {
    setCachedMarkdown(cacheKey, sanitized);
  }
  return sanitized;
}

function toEscapedPlainTextHtml(value: string): string {
  return `<div class="markdown-plain-text-fallback">${escapeHtml(normalizeMarkdownLineBreaks(value))}</div>`;
}

// Streaming-tail repair config: math is not rendered by this pipeline, so
// completing `$$` would inject visible characters into ordinary prose.
const streamingRemendOptions = { katex: false, linkMode: "text-only" } satisfies RemendOptions;

// Renders the in-flight block live. remend closes/strips unterminated inline
// constructs (`**bold`, half links, …) so partially streamed markup styles
// immediately instead of flashing raw markers. Inside an open code fence the
// tail is code, not prose: skip remend (it only understands top-level ```
// fences) and let markdown-it auto-close the fence at end of input (CommonMark
// allows unterminated fences), so code streams with live highlighting.
// Invariant: the tail never contains a *closed* fence — the split boundary
// advances past every fence close — so remend (which cannot see ~~~ fences)
// never runs across completed fenced code.
function toStreamingTailHtml(tail: string, renderOptions: MarkdownRenderEnv): string {
  return renderSanitizedMarkdown(remend(tail, streamingRemendOptions), renderOptions);
}
export function toStreamingMarkdownHtml(
  markdownLocal: string,
  options: MarkdownRenderOptions = {},
): string {
  const renderOptions = normalizeMarkdownRenderOptions(options);
  const rawInput = normalizeMarkdownLineBreaks(
    stripUnsupportedCitationControlMarkers(markdownLocal),
  );
  if (isMarkdownBlockArtText(rawInput)) {
    return renderSanitizedMarkdown(rawInput, renderOptions);
  }

  const trimmedInput = rawInput.trim();
  if (!trimmedInput) {
    return "";
  }
  const input = formatTruncatedMarkdownInput(trimmedInput);

  const { boundary, tailHasOpenFence } = splitStableStreamingMarkdown(input);
  const stableMarkdown = input.slice(0, boundary);
  const streamingTail = input.slice(boundary);
  const stableHtml = boundary > 0 ? toSanitizedMarkdownHtml(stableMarkdown, options) : "";
  if (!streamingTail.trim()) {
    return stableHtml;
  }
  const tailHtml = tailHasOpenFence
    ? renderSanitizedMarkdown(streamingTail, renderOptions)
    : toStreamingTailHtml(streamingTail, renderOptions);
  return `${stableHtml}${tailHtml}`;
}
