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
const CODE_PREVIEW_LINE_COUNT = 7;
const codeBlockCopyAttempts = new WeakMap<HTMLElement, number>();
const codeBlockCopyResetTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

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

function codeBlockRenderEnv(env: unknown): Partial<MarkdownRenderEnv> | undefined {
  // SAFETY: markdown-it types renderer env as unknown; this internal renderer
  // receives the normalized options object, or undefined from direct calls.
  return env as Partial<MarkdownRenderEnv> | undefined;
}

function shouldRenderCodeBlockCopy(env: unknown): boolean {
  return codeBlockRenderEnv(env)?.codeBlockChrome !== "none";
}

function shouldRenderCodeBlockInteraction(env: unknown): boolean {
  return codeBlockRenderEnv(env)?.codeBlockInteraction === "interactive";
}

function encodeCodeBlockCopyPayload(value: string): string {
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

/**
 * Single click owner for every fenced-code control. Copy, reveal, and wrap ship
 * in the same markup, so one entry point keeps a host from wiring part of it and
 * leaving the rest of the block inert.
 */
export function handleMarkdownCodeBlockClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  handleCodeBlockDisclosure(target);
  const button = target.closest<HTMLElement>(".code-block-copy");
  if (!button) {
    return;
  }
  const code = decodeCodeBlockCopyPayload(button.dataset.code ?? "", button.dataset.codeEncoding);
  const attempt = (codeBlockCopyAttempts.get(button) ?? 0) + 1;
  codeBlockCopyAttempts.set(button, attempt);
  void copyToClipboard(code).then((copied) => {
    // Clipboard writes can finish out of click order; older attempts must not own feedback.
    if (codeBlockCopyAttempts.get(button) !== attempt) {
      return;
    }
    button.classList.toggle("copied", copied);
    button.classList.toggle("copy-failed", !copied);
    button.setAttribute("aria-label", t(copied ? "common.copied" : "common.copyFailed"));
    clearTimeout(codeBlockCopyResetTimers.get(button));
    const resetTimer = setTimeout(
      () => {
        button.classList.remove("copied");
        button.classList.remove("copy-failed");
        button.setAttribute("aria-label", t("common.copyCode"));
        codeBlockCopyResetTimers.delete(button);
      },
      copied ? 1500 : 2000,
    );
    codeBlockCopyResetTimers.set(button, resetTimer);
  });
}

function handleCodeBlockDisclosure(target: Element): void {
  const wrapper = target.closest<HTMLElement>(".code-block-wrapper");
  if (!wrapper) {
    return;
  }
  if (target.closest(".code-block-expand")) {
    wrapper.classList.add("is-expanded");
    target.closest<HTMLButtonElement>(".code-block-expand")?.setAttribute("aria-expanded", "true");
  }
  const wrapButton = target.closest<HTMLButtonElement>(".code-block-wrap");
  if (!wrapButton) {
    return;
  }
  const wrapped = wrapper.classList.toggle("is-wrapped");
  const label = t(wrapped ? "chat.codeBlock.disableWrap" : "chat.codeBlock.enableWrap");
  wrapButton.setAttribute("aria-pressed", String(wrapped));
  wrapButton.setAttribute("aria-label", label);
  wrapButton.title = label;
  updateCodeBlockWidthOverflow(wrapper);
}

export function updateCodeBlockWidthOverflow(wrapper: HTMLElement): void {
  const viewport = wrapper.querySelector<HTMLElement>(".code-block-viewport");
  const code = viewport?.querySelector<HTMLElement>("code");
  if (!viewport || !code) {
    return;
  }
  const overflowing =
    !wrapper.classList.contains("is-wrapped") && code.scrollWidth > viewport.clientWidth + 1;
  wrapper.classList.toggle("has-horizontal-overflow", overflowing);
}

/** Highlight a snippet; output is escaped hljs markup safe for unsafeHTML in a code block. */
export function highlightCodeHtml(text: string, lang: string): string {
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
  return highlightCodeHtml(text, "json");
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
  options: { blockArt?: boolean; highlight?: boolean } = {},
): string {
  if (options.blockArt || isMarkdownBlockArtText(text)) {
    return `<pre><code class="markdown-block-art">${escapeMarkdownHtml(text)}</code></pre>`;
  }
  const highlighted =
    options.highlight === false ? escapeMarkdownHtml(text) : highlightCodeHtml(text, lang);
  const classAttr = codeClassAttribute(lang, highlighted);
  return `<pre><code${classAttr}>${highlighted}</code></pre>`;
}

