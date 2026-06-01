import { html, nothing } from "lit";
import { extractCanvasFromText } from "../../../../src/chat/canvas-render.js";
import { t } from "../../i18n/index.ts";
import { resolveCanvasIframeUrl } from "../canvas-url.ts";
import { resolveEmbedSandbox, type EmbedSandboxMode } from "../embed-sandbox.ts";
import { icons } from "../icons.ts";
import type { SidebarContent } from "../sidebar-content.ts";
import { formatToolDetail, resolveToolDisplay } from "../tool-display.ts";
import type { ToolCard } from "../types/chat-types.ts";
import { extractTextCached } from "./message-extract.ts";
import { isToolResultMessage } from "./role-normalizer.ts";
import { formatToolOutputForSidebar, getTruncatedPreview } from "./tool-helpers.ts";

export type ToolPreview = NonNullable<ToolCard["preview"]>;

type FullMessageRequest = NonNullable<SidebarContent["fullMessageRequest"]>;

function resolveCanvasPreviewSandbox(preview: ToolPreview): string {
  return resolveEmbedSandbox(preview.kind === "canvas" ? "scripts" : "scripts");
}

function resolveTranscriptMessageId(message: Record<string, unknown>): string | undefined {
  if (typeof message.messageId === "string" && message.messageId.trim()) {
    return message.messageId;
  }
  const openClawMeta = message["__openclaw"];
  const transcriptMeta =
    openClawMeta && typeof openClawMeta === "object" && !Array.isArray(openClawMeta)
      ? (openClawMeta as Record<string, unknown>)
      : null;
  return typeof transcriptMeta?.id === "string" && transcriptMeta.id.trim()
    ? transcriptMeta.id
    : undefined;
}

function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(
    (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
  );
}

function coerceArgs(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractToolText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === "string") {
    return item.text;
  }
  if (typeof item.content === "string") {
    return item.content;
  }
  if (Array.isArray(item.content)) {
    const parts = item.content.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const text = (entry as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    });
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  return undefined;
}

function readToolErrorFlag(value: Record<string, unknown>): boolean | undefined {
  const raw = value.isError ?? value.is_error;
  return typeof raw === "boolean" ? raw : undefined;
}

const TOOL_NOT_FOUND_PATTERN = /^tool not found\.?$/i;
const MAX_ERROR_DETECT_CHARS = 20_000;
const TOOL_ERROR_STATUSES = new Set(["error", "failed", "timeout"]);

function hasToolErrorStatus(value: unknown): boolean {
  return typeof value === "string" && TOOL_ERROR_STATUSES.has(value.trim().toLowerCase());
}

