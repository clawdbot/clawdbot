// Control UI chat module implements tool cards behavior.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { icons, type IconName } from "../../../components/icons.ts";
import { isMarkdownBlockArtText } from "../../../components/markdown.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import type { ToolCard, ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import type { DiffLine, DiffStat } from "../../../lib/chat/tool-call-diff.ts";
import { resolveToolCallView, type ToolCallView } from "../../../lib/chat/tool-call-view.ts";
import {
  formatDistinctCollapsedToolSummaryText,
  formatCollapsedToolPreviewText,
  formatCollapsedToolSummaryText,
  isToolCardError,
  resolveToolCardOutcome,
  type ToolPreview,
} from "../../../lib/chat/tool-cards.ts";
import {
  formatToolDetail,
  resolveCanvasIframeUrl,
  resolveEmbedSandbox,
  resolveToolDisplay,
  type EmbedSandboxMode,
} from "../../../lib/chat/tool-display.ts";
import { getToolCallTitle } from "../tool-titles.ts";
import type { SidebarContent } from "./chat-sidebar.ts";

type FullMessageRequest = NonNullable<SidebarContent["fullMessageRequest"]>;

export function shouldToggleSelectableDisclosure(event: MouseEvent): boolean {
  if (event.detail === 0) {
    return true;
  }
  const target = event.currentTarget;
  const selection = window.getSelection();
  if (!(target instanceof Node) || !selection || selection.isCollapsed) {
    return true;
  }
  return ![selection.anchorNode, selection.focusNode].some(
    (node) => node !== null && target.contains(node),
  );
}

function formatToolOutputForSidebar(text: string): string {
  if (isMarkdownBlockArtText(text)) {
    return "```\n" + text + "\n```";
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return "```json\n" + JSON.stringify(JSON.parse(trimmed), null, 2) + "\n```";
    } catch {
      return text;
    }
  }
  return text;
}

function renderToolIcon(name: string) {
  return icons[name as IconName] ?? icons.puzzle;
}

function formatPayloadForSidebar(
  text: string | undefined,
  language: "json" | "text" = "text",
): string {
  if (!text?.trim()) {
    return "";
  }
  if (language === "json") {
    return `\`\`\`json
${text}
\`\`\``;
  }
  const formatted = formatToolOutputForSidebar(text);
  if (formatted.includes("```")) {
    return formatted;
  }
  return `\`\`\`text
${text}
\`\`\``;
}

export function buildToolCardSidebarContent(card: ToolCard): string {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const isError = isToolCardError(card);
  const outcome = resolveToolCardOutcome(card, false);
  const sections = [`## ${display.label}`, `**${t("chat.toolCards.tool")}:** \`${display.name}\``];

  if (detail) {
    sections.push(`**${t("chat.toolCards.summary")}:** ${detail}`);
  }

  if (card.inputText?.trim()) {
    const inputIsJson = typeof card.args === "object" && card.args !== null;
    sections.push(
      `### ${t("chat.toolCards.toolInput")}\n${formatPayloadForSidebar(card.inputText, inputIsJson ? "json" : "text")}`,
    );
  }

  if (card.outputText?.trim()) {
    sections.push(
      `### ${t(isError ? "chat.toolCards.toolError" : "chat.toolCards.toolOutput")}\n${formatToolOutputForSidebar(card.outputText)}`,
    );
  } else {
    sections.push(
      isError
        ? `### ${t("chat.toolCards.toolError")}\n*${t("chat.toolCards.noOutputFailed")}*`
        : outcome === "succeeded"
          ? `### ${t("chat.toolCards.toolOutput")}\n*${t("chat.toolCards.noOutputSucceeded")}*`
          : `### ${t("chat.toolCards.toolOutput")}\n*${t("chat.toolCards.noResult")}*`,
    );
  }

  return sections.join("\n\n");
}

function handleRawDetailsToggle(event: Event) {
  const button = event.currentTarget as HTMLButtonElement | null;
  const root = button?.closest(".chat-tool-card__raw");
  const body = root?.querySelector<HTMLElement>(".chat-tool-card__raw-body");
  if (!button || !body) {
    return;
  }
  const expanded = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!expanded));
  body.hidden = expanded;
}

