import { html, nothing } from "lit";
import { extractCanvasFromText } from "../../../../src/chat/canvas-render.js";
import { resolveCanvasIframeUrl } from "../canvas-url.ts";
import { resolveEmbedSandbox, type EmbedSandboxMode } from "../embed-sandbox.ts";
import { icons } from "../icons.ts";
import type { SidebarContent } from "../sidebar-content.ts";
import { formatToolDetail, resolveToolDisplay } from "../tool-display.ts";
import type { ToolCard } from "../types/chat-types.ts";
import { extractTextCached } from "./message-extract.ts";
import { isToolResultMessage } from "./message-normalizer.ts";
import { formatToolOutputForSidebar, getTruncatedPreview } from "./tool-helpers.ts";

export type ToolPreview = NonNullable<ToolCard["preview"]>;

function resolveCanvasPreviewSandbox(preview: ToolPreview): string {
  return resolveEmbedSandbox(preview.kind === "canvas" ? "scripts" : "scripts");
}

function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(Boolean) as Array<Record<string, unknown>>;
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
  return undefined;
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

function findLatestCard(cards: ToolCard[], id: string, name: string): ToolCard | undefined {
  for (let i = cards.length - 1; i >= 0; i--) {
    const card = cards[i];
    if (!card) {
      continue;
    }
    if (card.id === id || (card.name === name && !card.outputText)) {
      return card;
    }
  }
  return undefined;
}

export function extractToolCards(message: unknown, prefix = "tool"): ToolCard[] {
  const m = message as Record<string, unknown>;
  const content = normalizeContent(m.content);
  const cards: ToolCard[] = [];

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
        name: (item.name as string) ?? "tool",
        args,
        inputText: serializeToolInput(args),
      });
      continue;
    }

    if (kind === "toolresult" || kind === "tool_result") {
      const name = typeof item.name === "string" ? item.name : "tool";
      const cardId = resolveToolCardId(item, m, index, prefix);
      const existing = findLatestCard(cards, cardId, name);
      const text = extractToolText(item);
      const preview = extractToolPreview(text, name);
      if (existing) {
        existing.outputText = text;
        existing.preview = preview;
        continue;
      }
      cards.push({
        id: cardId,
        name,
        outputText: text,
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
      preview: extractToolPreview(text, name),
    });
  }

  return cards;
}

export function buildToolCardSidebarContent(card: ToolCard): string {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
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
    sections.push(`### Tool output\n${formatToolOutputForSidebar(card.outputText)}`);
  } else {
    sections.push(`### Tool output\n*No output — tool completed successfully.*`);
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
    canvasHostUrl?: string | null;
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
            options?.canvasHostUrl,
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

export function buildSidebarContent(value: string): SidebarContent {
  return {
    kind: "markdown",
    content: value,
  };
}

export function buildPreviewSidebarContent(
  preview: ToolPreview,
  rawText?: string | null,
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
  };
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
  name: string;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const { label, name, expanded, onToggleExpanded } = params;
  return html`
    <button
      class="chat-tool-msg-summary"
      type="button"
      aria-expanded=${String(expanded)}
      @click=${() => onToggleExpanded()}
    >
      <span class="chat-tool-msg-summary__icon">${icons.zap}</span>
      <span class="chat-tool-msg-summary__label">${label}</span>
      <span class="chat-tool-msg-summary__names">${name}</span>
    </button>
  `;
}

export function renderToolCard(
  card: ToolCard,
  opts: {
    expanded: boolean;
    onToggleExpanded: (id: string) => void;
    onOpenSidebar?: (content: SidebarContent) => void;
    canvasHostUrl?: string | null;
    embedSandboxMode?: EmbedSandboxMode;
    allowExternalEmbedUrls?: boolean;
  },
) {
  const hasOutput = Boolean(card.outputText?.trim());
  const previewLabel = hasOutput ? "Tool output" : "Tool call";

  return html`
    <div
      class="chat-tool-msg-collapse chat-tool-msg-collapse--manual ${opts.expanded
        ? "is-open"
        : ""}"
    >
      ${renderCollapsedToolSummary({
        label: previewLabel,
        name: card.name,
        expanded: opts.expanded,
        onToggleExpanded: () => opts.onToggleExpanded(card.id),
      })}
      ${opts.expanded
        ? html`
            <div class="chat-tool-msg-body">
              ${renderExpandedToolCardContent(
                card,
                opts.onOpenSidebar,
                opts.canvasHostUrl,
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
  onOpenSidebar?: (content: SidebarContent) => void,
  canvasHostUrl?: string | null,
  embedSandboxMode: EmbedSandboxMode = "scripts",
  allowExternalEmbedUrls = false,
) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const hasOutput = Boolean(card.outputText?.trim());
  const hasInput = Boolean(card.inputText?.trim());
  const canOpenSidebar = Boolean(onOpenSidebar);
  const previewSidebarContent =
    card.preview?.kind === "canvas"
      ? buildPreviewSidebarContent(card.preview, card.outputText)
      : null;
  const sidebarActionContent =
    previewSidebarContent ?? buildSidebarContent(buildToolCardSidebarContent(card));
  const visiblePreview = card.preview
    ? renderToolPreview(card.preview, "chat_tool", {
        onOpenSidebar,
        rawText: card.outputText,
        canvasHostUrl,
        embedSandboxMode,
        allowExternalEmbedUrls,
      })
    : nothing;

  return html`
    <div class="chat-tool-card chat-tool-card--expanded">
      <div class="chat-tool-card__header">
        <div class="chat-tool-card__title">
          <span class="chat-tool-card__icon">${icons[display.icon]}</span>
          <span>${display.label}</span>
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
              label: "Tool output",
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
  canvasHostUrl?: string | null,
  embedSandboxMode: EmbedSandboxMode = "scripts",
) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const preview = card.preview;
  const hasText = Boolean(card.outputText?.trim());
  const hasPreview = Boolean(preview);
  const sidebarContent =
    preview?.kind === "canvas"
      ? buildPreviewSidebarContent(preview, card.outputText)
      : buildSidebarContent(buildToolCardSidebarContent(card));
  const actionContent = sidebarContent ?? buildSidebarContent(buildToolCardSidebarContent(card));
  const canClick = Boolean(onOpenSidebar);
  const handleClick = canClick ? () => onOpenSidebar?.(actionContent) : undefined;
  const isShort = hasText && !hasPreview && (card.outputText?.length ?? 0) <= 240;
  const showCollapsed = hasText && !hasPreview && !isShort;
  const showInline = hasText && !hasPreview && isShort;
  const isEmpty = !hasText && !hasPreview;

  return html`
    <div
      class="chat-tool-card ${canClick ? "chat-tool-card--clickable" : ""}"
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
          ? html`<span class="chat-tool-card__action"
              >${hasText || hasPreview ? "View" : ""} ${icons.check}</span
            >`
          : nothing}
        ${isEmpty && !canClick
          ? html`<span class="chat-tool-card__status">${icons.check}</span>`
          : nothing}
      </div>
      ${detail ? html`<div class="chat-tool-card__detail">${detail}</div>` : nothing}
      ${isEmpty ? html`<div class="chat-tool-card__status-text muted">Completed</div>` : nothing}
      ${preview
        ? html`${renderToolPreview(preview, "chat_tool", {
            onOpenSidebar,
            rawText: card.outputText,
            canvasHostUrl,
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