export function isToolErrorOutput(outputText: string | undefined): boolean {
  if (!outputText) {
    return false;
  }
  const trimmed = outputText.trim();
  if (!trimmed) {
    return false;
  }
  if (TOOL_NOT_FOUND_PATTERN.test(trimmed)) {
    return true;
  }
  if (trimmed.length > MAX_ERROR_DETECT_CHARS) {
    return false;
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const obj = parsed as Record<string, unknown>;
  const explicitErrorFlag = readToolErrorFlag(obj);
  if (explicitErrorFlag !== undefined) {
    return explicitErrorFlag;
  }
  if ("error" in obj) {
    const value = obj.error;
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (value && typeof value === "object") {
      return true;
    }
  }
  return hasToolErrorStatus(obj.status);
}

export function isToolCardError(card: ToolCard): boolean {
  if (card.isError !== undefined) {
    return card.isError;
  }
  return isToolErrorOutput(card.outputText);
}

export function extractToolPreview(
  outputText: string | undefined,
  toolName: string | undefined,
): ToolCard["preview"] | undefined {
  return extractCanvasFromText(outputText, toolName);
}

function resolveToolCardId(
  item: Record<string, unknown>,
  message: Record<string, unknown>,
  index: number,
  prefix = "tool",
): string {
  const explicitId =
    (typeof item.id === "string" && item.id.trim()) ||
    (typeof item.toolCallId === "string" && item.toolCallId.trim()) ||
    (typeof item.tool_call_id === "string" && item.tool_call_id.trim()) ||
    (typeof item.callId === "string" && item.callId.trim()) ||
    (typeof message.toolCallId === "string" && message.toolCallId.trim()) ||
    (typeof message.tool_call_id === "string" && message.tool_call_id.trim()) ||
    "";
  if (explicitId) {
    return `${prefix}:${explicitId}`;
  }
  const name =
    (typeof item.name === "string" && item.name.trim()) ||
    (typeof message.toolName === "string" && message.toolName.trim()) ||
    (typeof message.tool_name === "string" && message.tool_name.trim()) ||
    "tool";
  return `${prefix}:${name}:${index}`;
}

function serializeToolInput(args: unknown): string | undefined {
  if (args === undefined || args === null) {
    return undefined;
  }
  if (typeof args === "string") {
    return args;
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    if (typeof args === "number" || typeof args === "boolean" || typeof args === "bigint") {
      return String(args);
    }
    if (typeof args === "symbol") {
      return args.description ? `Symbol(${args.description})` : "Symbol()";
    }
    return Object.prototype.toString.call(args);
  }
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

export function formatCollapsedToolSummaryText(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return undefined;
  }
  const withoutConnector = normalized.replace(/^with\s+/i, "").trim();
  return withoutConnector || normalized;
}

export function formatCollapsedToolPreviewText(value: string | undefined): string | undefined {
  const normalized = formatCollapsedToolSummaryText(value);
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, 120);
}

function findFirstUnmatchedCard(
  cards: ToolCard[],
  id: string,
  name: string,
  fallbackMatchedCards: WeakSet<ToolCard>,
): ToolCard | undefined {
  let nameOnlyCandidate: ToolCard | undefined;
  for (const card of cards) {
    if (card.id === id) {
      return card;
    }
    if (
      !nameOnlyCandidate &&
      card.name === name &&
      card.outputText === undefined &&
      !fallbackMatchedCards.has(card)
    ) {
      nameOnlyCandidate = card;
    }
  }
  return nameOnlyCandidate;
}

export function extractToolCards(message: unknown, prefix = "tool"): ToolCard[] {
  const m = message as Record<string, unknown>;
  const content = normalizeContent(m.content);
  const messageIsError = readToolErrorFlag(m);
  const cards: ToolCard[] = [];
  const fallbackMatchedCards = new WeakSet<ToolCard>();
  const transcriptMessageId = resolveTranscriptMessageId(m);

  for (let index = 0; index < content.length; index++) {
    const item = content[index] ?? {};
    const kind = (typeof item.type === "string" ? item.type : "").toLowerCase();
    const isToolCall =
      ["toolcall", "tool_call", "tooluse", "tool_use"].includes(kind) ||
      (typeof item.name === "string" &&
        (item.arguments != null || item.args != null || item.input != null));
    if (isToolCall) {
      const args = coerceArgs(item.arguments ?? item.args ?? item.input);
      cards.push({
        id: resolveToolCardId(item, m, index, prefix),
        name: typeof item.name === "string" ? item.name : "tool",
        args,
        inputText: serializeToolInput(args),
        messageId: transcriptMessageId,
      });
      continue;
    }

    if (kind === "toolresult" || kind === "tool_result") {
      const name = typeof item.name === "string" ? item.name : "tool";
      const cardId = resolveToolCardId(item, m, index, prefix);
      const existing = findFirstUnmatchedCard(cards, cardId, name, fallbackMatchedCards);
      const text = extractToolText(item);
      const preview = extractToolPreview(text, name);
      const isError = readToolErrorFlag(item) ?? messageIsError;
      if (existing) {
        fallbackMatchedCards.add(existing);
        existing.outputText = text;
        existing.preview = preview;
        if (isError !== undefined) {
          existing.isError = isError;
        }
        continue;
      }
      cards.push({
        id: cardId,
        name,
        outputText: text,
        messageId: transcriptMessageId,
        ...(isError !== undefined ? { isError } : {}),
        preview,
      });
    }
  }

  const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
  const isStandaloneToolMessage =
    isToolResultMessage(message) ||
    role === "tool" ||
    role === "function" ||
    typeof m.toolName === "string" ||
    typeof m.tool_name === "string";

  if (isStandaloneToolMessage && cards.length === 0) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const text = extractTextCached(message) ?? undefined;
    cards.push({
      id: resolveToolCardId({}, m, 0, prefix),
      name,
      outputText: text,
      messageId: transcriptMessageId,
      ...(messageIsError !== undefined ? { isError: messageIsError } : {}),
      preview: extractToolPreview(text, name),
    });
  }

  return cards;
}