// Sandboxed widget documents report their content height via postMessage so the
// preview iframe can fit short/tall widgets. The event source must be one of our
// preview frames and the height is clamped, so widget code can only resize its
// own frame within the same bounds the preview contract allows.
const WIDGET_SIZE_MESSAGE_TYPE = "openclaw:widget-size";
const WIDGET_FRAME_MIN_HEIGHT = 160;
const WIDGET_FRAME_MAX_HEIGHT = 1200;
// Preview frames render inside lit shadow roots, so a document query cannot
// find them; frames register themselves on load and are dropped once detached.
const widgetFrameRegistry = new Set<HTMLIFrameElement>();
// Reported heights keyed by frame src: lit re-renders re-apply the style
// binding, so the template must read the reported height back or it resets.
const widgetFrameHeightsBySrc = new Map<string, number>();
const WIDGET_FRAME_HEIGHTS_MAX_ENTRIES = 100;
let widgetSizeListenerInstalled = false;

function rememberWidgetFrameHeight(src: string, height: number) {
  if (
    !widgetFrameHeightsBySrc.has(src) &&
    widgetFrameHeightsBySrc.size >= WIDGET_FRAME_HEIGHTS_MAX_ENTRIES
  ) {
    const oldest = widgetFrameHeightsBySrc.keys().next().value;
    if (oldest !== undefined) {
      widgetFrameHeightsBySrc.delete(oldest);
    }
  }
  widgetFrameHeightsBySrc.set(src, height);
}

function registerWidgetFrame(event: Event) {
  const frame = event.currentTarget;
  if (frame instanceof HTMLIFrameElement) {
    widgetFrameRegistry.add(frame);
  }
}

function installWidgetSizeListener() {
  if (widgetSizeListenerInstalled || typeof window === "undefined") {
    return;
  }
  widgetSizeListenerInstalled = true;
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: unknown; height?: unknown } | null;
    if (!data || data.type !== WIDGET_SIZE_MESSAGE_TYPE || typeof data.height !== "number") {
      return;
    }
    for (const frame of widgetFrameRegistry) {
      if (!frame.isConnected) {
        widgetFrameRegistry.delete(frame);
        continue;
      }
      if (frame.contentWindow === event.source) {
        const height = Math.min(
          Math.max(Math.trunc(data.height), WIDGET_FRAME_MIN_HEIGHT),
          WIDGET_FRAME_MAX_HEIGHT,
        );
        // The stylesheet floors the frame at min-height 420px; reported sizes
        // must override both properties to fit short widgets.
        frame.style.height = `${height}px`;
        frame.style.minHeight = `${height}px`;
        const src = frame.getAttribute("src");
        if (src) {
          rememberWidgetFrameHeight(src, height);
        }
        return;
      }
    }
  });
}

function renderPreviewFrame(params: {
  title: string;
  src?: string;
  height?: number;
  sandbox?: string;
}) {
  installWidgetSizeListener();
  const sandbox = params.sandbox ?? "";
  const src = params.src ?? "";
  const reportedHeight = src ? widgetFrameHeightsBySrc.get(src) : undefined;
  const height = reportedHeight ?? params.height;
  return keyed(
    `${sandbox}\u0000${src}\u0000${params.height ?? ""}`,
    html`
      <iframe
        class="chat-tool-card__preview-frame"
        title=${params.title}
        sandbox=${sandbox}
        src=${src || nothing}
        style=${height ? `height:${height}px;min-height:${height}px` : ""}
        @load=${registerWidgetFrame}
      ></iframe>
    `,
  );
}

