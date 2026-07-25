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
import { t } from "../i18n/index.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import type { MarkdownRenderEnv } from "./markdown-render-options.ts";
import { escapeMarkdownHtml, isMarkdownBlockArtText } from "./markdown-text.ts";

const blockArtCopyPayloadPrefix = "openclaw:block-art-code:";
const blockArtCodeBlockCopyPayloadEncoding = "block-art-json";

for (const [language, definition] of Object.entries({
  bash,
  cpp,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  typescript,
  xml,
  yaml,
})) {
  hljs.registerLanguage(language, definition);
}
hljs.registerAliases("shell", { languageName: "bash" });

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

function highlightCode(text: string, lang: string): string {
  const language = lang.trim().toLowerCase();
  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    }
    if (!language && text.trim()) {
      const result = hljs.highlightAuto(text);
      if (result.relevance >= 2) {
        return result.value;
      }
    }
  } catch {
    // Fall back to escaped plaintext; malformed input should not break chat rendering.
  }
  return escapeMarkdownHtml(text);
}

/** Highlight a JSON/JSON5 snippet; output is escaped hljs markup safe for unsafeHTML in a code block. */
export function highlightJsonHtml(text: string): string {
  return highlightCode(text, "json");
}

function codeClassAttribute(lang: string, highlighted: string): string {
  const classes = [
    highlighted.includes("hljs-") ? "hljs" : "",
    lang ? `language-${lang}` : "",
  ].filter(Boolean);
  return classes.length > 0 ? ` class="${escapeMarkdownHtml(classes.join(" "))}"` : "";
}

function renderCodeElement(
  text: string,
  lang: string,
  options: { blockArt?: boolean } = {},
): string {
  if (options.blockArt || isMarkdownBlockArtText(text)) {
    return `<pre><code class="markdown-block-art">${escapeMarkdownHtml(text)}</code></pre>`;
  }
  const highlighted = highlightCode(text, lang);
  const classAttr = codeClassAttribute(lang, highlighted);
  return `<pre><code${classAttr}>${highlighted}</code></pre>`;
}

export function renderMarkdownCodeBlock(
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
  const langLabel = lang ? `<span class="code-block-lang">${escapeMarkdownHtml(lang)}</span>` : "";
  const copyText = options.copyText ?? text;
  const copyPayload = blockArt ? encodeBlockArtCodeBlockCopyPayload(copyText) : copyText;
  const attrSafe = escapeMarkdownHtml(copyPayload);
  const encodingAttr = blockArt
    ? ` data-code-encoding="${blockArtCodeBlockCopyPayloadEncoding}"`
    : "";
  const copyButton = `<button type="button" class="code-block-copy" data-code="${attrSafe}"${encodingAttr} aria-label="${escapeMarkdownHtml(t("common.copyCode"))}"><span class="code-block-copy__idle">${escapeMarkdownHtml(t("common.copy"))}</span><span class="code-block-copy__done">${escapeMarkdownHtml(t("common.copied"))}</span></button>`;
  const header = `<div class="code-block-header">${langLabel}${copyButton}</div>`;

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

export function markdownCodeBlockCopyText(content: string): string {
  return content.endsWith("\n") ? content.slice(0, -1) : content;
}
