// Control UI module implements markdown behavior.
import DOMPurify from "dompurify";
import { stripUnsupportedCitationControlMarkers } from "../../../src/shared/text/citation-control-markers.js";
import { routeIdFromPath } from "../app-route-paths.ts";
import { resolveControlUiBasePath } from "../app/browser.ts";
import { i18n, t } from "../i18n/index.ts";
import { truncateText } from "../lib/format.ts";
import { normalizeLowercaseStringOrEmpty } from "../lib/string-coerce.ts";
import { renderAssistantTranscriptPlainTextFallback } from "./markdown-assistant-transcript.ts";
import { renderMarkdownCodeBlock } from "./markdown-code-blocks.ts";
import { isHostLocalMarkdownFileHref } from "./markdown-file-links.ts";
import { createMarkdownParser } from "./markdown-parser.ts";
import {
  normalizeMarkdownRenderOptions,
  type MarkdownRenderEnv,
  type MarkdownRenderOptions,
} from "./markdown-render-options.ts";
import { repairStreamingMarkdownTail, splitStableStreamingMarkdown } from "./markdown-streaming.ts";
import {
  escapeMarkdownHtml,
  isMarkdownBlockArtText,
  normalizeMarkdownLineBreaks,
} from "./markdown-text.ts";

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

    if (isHostLocalMarkdownFileHref(href)) {
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

const markdownParser = createMarkdownParser();

// Uncached render core shared by the static and streaming paths. The streaming
// tail changes on every delta, so routing it through here (instead of the cached
// wrapper) keeps per-message churn out of the LRU cache.
function renderSanitizedMarkdown(renderInput: string, renderOptions: MarkdownRenderEnv): string {
  installHooks();
  const truncated = truncateText(renderInput, MARKDOWN_CHAR_LIMIT);
  const input = appendMarkdownTruncationNotice(truncated);
  if (isMarkdownBlockArtText(truncated.text)) {
    return DOMPurify.sanitize(
      renderMarkdownCodeBlock(input, "", renderOptions, { blockArt: true }),
      sanitizeOptions,
    );
  }
  if (truncated.text.length > MARKDOWN_PARSE_LIMIT) {
    // Large plain-text replies should stay readable without inheriting the
    // capped code-block chrome, while still preserving whitespace for logs
    // and other structured text that commonly trips the parse guard.
    return DOMPurify.sanitize(toEscapedPlainTextHtml(input, renderOptions), sanitizeOptions);
  }
  let rendered: string;
  try {
    rendered = markdownParser.render(input, renderOptions);
  } catch (err) {
    // Fall back to escaped plain text when md.render() throws (#36213).
    console.warn("[markdown] md.render failed, falling back to plain text:", err);
    rendered = toEscapedPlainTextHtml(input, renderOptions);
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
  const cacheKey = `${i18n.getLocale()}\0${renderOptions.assistantTranscriptRoleHeaders}\0${renderOptions.codeBlockChrome}\0${renderOptions.fileLinks}\0${renderOptions.interactiveImages}\0${renderInput}`;
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

function toEscapedPlainTextHtml(value: string, options: MarkdownRenderEnv): string {
  return renderAssistantTranscriptPlainTextFallback(
    normalizeMarkdownLineBreaks(value),
    options.assistantTranscriptRoleHeaders,
    () => t("sessionsView.assistant"),
    escapeMarkdownHtml,
  );
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
    : renderSanitizedMarkdown(repairStreamingMarkdownTail(streamingTail), renderOptions);
  return `${stableHtml}${tailHtml}`;
}