export function renderToolPreview(
  preview: ToolPreview | undefined,
  surface: "chat_tool" | "chat_message" | "sidebar",
  options?: {
    onOpenSidebar?: (content: SidebarContent) => void;
    rawText?: string | null;
    canvasPluginSurfaceUrl?: string | null;
    embedSandboxMode?: EmbedSandboxMode;
    allowExternalEmbedUrls?: boolean;
  },
) {
  if (!preview) {
    return nothing;
  }
  if (preview.kind !== "canvas" || surface === "chat_tool") {
    return nothing;
  }
  if (preview.surface !== "assistant_message") {
    return nothing;
  }
  return html`
    <div class="chat-tool-card__preview" data-kind="canvas" data-surface=${surface}>
      <div class="chat-tool-card__preview-header">
        <span class="chat-tool-card__preview-label">${preview.title?.trim() || "Canvas"}</span>
      </div>
      <div class="chat-tool-card__preview-panel" data-side="canvas">
        ${renderPreviewFrame({
          title: preview.title?.trim() || "Canvas",
          src: resolveCanvasIframeUrl(
            preview.url,
            options?.canvasPluginSurfaceUrl,
            options?.allowExternalEmbedUrls ?? false,
          ),
          height: preview.preferredHeight,
          sandbox: resolveEmbedSandbox(options?.embedSandboxMode ?? "scripts", preview.sandbox),
        })}
      </div>
    </div>
  `;
}

function buildSidebarContent(
  value: string,
  options?: {
    rawText?: string | null;
    fullMessageRequest?: FullMessageRequest;
  },
): SidebarContent {
  return {
    kind: "markdown",
    content: value,
    ...(options?.rawText ? { rawText: options.rawText } : {}),
    ...(options?.fullMessageRequest ? { fullMessageRequest: options.fullMessageRequest } : {}),
  };
}

export function buildPreviewSidebarContent(
  preview: ToolPreview,
  rawText?: string | null,
  options?: { fullMessageRequest?: FullMessageRequest },
): SidebarContent | null {
  if (preview.kind !== "canvas" || preview.render !== "url" || !preview.viewId || !preview.url) {
    return null;
  }
  return {
    kind: "canvas",
    docId: preview.viewId,
    entryUrl: preview.url,
    ...(preview.title ? { title: preview.title } : {}),
    ...(preview.preferredHeight ? { preferredHeight: preview.preferredHeight } : {}),
    // The per-preview sandbox ceiling must survive the sidebar conversion, or a
    // trusted global embed mode would re-grant same-origin to widget script.
    ...(preview.sandbox ? { sandbox: preview.sandbox } : {}),
    ...(rawText ? { rawText } : {}),
    ...(options?.fullMessageRequest ? { fullMessageRequest: options.fullMessageRequest } : {}),
  };
}

function buildToolSidebarFullMessageRequest(
  card: ToolCard,
  sessionKey: string | undefined,
): FullMessageRequest | undefined {
  if (!sessionKey || !card.messageId) {
    return undefined;
  }
  // A transcript entry can contain multiple tool blocks. Until the request can
  // identify a specific block, upgrading by message id can show the wrong tool.
  return undefined;
}

export function renderRawOutputToggle(text: string) {
  return html`
    <div class="chat-tool-card__raw">
      <button
        class="chat-tool-card__raw-toggle"
        type="button"
        aria-expanded="false"
        @click=${handleRawDetailsToggle}
      >
        <span>${t("chat.toolCards.rawDetails")}</span>
        <span class="chat-tool-card__raw-toggle-icon">${icons.chevronDown}</span>
      </button>
      <div class="chat-tool-card__raw-body" hidden>
        ${renderToolDataBlock({ label: t("chat.toolCards.toolOutput"), text })}
      </div>
    </div>
  `;
}

function renderToolDataBlock(params: { label: string; text: string }) {
  const { label, text } = params;
  const codeClass = isMarkdownBlockArtText(text) ? "markdown-block-art" : "";
  return html`
    <div class="chat-tool-card__block">
      <div class="chat-tool-card__block-header">
        <span class="chat-tool-card__block-icon">${icons.zap}</span>
        <span class="chat-tool-card__block-label">${label}</span>
      </div>
      <pre class="chat-tool-card__block-content"><code class=${codeClass}>${text}</code></pre>
    </div>
  `;
}

// ── Kind-aware tool rows (command / read / edit / write / search / fetch) ──

const TOOL_ROW_VERB_KEYS: Partial<Record<ToolCallView["kind"], string>> = {
  read: "chat.toolCards.verbs.read",
  search: "chat.toolCards.verbs.searched",
  fetch: "chat.toolCards.verbs.fetched",
};