const toolCardsByMessage = new WeakMap<object, Map<string, ToolCard[]>>();

export function extractToolCardsCached(message: unknown, prefix = "tool"): ToolCard[] {
  if (!message || typeof message !== "object") {
    return extractToolCards(message, prefix);
  }
  let byPrefix = toolCardsByMessage.get(message);
  if (!byPrefix) {
    byPrefix = new Map();
    toolCardsByMessage.set(message, byPrefix);
  }
  const cached = byPrefix.get(prefix);
  if (cached) {
    return cached;
  }
  const cards = extractToolCards(message, prefix);
  byPrefix.set(prefix, cards);
  return cards;
}

export function buildToolCardSidebarContent(card: ToolCard): string {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const isError = isToolCardError(card);
  const sections = [`## ${display.label}`, `**Tool:** \`${display.name}\``];

  if (detail) {
    sections.push(`**Summary:** ${detail}`);
  }

  if (card.inputText?.trim()) {
    const inputIsJson = typeof card.args === "object" && card.args !== null;
    sections.push(
      `### Tool input\n${formatPayloadForSidebar(card.inputText, inputIsJson ? "json" : "text")}`,
    );
  }

  if (card.outputText?.trim()) {
    sections.push(
      `### ${isError ? "Tool error" : "Tool output"}\n${formatToolOutputForSidebar(card.outputText)}`,
    );
  } else {
    sections.push(
      isError
        ? "### Tool error\n*No output — tool failed.*"
        : "### Tool output\n*No output — tool completed successfully.*",
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

function renderPreviewFrame(params: {
  title: string;
  src?: string;
  height?: number;
  sandbox?: string;
}) {
  return html`
    <iframe
      class="chat-tool-card__preview-frame"
      title=${params.title}
      sandbox=${params.sandbox ?? ""}
      src=${params.src ?? nothing}
      style=${params.height ? `height:${params.height}px` : ""}
    ></iframe>
  `;
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
          sandbox:
            preview.kind === "canvas"
              ? resolveEmbedSandbox(options?.embedSandboxMode ?? "scripts")
              : resolveCanvasPreviewSandbox(preview),
        })}
      </div>
    </div>
  `;
}

export function buildSidebarContent(
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
        <span>Raw details</span>
        <span class="chat-tool-card__raw-toggle-icon">${icons.chevronDown}</span>
      </button>
      <div class="chat-tool-card__raw-body" hidden>
        ${renderToolDataBlock({
          label: "Tool output",
          text,
          expanded: true,
        })}
      </div>
    </div>
  `;
}

function renderToolDataBlock(params: {
  label: string;
  text: string;
  expanded: boolean;
  empty?: boolean;
}) {
  const { label, text, expanded, empty } = params;
  return html`
    <div class="chat-tool-card__block ${expanded ? "chat-tool-card__block--expanded" : ""}">
      <div class="chat-tool-card__block-header">
        <span class="chat-tool-card__block-icon">${icons.zap}</span>
        <span class="chat-tool-card__block-label">${label}</span>
      </div>
      ${empty
        ? html`<div class="chat-tool-card__block-empty muted">${text}</div>`
        : expanded
          ? html`<pre class="chat-tool-card__block-content"><code>${text}</code></pre>`
          : html`<div class="chat-tool-card__block-preview mono">
              ${getTruncatedPreview(text)}
            </div>`}
    </div>
  `;
}

