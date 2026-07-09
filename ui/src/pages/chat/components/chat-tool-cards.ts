// Control UI chat module implements tool cards behavior.
import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { icons, type IconName } from "../../../components/icons.ts";
import { isMarkdownBlockArtText } from "../../../components/markdown.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import {
  formatDistinctCollapsedToolSummaryText,
  formatCollapsedToolPreviewText,
  formatCollapsedToolSummaryText,
  isToolCardError,
  type ToolPreview,
} from "../../../lib/chat/tool-cards.ts";
import {
  formatToolDetail,
  resolveCanvasIframeUrl,
  resolveEmbedSandbox,
  resolveToolDisplay,
  type EmbedSandboxMode,
} from "../../../lib/chat/tool-display.ts";
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
        <span>Raw details</span>
        <span class="chat-tool-card__raw-toggle-icon">${icons.chevronDown}</span>
      </button>
      <div class="chat-tool-card__raw-body" hidden>
        ${renderToolDataBlock({ label: "Tool output", text })}
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
  const displayName = formatDistinctCollapsedToolSummaryText(name, displayLabel);
  return html`
    <button
      class="chat-tool-msg-summary ${isError ? "chat-tool-msg-summary--error" : ""}"
      type="button"
      aria-expanded=${String(expanded)}
      @click=${(event: MouseEvent) => {
        if (shouldToggleSelectableDisclosure(event)) {
          onToggleExpanded();
        }
      }}
    >
      <span class="chat-tool-msg-summary__icon">${icon}</span>
      <span class="chat-tool-msg-summary__label">${displayLabel}</span>
      ${displayName
        ? html`<span class="chat-tool-msg-summary__names">${displayName}</span>`
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

export function renderToolCard(
  card: ToolCard,
  opts: {
    expanded: boolean;
    onToggleExpanded: (id: string) => void;
    turnSucceeded?: boolean;
    sessionKey?: string;
    agentId?: string;
    onOpenSidebar?: (content: SidebarContent) => void;
    canvasPluginSurfaceUrl?: string | null;
    embedSandboxMode?: EmbedSandboxMode;
    allowExternalEmbedUrls?: boolean;
  },
) {
  const display = resolveToolDisplay({ name: card.name, args: card.args, detailMode: "explain" });
  const isError = isToolCardError(card) && opts.turnSucceeded !== true;
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
        icon: renderToolIcon(display.icon),
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
    <div class="chat-tool-card ${isError ? "chat-tool-card--error" : ""}">
      ${detail || canOpenSidebar
        ? html`
            <div class="chat-tool-card__header">
              ${detail ? html`<div class="chat-tool-card__detail">${detail}</div>` : nothing}
              ${canOpenSidebar
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
                : nothing}
            </div>
          `
        : nothing}
      ${hasInput
        ? renderToolDataBlock({
            label: "Tool input",
            text: card.inputText!,
          })
        : nothing}
      ${hasOutput
        ? card.preview
          ? html`${visiblePreview} ${renderRawOutputToggle(card.outputText!)}`
          : renderToolDataBlock({
              label: isError ? "Tool error" : "Tool output",
              text: card.outputText!,
            })
        : isError
          ? renderToolDataBlock({
              label: "Tool error",
              text: "No output — tool failed.",
            })
          : nothing}
    </div>
  `;
}