const MUTATION_VERB_KEYS = {
  edit: {
    running: "chat.toolCards.verbs.editing",
    succeeded: "chat.toolCards.verbs.edited",
    fallback: "chat.toolCards.verbs.edit",
  },
  write: {
    running: "chat.toolCards.verbs.writing",
    succeeded: "chat.toolCards.verbs.wrote",
    fallback: "chat.toolCards.verbs.write",
  },
} as const;

function resolveToolRowVerb(
  kind: ToolCallView["kind"],
  outcome: ToolCardOutcome,
): string | undefined {
  if (kind === "edit" || kind === "write") {
    const keys = MUTATION_VERB_KEYS[kind];
    const key =
      outcome === "running"
        ? keys.running
        : outcome === "succeeded"
          ? keys.succeeded
          : keys.fallback;
    return t(key);
  }
  const key = TOOL_ROW_VERB_KEYS[kind];
  return key ? t(key) : undefined;
}

const TOOL_ROW_ICONS: Partial<Record<ToolCallView["kind"], string>> = {
  command: "terminal",
  read: "fileText",
  edit: "penLine",
  write: "fileCode",
  search: "search",
  fetch: "globe",
};

function firstCommandLine(command: string): string {
  const line = command.split("\n")[0]?.trim() ?? "";
  return truncateUtf16Safe(line, 120);
}

export function renderDiffStatChips(stat: DiffStat) {
  if (stat.added === 0 && stat.removed === 0) {
    return nothing;
  }
  return html`<span class="chat-diffstat">
    ${stat.added > 0 ? html`<span class="chat-diffstat__add">+${stat.added}</span>` : nothing}
    ${stat.removed > 0 ? html`<span class="chat-diffstat__del">-${stat.removed}</span>` : nothing}
  </span>`;
}

function renderToolRowContent(card: ToolCard, view: ToolCallView, outcome: ToolCardOutcome) {
  if (view.kind === "command" && view.command) {
    const commandPreview = firstCommandLine(view.command);
    const aiTitle = getToolCallTitle(card.name, card.args);
    if (aiTitle) {
      return html`
        <span class="chat-tool-row__title">${aiTitle}</span>
        <code class="chat-tool-row__cmd chat-tool-row__cmd--secondary">${commandPreview}</code>
      `;
    }
    return html`
      <span class="chat-tool-row__prompt" aria-hidden="true">$</span>
      <code class="chat-tool-row__cmd">${renderHighlightedCommand(commandPreview)}</code>
    `;
  }

  const verb = resolveToolRowVerb(view.kind, outcome);
  if (verb && view.target) {
    return html`
      <span class="chat-tool-row__verb">${verb}</span>
      <span class="chat-tool-row__target">${view.target}</span>
      ${outcome === "succeeded" && view.stat ? renderDiffStatChips(view.stat) : nothing}
      ${view.targetDetail
        ? html`<span class="chat-tool-row__detail">${view.targetDetail}</span>`
        : nothing}
    `;
  }

  // Generic tools keep the resolver-driven label + detail.
  const display = resolveToolDisplay({ name: card.name, args: card.args, detailMode: "explain" });
  const summary = resolveCollapsedToolSummaryParts({
    card,
    displayLabel: display.label,
    displayDetail: display.detail,
    isError: outcome === "failed",
  });
  const displayLabel = formatCollapsedToolSummaryText(summary.label) ?? summary.label;
  const displayName = formatDistinctCollapsedToolSummaryText(summary.name, displayLabel);
  const aiTitle = getToolCallTitle(card.name, card.args);
  if (aiTitle) {
    return html`
      <span class="chat-tool-row__title">${aiTitle}</span>
      <span class="chat-tool-row__detail">${displayLabel}</span>
    `;
  }
  return html`
    <span class="chat-tool-msg-summary__label">${displayLabel}</span>
    ${displayName
      ? html`<span class="chat-tool-msg-summary__names">${displayName}</span>`
      : nothing}
  `;
}