function renderCollapsedToolSummary(params: {
  label: string;
  icon: ReturnType<typeof html> | undefined;
  name?: string;
  expanded: boolean;
  isError?: boolean;
  onToggleExpanded: () => void;
}) {
  const { label, icon, name, expanded, isError, onToggleExpanded } = params;
  const displayLabel = formatCollapsedToolSummaryText(label) ?? label;
  const displayName = formatCollapsedToolSummaryText(name);
  return html`
    <button
      class="chat-tool-msg-summary ${isError ? "chat-tool-msg-summary--error" : ""}"
      type="button"
      aria-expanded=${String(expanded)}
      @click=${() => onToggleExpanded()}
    >
      <span class="chat-tool-msg-summary__icon">${icon}</span>
      <span class="chat-tool-msg-summary__label">${displayLabel}</span>
      ${displayName
        ? html`<span class="chat-tool-msg-summary__names">${displayName}</span>`
        : nothing}
      ${isError
        ? html`<span class="chat-tool-msg-summary__error-badge" aria-label="Tool returned an error"
            >${icons.x}<span>Error</span></span
          >`
        : nothing}
    </button>
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

export function resolveCollapsedToolSummaryParts(params: {
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

export function renderToolCard(
  card: ToolCard,
  opts: {
    expanded: boolean;
    onToggleExpanded: (id: string) => void;
    sessionKey?: string;
    agentId?: string;
    onOpenSidebar?: (content: SidebarContent) => void;
    canvasPluginSurfaceUrl?: string | null;
    embedSandboxMode?: EmbedSandboxMode;
    allowExternalEmbedUrls?: boolean;
  },
) {
  const display = resolveToolDisplay({ name: card.name, args: card.args, detailMode: "explain" });
  const isError = isToolCardError(card);
  const summary = resolveCollapsedToolSummaryParts({
    card,
    displayLabel: display.label,
    displayDetail: display.detail,
    isError,
  });

  return html`
    <div
      class="chat-tool-msg-collapse chat-tool-msg-collapse--manual ${opts.expanded
        ? "is-open"
        : ""}"
    >
      ${renderCollapsedToolSummary({
        label: summary.label,
        icon: icons[display.icon],
        name: summary.name,
        expanded: opts.expanded,
        isError,
        onToggleExpanded: () => opts.onToggleExpanded(card.id),
      })}
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
) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const hasOutput = Boolean(card.outputText?.trim());
  const hasInput = Boolean(card.inputText?.trim());
  const isError = isToolCardError(card);
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

  return html`
    <div class="chat-tool-card chat-tool-card--expanded ${isError ? "chat-tool-card--error" : ""}">
      <div class="chat-tool-card__header">
        <div class="chat-tool-card__title">
          <span class="chat-tool-card__icon">${icons[display.icon]}</span>
          <span>${display.label}</span>
          ${isError
            ? html`<span class="chat-tool-card__status-badge" role="status"
                >${icons.x}<span>Error</span></span
              >`
            : nothing}
        </div>
        ${canOpenSidebar
          ? html`
              <div class="chat-tool-card__actions">
                <button
                  class="chat-tool-card__action-btn"
                  type="button"
                  @click=${() => onOpenSidebar?.(sidebarActionContent)}
                  title="Open in the side panel"
                  aria-label="Open tool details in side panel"
                >
                  <span class="chat-tool-card__action-icon">${icons.panelRightOpen}</span>
                </button>
              </div>
            `
          : nothing}
      </div>
      ${detail ? html`<div class="chat-tool-card__detail">${detail}</div>` : nothing}
      ${hasInput
        ? renderToolDataBlock({
            label: "Tool input",
            text: card.inputText!,
            expanded: true,
          })
        : nothing}
      ${hasOutput
        ? card.preview
          ? html`${visiblePreview} ${renderRawOutputToggle(card.outputText!)}`
          : renderToolDataBlock({
              label: isError ? "Tool error" : "Tool output",
              text: card.outputText!,
              expanded: true,
            })
        : nothing}
    </div>
  `;
}

