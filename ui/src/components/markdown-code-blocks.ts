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
const codeBlockCopyAttempts = new WeakMap<HTMLElement, number>();
const codeBlockCopyResetTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function updateCodeBlockOverflow(pre: HTMLElement): void {
  const wrapper = pre.closest<HTMLElement>(".code-block-wrapper");
  if (!wrapper) {
    return;
  }
  const maxScroll = pre.scrollWidth - pre.clientWidth;
  wrapper.classList.toggle("has-scroll-left", pre.scrollLeft > 1);
  wrapper.classList.toggle("has-scroll-right", pre.scrollLeft < maxScroll - 1);
}

export function initializeMarkdownCodeBlockOverflow(root: ParentNode): void {
  for (const pre of root.querySelectorAll<HTMLElement>(".code-block-wrapper pre")) {
    updateCodeBlockOverflow(pre);
  }
}

export function updateMarkdownCodeBlockOverflow(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const pre = target.matches(".code-block-wrapper pre")
    ? target
    : target.closest<HTMLElement>(".code-block-wrapper")?.querySelector("pre");
  if (!(pre instanceof HTMLElement)) {
    return;
  }
  updateCodeBlockOverflow(pre);
}

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
  updateMarkdownCodeBlockOverflow(event);
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const jsonNodeToggle = target.closest<HTMLButtonElement>(".code-block-json-node-toggle");
  if (jsonNodeToggle) {
    const node = jsonNodeToggle.closest<HTMLElement>(".code-block-json-node");
    if (!node) {
      return;
    }
    const expanded = node.classList.toggle("is-expanded");
    jsonNodeToggle.setAttribute("aria-expanded", String(expanded));
    return;
  }
  const jsonTab = target.closest<HTMLButtonElement>(".code-block-json-tab");
  if (jsonTab) {
    const wrapper = jsonTab.closest<HTMLElement>(".code-block-wrapper");
    const mode = jsonTab.dataset.jsonMode;
    if (!wrapper || (mode !== "tree" && mode !== "raw")) {
      return;
    }
    wrapper.classList.toggle("is-json-raw", mode === "raw");
    for (const tab of wrapper.querySelectorAll<HTMLButtonElement>(".code-block-json-tab")) {
      tab.setAttribute("aria-selected", String(tab === jsonTab));
    }
    return;
  }
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
  options: { blockArt?: boolean } = {},
): string {
  if (options.blockArt || isMarkdownBlockArtText(text)) {
    return `<pre><code class="markdown-block-art">${escapeMarkdownHtml(text)}</code></pre>`;
  }
  const highlighted = highlightCodeHtml(text, lang);
  const classAttr = codeClassAttribute(lang, highlighted);
  return `<pre><code${classAttr}>${highlighted}</code></pre>`;
}

function renderCodeBlockHeader(lang: string, copyButton: string): string {
  const language = lang ? escapeMarkdownHtml(lang) : "code";
  return `<div class="code-block-header"><span class="code-block-lang">${language}</span><div class="code-block-actions">${copyButton}</div></div>`;
}

function renderJsonPrimitive(value: unknown): string {
  if (value === null) {
    return '<span class="code-block-json-value code-block-json-value--null">null</span>';
  }
  if (typeof value === "string") {
    return `<span class="code-block-json-value code-block-json-value--string">${escapeMarkdownHtml(JSON.stringify(value))}</span>`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return `<span class="code-block-json-value code-block-json-value--literal">${String(value)}</span>`;
  }
  return `<span class="code-block-json-value">${escapeMarkdownHtml(String(value))}</span>`;
}

function renderJsonNode(value: object, depth: number, expanded: boolean): string {
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>);
  const opening = Array.isArray(value) ? "[" : "{";
  const closing = Array.isArray(value) ? "]" : "}";
  const count = entries.length;
  const summary = Array.isArray(value) ? `[ ${count} items ]` : `{ ${count} keys }`;
  const rows = entries
    .map(([key, item], index) => {
      const comma = index < entries.length - 1 ? "," : "";
      const label = Array.isArray(value)
        ? ""
        : `<span class="code-block-json-key">${escapeMarkdownHtml(JSON.stringify(key))}</span><span class="code-block-json-colon">: </span>`;
      if (item !== null && typeof item === "object") {
        return `<li>${label}${renderJsonNode(item, depth + 1, depth === 0)}${comma}</li>`;
      }
      return `<li>${label}${renderJsonPrimitive(item)}${comma}</li>`;
    })
    .join("");
  return `<span class="code-block-json-node${expanded ? " is-expanded" : ""}"><button type="button" class="code-block-json-node-toggle" aria-expanded="${String(expanded)}"><span class="code-block-json-node-summary">${escapeMarkdownHtml(summary)}</span><span class="code-block-json-node-opening">${opening}</span></button><span class="code-block-json-node-content"><ul>${rows}</ul><span class="code-block-json-bracket">${closing}</span></span></span>`;
}

function renderJsonTree(value: unknown): string {
  return value !== null && typeof value === "object"
    ? renderJsonNode(value, 0, true)
    : renderJsonPrimitive(value);
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
  const copyText = options.copyText ?? text;
  const copyPayload = blockArt ? encodeBlockArtCodeBlockCopyPayload(copyText) : copyText;
  const attrSafe = escapeMarkdownHtml(copyPayload);
  const encodingAttr = blockArt
    ? ` data-code-encoding="${blockArtCodeBlockCopyPayloadEncoding}"`
    : "";
  const copyButton = `<button type="button" class="code-block-copy" data-code="${attrSafe}"${encodingAttr} aria-label="${escapeMarkdownHtml(t("common.copyCode"))}"><span class="code-block-copy__idle" aria-hidden="true"></span><span class="code-block-copy__done" aria-hidden="true"></span><span class="code-block-copy__failed" aria-hidden="true">!</span></button>`;
  const header = renderCodeBlockHeader(lang, copyButton);

  const trimmed = text.trim();
  const isJson =
    lang === "json" ||
    (!lang &&
      ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))));

  if (isJson) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const jsonHeader = `<div class="code-block-header"><span class="code-block-lang">json</span><div class="code-block-actions"><div class="code-block-json-tabs" role="tablist"><button type="button" class="code-block-json-tab" data-json-mode="tree" role="tab" aria-selected="true">Tree</button><button type="button" class="code-block-json-tab" data-json-mode="raw" role="tab" aria-selected="false">Raw</button></div>${copyButton}</div></div>`;
      return `<div class="code-block-wrapper code-block-wrapper--json">${jsonHeader}<div class="code-block-json-tree">${renderJsonTree(parsed)}</div><div class="code-block-json-raw">${codeBlock}</div></div>`;
    } catch {
      // Invalid JSON remains a highlighted code fence.
    }
  }

  return `<div class="code-block-wrapper">${header}${codeBlock}</div>`;
}

export function markdownCodeBlockCopyText(content: string): string {
  return content.endsWith("\n") ? content.slice(0, -1) : content;
}