export function renderDiffBlock(
  lines: readonly DiffLine[],
  outcome: ToolCardOutcome = "succeeded",
) {
  const hasLineNumbers = lines.some((line) => line.lineNo !== undefined);
  return html`
    <div
      class="chat-diff"
      role="figure"
      aria-label=${t(
        outcome === "succeeded" ? "chat.toolCards.fileChanges" : "chat.toolCards.attemptedChanges",
      )}
    >
      ${lines.map((line) => {
        if (line.kind === "skip") {
          return html`<div class="chat-diff__row chat-diff__row--skip">
            ${hasLineNumbers ? html`<span class="chat-diff__gutter"></span>` : nothing}
            <span class="chat-diff__sign"></span>
            <span class="chat-diff__text">⋯</span>
          </div>`;
        }
        const kindClass =
          line.kind === "add"
            ? "chat-diff__row--add"
            : line.kind === "del"
              ? "chat-diff__row--del"
              : line.kind === "file"
                ? "chat-diff__row--file"
                : "";
        const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : "";
        return html`<div class="chat-diff__row ${kindClass}">
          ${hasLineNumbers
            ? html`<span class="chat-diff__gutter">${line.lineNo ?? ""}</span>`
            : nothing}
          <span class="chat-diff__sign">${sign}</span>
          <span class="chat-diff__text">${line.text || " "}</span>
        </div>`;
      })}
    </div>
  `;
}

// ── Command syntax highlighting ──

type CommandToken = { text: string; cls: "name" | "flag" | "str" | "num" | "op" | "plain" | "ws" };

const COMMAND_HIGHLIGHT_MAX_CHARS = 2_000;
const COMMAND_OP_CHARS = new Set(["|", ";", "&", "<", ">"]);

/** Small shell-ish tokenizer for display colors only; never used for execution. */
function tokenizeCommand(command: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let index = 0;
  let expectName = true;
  while (index < command.length) {
    const char = command[index];
    if (/\s/.test(char)) {
      let end = index;
      while (end < command.length && /\s/.test(command[end])) {
        end++;
      }
      tokens.push({ text: command.slice(index, end), cls: "ws" });
      index = end;
      continue;
    }
    if (char === "'" || char === '"') {
      let end = index + 1;
      while (end < command.length && command[end] !== char) {
        end += command[end] === "\\" ? 2 : 1;
      }
      end = Math.min(end + 1, command.length);
      tokens.push({ text: command.slice(index, end), cls: "str" });
      index = end;
      expectName = false;
      continue;
    }
    if (COMMAND_OP_CHARS.has(char)) {
      let end = index;
      while (end < command.length && COMMAND_OP_CHARS.has(command[end])) {
        end++;
      }
      tokens.push({ text: command.slice(index, end), cls: "op" });
      index = end;
      expectName = true;
      continue;
    }
    let end = index;
    while (
      end < command.length &&
      !/\s/.test(command[end]) &&
      !COMMAND_OP_CHARS.has(command[end]) &&
      command[end] !== "'" &&
      command[end] !== '"'
    ) {
      end++;
    }
    const word = command.slice(index, end);
    const cls = expectName
      ? "name"
      : word.startsWith("-")
        ? "flag"
        : /^\d+(?:[.,]\d+)?$/.test(word)
          ? "num"
          : "plain";
    tokens.push({ text: word, cls });
    index = end;
    expectName = false;
  }
  return tokens;
}

export function renderHighlightedCommand(command: string) {
  if (command.length > COMMAND_HIGHLIGHT_MAX_CHARS) {
    return html`${command}`;
  }
  return html`${tokenizeCommand(command).map((token) =>
    token.cls === "ws" || token.cls === "plain"
      ? html`${token.text}`
      : html`<span class="chat-cmd--${token.cls}">${token.text}</span>`,
  )}`;
}

// ── Key-value args display (generic tools) ──

const KV_MAX_KEYS = 12;
const KV_MAX_VALUE_CHARS = 400;