export function renderToolCardSidebar(
  card: ToolCard,
  onOpenSidebar?: (content: SidebarContent) => void,
  canvasPluginSurfaceUrl?: string | null,
  embedSandboxMode: EmbedSandboxMode = "scripts",
  options?: { sessionKey?: string; agentId?: string },
) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const preview = card.preview;
  const hasText = Boolean(card.outputText?.trim());
  const hasPreview = Boolean(preview);
  const isError = isToolCardError(card);
  const fullMessageRequest = buildToolSidebarFullMessageRequest(card, options?.sessionKey);
  const sidebarContent =
    preview?.kind === "canvas"
      ? buildPreviewSidebarContent(preview, card.outputText, { fullMessageRequest })
      : buildSidebarContent(buildToolCardSidebarContent(card), {
          fullMessageRequest,
          rawText: card.outputText ?? null,
        });
  const actionContent =
    sidebarContent ??
    buildSidebarContent(buildToolCardSidebarContent(card), {
      fullMessageRequest,
      rawText: card.outputText ?? null,
    });
  const canClick = Boolean(onOpenSidebar);
  const handleClick = canClick ? () => onOpenSidebar?.(actionContent) : undefined;
  const isShort = hasText && !hasPreview && (card.outputText?.length ?? 0) <= 240;
  const showCollapsed = hasText && !hasPreview && !isShort;
  const showInline = hasText && !hasPreview && isShort;
  const isEmpty = !hasText && !hasPreview;
  const statusIcon = isError ? icons.x : icons.check;

  return html`
    <div
      class="chat-tool-card ${canClick ? "chat-tool-card--clickable" : ""} ${isError
        ? "chat-tool-card--error"
        : ""}"
      @click=${handleClick}
      role=${canClick ? "button" : nothing}
      tabindex=${canClick ? "0" : nothing}
      @keydown=${canClick
        ? (e: KeyboardEvent) => {
            if (e.key !== "Enter" && e.key !== " ") {
              return;
            }
            e.preventDefault();
            handleClick?.();
          }
        : nothing}
    >
      <div class="chat-tool-card__header">
        <div class="chat-tool-card__title">
          <span class="chat-tool-card__icon">${icons[display.icon]}</span>
          <span>${display.label}</span>
        </div>
        ${canClick
          ? html`<span
              class="chat-tool-card__action ${isError ? "chat-tool-card__action--error" : ""}"
              >${isError ? "View error" : hasText || hasPreview ? "View" : ""} ${statusIcon}</span
            >`
          : nothing}
        ${isEmpty && !canClick
          ? html`<span
              class="chat-tool-card__status ${isError ? "chat-tool-card__status--error" : ""}"
              >${statusIcon}</span
            >`
          : nothing}
      </div>
      ${detail ? html`<div class="chat-tool-card__detail">${detail}</div>` : nothing}
      ${isEmpty
        ? html`<div
            class="chat-tool-card__status-text ${isError
              ? "chat-tool-card__status-text--error"
              : "muted"}"
          >
            ${isError ? "Failed" : "Completed"}
          </div>`
        : nothing}
      ${preview
        ? html`${renderToolPreview(preview, "chat_tool", {
            onOpenSidebar,
            rawText: card.outputText,
            canvasPluginSurfaceUrl,
            embedSandboxMode,
          })}`
        : nothing}
      ${showCollapsed
        ? html`<div class="chat-tool-card__preview mono">
            ${getTruncatedPreview(card.outputText!)}
          </div>`
        : nothing}
      ${showInline
        ? html`<div class="chat-tool-card__inline mono">${card.outputText}</div>`
        : nothing}
    </div>
  `;
}