function renderCodeBlockHeader(lang: string, actions: string): string {
  const language = escapeMarkdownHtml(lang || t("chat.codeBlock.languageFallback"));
  return `<div class="code-block-header"><span class="code-block-lang">${language}</span><div class="code-block-actions">${actions}</div></div>`;
}

function renderCodeBlockCopyButton(text: string): string {
  // Attribute sanitization trims plain values; encode copied whitespace with the text.
  const attrSafe = escapeMarkdownHtml(encodeCodeBlockCopyPayload(text));
  return `<button type="button" class="code-block-copy" data-code="${attrSafe}" data-code-encoding="${blockArtCodeBlockCopyPayloadEncoding}" aria-label="${escapeMarkdownHtml(t("common.copyCode"))}"><span class="code-block-copy__idle" aria-hidden="true"></span><span class="code-block-copy__done" aria-hidden="true"></span><span class="code-block-copy__failed" aria-hidden="true">!</span></button>`;
}

export function renderMarkdownCodeBlock(
  text: string,
  lang: string,
  env: unknown,
  options: { blockArt?: boolean; copyText?: string; highlight?: boolean } = {},
): string {
  const blockArt = options.blockArt || isMarkdownBlockArtText(text);
  const codeBlock = renderCodeElement(text, lang, { blockArt, highlight: options.highlight });
  if (!shouldRenderCodeBlockCopy(env) && !shouldRenderCodeBlockInteraction(env)) {
    return codeBlock;
  }
  const copyButton = shouldRenderCodeBlockCopy(env)
    ? renderCodeBlockCopyButton(options.copyText ?? text)
    : "";
  // Reveal and wrap controls are inert without a host that runs the code-block
  // lifecycle, so only interaction-owning hosts get the collapsible markup.
  if (!shouldRenderCodeBlockInteraction(env)) {
    return `<div class="code-block-wrapper">${renderCodeBlockHeader(lang, copyButton)}${codeBlock}</div>`;
  }
  const hiddenLineCount = ["text", "md", "markdown"].includes(lang.trim().toLowerCase())
    ? 0
    : Math.max(0, markdownCodeBlockCopyText(text).split("\n").length - CODE_PREVIEW_LINE_COUNT);
  const hiddenCount = { count: String(hiddenLineCount) };
  const expandLabel = t(
    hiddenLineCount === 1 ? "chat.codeBlock.showHiddenLine" : "chat.codeBlock.showHiddenLines",
    hiddenCount,
  );
  const hiddenLabel = t(
    hiddenLineCount === 1 ? "chat.codeBlock.hiddenLine" : "chat.codeBlock.hiddenLines",
    hiddenCount,
  );
  const expandButton = hiddenLineCount
    ? `<button type="button" class="code-block-expand" aria-label="${escapeMarkdownHtml(expandLabel)}" aria-expanded="false"><span class="code-block-chevron" aria-hidden="true"></span><span>${escapeMarkdownHtml(hiddenLabel)}</span></button>`
    : "";
  const wrapLabel = escapeMarkdownHtml(t("chat.codeBlock.enableWrap"));
  const wrapButton = `<button type="button" class="code-block-wrap" aria-label="${wrapLabel}" title="${wrapLabel}" aria-pressed="false"><span class="code-block-wrap__enable" aria-hidden="true"></span><span class="code-block-wrap__disable" aria-hidden="true"></span></button>`;
  const header = renderCodeBlockHeader(lang, `${wrapButton}${copyButton}`);
  return `<div class="code-block-wrapper${hiddenLineCount ? " is-collapsible" : ""}">${header}<div class="code-block-viewport">${codeBlock}</div>${expandButton}</div>`;
}

export function markdownCodeBlockCopyText(content: string): string {
  return content.endsWith("\n") ? content.slice(0, -1) : content;
}