function formatKeyValue(value: unknown): string {
  if (typeof value === "string") {
    return truncateUtf16Safe(value, KV_MAX_VALUE_CHARS);
  }
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return truncateUtf16Safe(JSON.stringify(value), KV_MAX_VALUE_CHARS);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function renderArgsKeyValueList(args: Record<string, unknown>) {
  return html`
    <div class="chat-tool-kv">
      ${Object.entries(args).map(
        ([key, value]) => html`
          <div class="chat-tool-kv__row">
            <span class="chat-tool-kv__key">${key}:</span>
            <span class="chat-tool-kv__value">${formatKeyValue(value)}</span>
          </div>
        `,
      )}
    </div>
  `;
}

function canRenderArgsAsKeyValue(args: unknown): args is Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return false;
  }
  const keys = Object.keys(args as Record<string, unknown>);
  return keys.length > 0 && keys.length <= KV_MAX_KEYS;
}

// Args already represented in the collapsed row / header detail for kinds that
// summarize their primary target; everything else stays auditable on expand.
const ROW_SUMMARIZED_ARG_KEYS: Partial<Record<ToolCallView["kind"], ReadonlySet<string>>> = {
  read: new Set(["path", "file_path", "filePath", "notebook_path"]),
  search: new Set(["pattern", "query", "glob", "path"]),
  fetch: new Set(["url"]),
};

function extraArgsBeyondRowTarget(
  args: unknown,
  kind: ToolCallView["kind"],
): Record<string, unknown> | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }
  const summarized = ROW_SUMMARIZED_ARG_KEYS[kind];
  if (!summarized) {
    return args as Record<string, unknown>;
  }
  const extras = Object.fromEntries(
    Object.entries(args as Record<string, unknown>).filter(([key]) => !summarized.has(key)),
  );
  return Object.keys(extras).length > 0 ? extras : null;
}

function renderTerminalBlock(command: string, output: string | undefined, isError: boolean) {
  return html`
    <div class="chat-tool-term ${isError ? "chat-tool-term--error" : ""}">
      <div class="chat-tool-term__cmd">
        <span class="chat-tool-term__prompt">$</span
        ><code>${renderHighlightedCommand(command)}</code>
      </div>
      ${output?.trim()
        ? html`<pre class="chat-tool-term__out"><code>${output}</code></pre>`
        : nothing}
    </div>
  `;
}

export function resolveCollapsedToolDetail(card: ToolCard, displayDetail: string | undefined) {
  const directDetail = displayDetail?.trim();
  if (directDetail) {
    return displayDetail;
  }
  if (typeof card.args !== "string") {
    return undefined;
  }
  const inputText = card.inputText?.trim() ? card.inputText : card.args;
  return formatCollapsedToolPreviewText(inputText);
}

function resolveCollapsedToolSummaryParts(params: {
  card: ToolCard;
  displayLabel: string;
  displayDetail: string | undefined;
  isError: boolean;
}): { label: string; name?: string } {
  if (params.isError) {
    return { label: t("chat.toolCards.toolError"), name: params.displayLabel };
  }

  const displayDetail = params.displayDetail?.trim();
  if (displayDetail) {
    return { label: params.displayLabel, name: displayDetail };
  }

  return {
    label:
      typeof params.card.args === "string"
        ? (resolveCollapsedToolDetail(params.card, undefined) ?? params.displayLabel)
        : params.displayLabel,
  };
}

export function isRunningToolCard(card: ToolCard, runActive: boolean | undefined): boolean {
  // Only live tool-stream cards can be running; historical transcript calls
  // without results (aborted runs) must stay inert during later runs. The
  // result event ends the running state — partial streamed output does not.
  return resolveToolCardOutcome(card, runActive) === "running";
}

/** Plain-text row label, e.g. for the group header while a tool is running. */
export function resolveToolRowText(card: ToolCard, runActive?: boolean): string {
  const view = resolveToolCallView({ name: card.name, args: card.args, details: card.details });
  if (view.kind === "command" && view.command) {
    return `$ ${firstCommandLine(view.command)}`;
  }
  const verb = resolveToolRowVerb(view.kind, resolveToolCardOutcome(card, runActive));
  if (verb && view.target) {
    return `${verb} ${view.target}`;
  }
  const display = resolveToolDisplay({ name: card.name, args: card.args, detailMode: "explain" });
  return display.label;
}

export function renderToolCard(
  card: ToolCard,
  opts: {
    expanded: boolean;
    onToggleExpanded: (id: string) => void;
    runActive?: boolean;
    sessionKey?: string;
    agentId?: string;
    onOpenSidebar?: (content: SidebarContent) => void;
    canvasPluginSurfaceUrl?: string | null;
    embedSandboxMode?: EmbedSandboxMode;
    allowExternalEmbedUrls?: boolean;
  },
) {
  const view = resolveToolCallView({ name: card.name, args: card.args, details: card.details });
  const display = resolveToolDisplay({ name: card.name, args: card.args, detailMode: "explain" });
  const outcome = resolveToolCardOutcome(card, opts.runActive);
  const isError = outcome === "failed";
  const isRunning = outcome === "running";
  const icon = TOOL_ROW_ICONS[view.kind] ?? display.icon;

  return html`
    <div
      class="chat-tool-msg-collapse chat-tool-msg-collapse--manual ${opts.expanded
        ? "is-open"
        : ""}"
    >
      <button
        class="chat-tool-msg-summary chat-tool-row ${isError
          ? "chat-tool-msg-summary--error"
          : ""} ${isRunning ? "chat-tool-row--running" : ""}"
        type="button"
        aria-expanded=${String(opts.expanded)}
        @click=${(event: MouseEvent) => {
          if (shouldToggleSelectableDisclosure(event)) {
            opts.onToggleExpanded(card.id);
          }
        }}
      >
        <span class="chat-tool-msg-summary__icon">${renderToolIcon(icon)}</span>
        ${renderToolRowContent(card, view, outcome)}
        ${isError
          ? html`<span class="chat-tool-row__badge">${t("chat.toolCards.failed")}</span>`
          : nothing}
        ${isRunning
          ? html`<span
              class="chat-tool-row__spinner"
              aria-label=${t("chat.toolCards.running")}
            ></span>`
          : nothing}
      </button>
      ${opts.expanded
        ? html`
            <div class="chat-tool-msg-body">
              ${renderExpandedToolCardContent(
                card,
                opts.sessionKey,
                opts.onOpenSidebar,
                opts.canvasPluginSurfaceUrl,
                opts.embedSandboxMode ?? "scripts",
                opts.allowExternalEmbedUrls ?? false,
                opts.runActive,
              )}
            </div>
          `
        : nothing}
    </div>
  `;
}

export function renderExpandedToolCardContent(
  card: ToolCard,
  sessionKey?: string,
  onOpenSidebar?: (content: SidebarContent) => void,
  canvasPluginSurfaceUrl?: string | null,
  embedSandboxMode: EmbedSandboxMode = "scripts",
  allowExternalEmbedUrls = false,
  runActive?: boolean,
) {
  const view = resolveToolCallView({ name: card.name, args: card.args, details: card.details });
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  // File/search rows already carry their target; the "with …" connector only
  // reads well for generic tools ("with query …"), not "with from sessions.ts".
  const detail =
    view.kind === "read" || view.kind === "search" || view.kind === "fetch"
      ? display.detail
      : formatToolDetail(display);
  const hasOutput = Boolean(card.outputText?.trim());
  const hasInput = Boolean(card.inputText?.trim());
  const isError = isToolCardError(card);
  const outcome = resolveToolCardOutcome(card, runActive);
  const canOpenSidebar = Boolean(onOpenSidebar);
  const fullMessageRequest = buildToolSidebarFullMessageRequest(card, sessionKey);
  const previewSidebarContent =
    card.preview?.kind === "canvas"
      ? buildPreviewSidebarContent(card.preview, card.outputText, { fullMessageRequest })
      : null;
  const sidebarActionContent =
    previewSidebarContent ??
    buildSidebarContent(buildToolCardSidebarContent(card), {
      fullMessageRequest,
      rawText: card.outputText ?? null,
    });
  const visiblePreview = card.preview
    ? renderToolPreview(card.preview, "chat_tool", {
        onOpenSidebar,
        rawText: card.outputText,
        canvasPluginSurfaceUrl,
        embedSandboxMode,
        allowExternalEmbedUrls,
      })
    : nothing;
  const sidebarAction = canOpenSidebar
    ? html`
        <div class="chat-tool-card__actions">
          <openclaw-tooltip content="Open in the side panel">
            <button
              class="chat-tool-card__action-btn"
              type="button"
              @click=${() => onOpenSidebar?.(sidebarActionContent)}
              aria-label="Open tool details in side panel"
            >
              <span class="chat-tool-card__action-icon">${icons.panelRightOpen}</span>
            </button>
          </openclaw-tooltip>
        </div>
      `
    : nothing;

  // Command calls render terminal-style: `$ command` + raw output. Remaining
  // args (workdir, timeout, env…) stay visible as key-value rows so identical
  // commands in different contexts remain distinguishable in the audit trail.
  if (view.kind === "command" && view.command && !card.preview) {
    const argsRecord =
      card.args && typeof card.args === "object" && !Array.isArray(card.args)
        ? (card.args as Record<string, unknown>)
        : null;
    const extraArgs = Object.fromEntries(
      Object.entries(argsRecord ?? {}).filter(([key]) => key !== "command"),
    );
    return html`
      <div class="chat-tool-card chat-tool-card--flush ${isError ? "chat-tool-card--error" : ""}">
        ${sidebarAction}
        ${renderTerminalBlock(
          view.command,
          card.outputText ?? (isError ? t("chat.toolCards.noOutputFailed") : undefined),
          isError,
        )}
        ${Object.keys(extraArgs).length > 0 ? renderArgsKeyValueList(extraArgs) : nothing}
      </div>
    `;
  }

  // Edits and writes with a resolvable diff render it inline; the raw tool
  // output stays reachable behind the raw-details toggle.
  if ((view.kind === "edit" || view.kind === "write") && view.diff && view.diff.length > 0) {
    return html`
      <div class="chat-tool-card ${isError ? "chat-tool-card--error" : ""}">
        <div class="chat-tool-card__header">
          <div class="chat-tool-card__detail">
            ${view.targetDetail ? `${view.targetDetail}/` : ""}${view.target ?? ""}
          </div>
          ${sidebarAction}
        </div>
        ${renderDiffBlock(view.diff, outcome)}
        ${isError && hasOutput
          ? renderToolDataBlock({ label: t("chat.toolCards.toolError"), text: card.outputText! })
          : hasOutput
            ? renderRawOutputToggle(card.outputText!)
            : nothing}
      </div>
    `;
  }

  // File reads and searches summarize their primary target in the row, so the
  // full args JSON is noise — but any remaining args (filters, limits, request
  // options…) stay visible as key-value rows for auditability.
  const summarizedKind = view.kind === "read" || view.kind === "search" || view.kind === "fetch";
  const inputBlockArgs = summarizedKind
    ? extraArgsBeyondRowTarget(card.args, view.kind)
    : card.args;
  const showInputBlock = hasInput && (!summarizedKind || inputBlockArgs !== null);

  return html`
    <div class="chat-tool-card ${isError ? "chat-tool-card--error" : ""}">
      ${detail || canOpenSidebar
        ? html`
            <div class="chat-tool-card__header">
              ${detail ? html`<div class="chat-tool-card__detail">${detail}</div>` : nothing}
              ${sidebarAction}
            </div>
          `
        : nothing}
      ${showInputBlock
        ? canRenderArgsAsKeyValue(inputBlockArgs)
          ? renderArgsKeyValueList(inputBlockArgs)
          : renderToolDataBlock({
              label: t("chat.toolCards.toolInput"),
              text: card.inputText!,
            })
        : nothing}
      ${hasOutput
        ? card.preview
          ? html`${visiblePreview} ${renderRawOutputToggle(card.outputText!)}`
          : renderToolDataBlock({
              label: t(isError ? "chat.toolCards.toolError" : "chat.toolCards.toolOutput"),
              text: card.outputText!,
            })
        : isError
          ? renderToolDataBlock({
              label: t("chat.toolCards.toolError"),
              text: t("chat.toolCards.noOutputFailed"),
            })
          : nothing}
    </div>
  `;
}
