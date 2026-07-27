import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons, type IconName } from "../../../components/icons.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.ts";
import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import type { BoardProvider } from "../../../lib/board/provider.ts";
import type {
  MessageContentItem,
  NormalizedMessage,
  ToolCard,
} from "../../../lib/chat/chat-types.ts";
import {
  extractThinkingCached,
  formatReasoningMarkdown,
} from "../../../lib/chat/message-extract.ts";
import {
  isStandaloneToolMessageForDisplay,
  normalizeMessage,
  normalizeRoleForGrouping,
} from "../../../lib/chat/message-normalizer.ts";
import {
  extractToolCardsCached,
  formatDistinctCollapsedToolSummaryText,
  formatCollapsedToolPreviewText,
  formatCollapsedToolSummaryText,
  isToolCardError,
} from "../../../lib/chat/tool-cards.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import { resolveToolDisplay } from "../../../lib/chat/tool-display.ts";
import {
  visibleWorkspaceConflictPaths,
  workspaceConflictCount,
  workspaceConflictPathForDisplay,
  workspaceResultConflictFromTranscript,
  type WorkspaceResultConflict,
} from "../workspace-conflict.ts";
import { renderAssistantAttachments } from "./chat-message-attachments.ts";
import { renderMessageImages, resolveRenderableMessageImages } from "./chat-message-images.ts";
import {
  detectJson,
  jsonSummaryLabel,
  renderMarkdownText,
  renderUserMessageMarkdown,
  resolveNormalizedMessageMarkdown,
} from "./chat-message-markdown.ts";
import {
  extractImages,
  extractPairingQrExpiryNotices,
  extractTranscriptAttachments,
  schedulePairingQrExpiryRefresh,
  type AttachmentItem,
  type PairingQrExpiryNotice,
} from "./chat-message-media.ts";
import type { SidebarContent } from "./chat-sidebar.ts";
import {
  renderExpandedToolCardContent,
  renderRawOutputToggle,
  renderToolCard,
  renderToolPreview,
  resolveCollapsedToolDetail,
  shouldToggleSelectableDisclosure,
} from "./chat-tool-cards.ts";

function renderChatIcon(name: string) {
  return icons[name as IconName] ?? icons.zap;
}

function renderInlineToolCards(
  toolCards: ToolCard[],
  opts: {
    messageKey: string;
    sessionKey?: string;
    agentId?: string;
    onOpenSidebar?: (content: SidebarContent) => void;
    onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
    isToolExpanded?: (toolCardId: string) => boolean;
    onToggleToolExpanded?: (toolCardId: string) => void;
    runActive?: boolean;
    canvasPluginSurfaceUrl?: string | null;
    embedSandboxMode?: EmbedSandboxMode;
    allowExternalEmbedUrls?: boolean;
  },
) {
  return html`
    <div class="chat-tools-inline">
      ${toolCards.map((card, index) =>
        renderToolCard(card, {
          expanded: opts.isToolExpanded?.(`${opts.messageKey}:toolcard:${index}`) ?? false,
          runActive: opts.runActive,
          onToggleExpanded: opts.onToggleToolExpanded
            ? () => opts.onToggleToolExpanded?.(`${opts.messageKey}:toolcard:${index}`)
            : () => undefined,
          sessionKey: opts.sessionKey,
          agentId: opts.agentId,
          onOpenSidebar: opts.onOpenSidebar,
          onOpenWorkspaceFile: opts.onOpenWorkspaceFile,
          canvasPluginSurfaceUrl: opts.canvasPluginSurfaceUrl,
          embedSandboxMode: opts.embedSandboxMode ?? "scripts",
          allowExternalEmbedUrls: opts.allowExternalEmbedUrls ?? false,
        }),
      )}
    </div>
  `;
}

/**
 * Max characters for auto-detecting and pretty-printing JSON.
 * Prevents DoS from large JSON payloads in assistant/tool messages.
 */
function renderReplyPill(replyTarget: NormalizedMessage["replyTarget"]) {
  if (!replyTarget) {
    return nothing;
  }
  return html`
    <div class="chat-reply-pill">
      <span class="chat-reply-pill__icon">${icons.messageSquare}</span>
      <span class="chat-reply-pill__label">
        ${replyTarget.kind === "current"
          ? "Replying to current message"
          : `Replying to ${replyTarget.id}`}
      </span>
    </div>
  `;
}

function renderPairingQrExpiryNotices(notices: PairingQrExpiryNotice[]) {
  if (notices.length === 0) {
    return nothing;
  }
  return html`
    <div class="chat-pairing-qr-notices">
      ${notices.map(
        (notice) => html`
          <div
            class="chat-assistant-attachment-card chat-assistant-attachment-card--blocked chat-pairing-qr-expired"
          >
            <div class="chat-assistant-attachment-card__header">
              <span class="chat-assistant-attachment-card__icon">${icons.alertTriangle}</span>
              <span class="chat-assistant-attachment-card__title">${notice.title}</span>
              <span class="chat-assistant-attachment-badge chat-assistant-attachment-badge--muted"
                >${t("chat.pairingQrExpired.badge")}</span
              >
            </div>
            <div class="chat-assistant-attachment-card__reason">${notice.reason}</div>
          </div>
        `,
      )}
    </div>
  `;
}

export function renderGroupedMessage(
  message: unknown,
  messageKey: string,
  opts: {
    isStreaming: boolean;
    sessionKey?: string;
    boardProvider?: BoardProvider;
    agentId?: string;
    duplicateCount?: number;
    showReasoning: boolean;
    showToolCalls?: boolean;
    runActive?: boolean;
    turnSucceeded?: boolean;
    autoExpandToolCalls?: boolean;
    isToolMessageExpanded?: (messageId: string) => boolean | undefined;
    onToggleToolMessageExpanded?: (messageId: string, expanded?: boolean) => void;
    isUserMessageExpanded?: (messageId: string) => boolean;
    onToggleUserMessageExpanded?: (messageId: string) => void;
    isToolExpanded?: (toolCardId: string) => boolean;
    onToggleToolExpanded?: (toolCardId: string) => void;
    onRequestUpdate?: () => void;
    canvasPluginSurfaceUrl?: string | null;
    basePath?: string;
    localMediaPreviewRoots?: readonly string[];
    assistantAttachmentAuthToken?: string | null;
    onAssistantAttachmentLoaded?: () => void;
    onRequestOpenImage?: () => number;
    onOpenImage?: (item: ImageLightboxItem, requestVersion?: number) => void;
    embedSandboxMode?: EmbedSandboxMode;
    allowExternalEmbedUrls?: boolean;
    onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
    entryId?: string;
    /** Freshly submitted user turn: play the one-shot composer entry animation. */
    entryAnimated?: boolean;
  },
  onOpenSidebar?: (content: SidebarContent) => void,
) {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const sourceRole = normalizeRoleForGrouping(role);
  const normalizedMessage = normalizeMessage(message);
  const normalizedRole = normalizeRoleForGrouping(normalizedMessage.role);
  const workspaceConflict = workspaceResultConflictFromTranscript(message);
  if (workspaceConflict) {
    return renderWorkspaceConflictTranscriptMessage(workspaceConflict, messageKey, opts.entryId);
  }
  const isToolShell = normalizedRole === "tool";
  const isStandaloneToolMessage = isStandaloneToolMessageForDisplay(message);

  const toolCards = (opts.showToolCalls ?? true) ? extractToolCardsCached(message, messageKey) : [];
  const hasToolCards = toolCards.length > 0;
  const imageRenderOptions = {
    localMediaPreviewRoots: opts.localMediaPreviewRoots ?? [],
    basePath: opts.basePath,
    authToken: opts.assistantAttachmentAuthToken,
    onRequestUpdate: opts.onRequestUpdate,
    onRequestOpenImage: opts.onRequestOpenImage,
    onOpenImage: opts.onOpenImage,
  };
  schedulePairingQrExpiryRefresh(messageKey, message, opts.onRequestUpdate);
  const images = resolveRenderableMessageImages(extractImages(message), imageRenderOptions);
  const hasImages = images.length > 0;
  const pairingQrExpiryNotices = extractPairingQrExpiryNotices(message);
  const hasPairingQrExpiryNotices = pairingQrExpiryNotices.length > 0;

  const extractedText = resolveNormalizedMessageMarkdown(normalizedMessage);
  const assistantAttachments = normalizedMessage.content.filter(
    (item): item is AttachmentItem => item.type === "attachment",
  );
  const visibleAttachments = [...assistantAttachments, ...extractTranscriptAttachments(message)];
  const assistantViewBlocks = normalizedMessage.content.filter(
    (item): item is Extract<MessageContentItem, { type: "canvas" }> => item.type === "canvas",
  );
  const extractedThinking =
    opts.showReasoning && role === "assistant" ? extractThinkingCached(message) : null;
  const reasoningMarkdown = extractedThinking ? formatReasoningMarkdown(extractedThinking) : null;
  const markdown = extractedText?.trim() ? extractedText : null;
  const markdownRenderOptions: MarkdownRenderOptions = {
    assistantTranscriptRoleHeaders: role === "assistant",
    codeBlockChrome: role === "user" ? "none" : "copy",
    fileLinks: true,
    interactiveImages: opts.onOpenImage !== undefined,
  };

  // Detect pure-JSON messages and render as collapsible block
  const jsonResult = markdown && !opts.isStreaming ? detectJson(markdown) : null;

  const bubbleClasses = [
    "chat-bubble",
    isToolShell ? "chat-bubble--tool-shell" : "",
    opts.isStreaming ? "streaming" : "",
    opts.entryAnimated ? "chat-bubble--user-turn-enter" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Suppress empty bubbles when tool cards are the only content and toggle is off
  const visibleToolCards = hasToolCards && (opts.showToolCalls ?? true);
  if (
    !markdown &&
    !visibleToolCards &&
    !hasImages &&
    !hasPairingQrExpiryNotices &&
    visibleAttachments.length === 0 &&
    assistantViewBlocks.length === 0 &&
    !normalizedMessage.replyTarget
  ) {
    return nothing;
  }

  const toolMessageDisclosureId = `toolmsg:${messageKey}`;
  const toolMessageExpanded = opts.isToolMessageExpanded?.(toolMessageDisclosureId) ?? false;
  const toolNames = [...new Set(toolCards.map((c) => c.name))];
  const singleToolCard = toolCards.length === 1 ? toolCards[0] : null;
  const toolMessageHasError = toolCards.some(isToolCardError) && opts.turnSucceeded !== true;
  const singleToolDisplay = singleToolCard
    ? resolveToolDisplay({
        name: singleToolCard.name,
        args: singleToolCard.args,
        detailMode: "explain",
      })
    : null;
  const singleToolDisplayDetail =
    !toolMessageHasError && singleToolCard && singleToolDisplay
      ? resolveCollapsedToolDetail(singleToolCard, singleToolDisplay.detail)
      : undefined;
  const toolSummaryLabelRaw = toolMessageHasError
    ? singleToolDisplay
      ? singleToolDisplay.label
      : toolNames.length <= 3
        ? toolNames.join(", ")
        : `${toolNames.slice(0, 2).join(", ")} +${toolNames.length - 2} more`
    : singleToolDisplayDetail
      ? !markdown && !hasImages
        ? singleToolDisplayDetail
        : singleToolCard?.outputText?.trim()
          ? "output"
          : undefined
      : toolNames.length <= 3
        ? toolNames.join(", ")
        : `${toolNames.slice(0, 2).join(", ")} +${toolNames.length - 2} more`;
  const toolPreview = markdown ? (formatCollapsedToolPreviewText(markdown) ?? "") : "";
  const toolMessageLabelRaw = toolMessageHasError
    ? t("chat.toolCards.toolError")
    : singleToolDisplay && !markdown && !hasImages
      ? singleToolDisplay.label
      : t("chat.toolCards.toolOutput");
  const toolMessageLabel =
    formatCollapsedToolSummaryText(toolMessageLabelRaw) ?? toolMessageLabelRaw;
  const toolSummaryLabel = formatDistinctCollapsedToolSummaryText(
    toolSummaryLabelRaw,
    toolMessageLabel,
  );
  const toolMessageIcon = singleToolDisplay ? renderChatIcon(singleToolDisplay.icon) : icons.zap;
  const assistantViewContent =
    sourceRole === "assistant" && assistantViewBlocks.length > 0
      ? html`${assistantViewBlocks.map(
          (block) => html`${renderToolPreview(block.preview, "chat_message", {
            onOpenSidebar,
            rawText: block.rawText ?? null,
            canvasPluginSurfaceUrl: opts.canvasPluginSurfaceUrl,
            boardProvider: opts.boardProvider,
            embedSandboxMode: opts.embedSandboxMode ?? "scripts",
            sessionKey: opts.sessionKey,
          })}
          ${block.rawText ? renderRawOutputToggle(block.rawText) : nothing}`,
        )}`
      : nothing;

  const duplicateCount = Math.max(1, Math.floor(opts.duplicateCount ?? 1));

  // Pure tool messages (no text/images/attachments) skip the "Tool output"
  // shell and render as flat kind-aware rows, one disclosure level deep.
  const onlyToolCards =
    isStandaloneToolMessage &&
    hasToolCards &&
    !markdown &&
    !hasImages &&
    !hasPairingQrExpiryNotices &&
    visibleAttachments.length === 0 &&
    assistantViewBlocks.length === 0 &&
    !reasoningMarkdown;

  if (onlyToolCards) {
    return html`
      <div
        class="${bubbleClasses}"
        data-message-id=${messageKey}
        data-entry-id=${opts.entryId || nothing}
        data-message-text=${extractedText || nothing}
      >
        ${renderReplyPill(normalizedMessage.replyTarget)}
        ${renderInlineToolCards(toolCards, {
          messageKey,
          sessionKey: opts.sessionKey,
          agentId: opts.agentId,
          onOpenSidebar,
          onOpenWorkspaceFile: opts.onOpenWorkspaceFile,
          isToolExpanded: opts.isToolExpanded,
          onToggleToolExpanded: opts.onToggleToolExpanded,
          runActive: opts.runActive,
          canvasPluginSurfaceUrl: opts.canvasPluginSurfaceUrl,
          embedSandboxMode: opts.embedSandboxMode ?? "scripts",
          allowExternalEmbedUrls: opts.allowExternalEmbedUrls ?? false,
        })}
        ${duplicateCount > 1
          ? html`<div
              class="chat-duplicate-count"
              aria-label=${`${duplicateCount} consecutive identical messages collapsed`}
            >
              ×${duplicateCount}
            </div>`
          : nothing}
      </div>
    `;
  }

  return html`
    <div
      class="${bubbleClasses}"
      data-message-id=${messageKey}
      data-entry-id=${opts.entryId || nothing}
      data-message-text=${extractedText || nothing}
    >
      ${renderReplyPill(normalizedMessage.replyTarget)}
      ${isStandaloneToolMessage
        ? html`
            <div
              class="chat-tool-msg-collapse chat-tool-msg-collapse--manual ${toolMessageExpanded
                ? "is-open"
                : ""}"
            >
              <button
                class="chat-tool-msg-summary ${toolMessageHasError
                  ? "chat-tool-msg-summary--error"
                  : ""}"
                type="button"
                aria-expanded=${String(toolMessageExpanded)}
                @click=${(event: MouseEvent) => {
                  if (shouldToggleSelectableDisclosure(event)) {
                    opts.onToggleToolMessageExpanded?.(toolMessageDisclosureId);
                  }
                }}
              >
                <span class="chat-tool-msg-summary__icon">${toolMessageIcon}</span>
                <span class="chat-tool-msg-summary__label">${toolMessageLabel}</span>
                ${toolSummaryLabel
                  ? html`<span class="chat-tool-msg-summary__names">${toolSummaryLabel}</span>`
                  : toolPreview
                    ? html`<span class="chat-tool-msg-summary__preview">${toolPreview}</span>`
                    : nothing}
              </button>
              ${toolMessageExpanded
                ? html`
                    <div class="chat-tool-msg-body">
                      ${renderPairingQrExpiryNotices(pairingQrExpiryNotices)}
                      ${renderMessageImages(images, imageRenderOptions)}
                      ${renderAssistantAttachments(
                        visibleAttachments,
                        opts.localMediaPreviewRoots ?? [],
                        opts.basePath,
                        opts.assistantAttachmentAuthToken,
                        opts.onRequestUpdate,
                        opts.onAssistantAttachmentLoaded,
                        opts.onRequestOpenImage,
                        opts.onOpenImage,
                      )}
                      ${assistantViewContent}
                      ${reasoningMarkdown
                        ? html`<div class="chat-thinking">
                            ${unsafeHTML(toSanitizedMarkdownHtml(reasoningMarkdown))}
                          </div>`
                        : nothing}
                      ${jsonResult
                        ? html`<details
                            class="chat-json-collapse"
                            ?open=${Boolean(opts.autoExpandToolCalls)}
                          >
                            <summary class="chat-json-summary">
                              <span class="chat-json-badge">JSON</span>
                              <span class="chat-json-label"
                                >${jsonSummaryLabel(jsonResult.parsed)}</span
                              >
                            </summary>
                            <pre class="chat-json-content"><code>${jsonResult.pretty}</code></pre>
                          </details>`
                        : markdown
                          ? renderMarkdownText(markdown, opts.isStreaming, markdownRenderOptions)
                          : nothing}
                      ${hasToolCards
                        ? singleToolCard && !markdown && !hasImages
                          ? renderExpandedToolCardContent(
                              singleToolCard,
                              opts.sessionKey,
                              onOpenSidebar,
                              opts.canvasPluginSurfaceUrl,
                              opts.embedSandboxMode ?? "scripts",
                              opts.allowExternalEmbedUrls ?? false,
                              opts.runActive,
                              opts.onOpenWorkspaceFile,
                            )
                          : renderInlineToolCards(toolCards, {
                              messageKey,
                              sessionKey: opts.sessionKey,
                              agentId: opts.agentId,
                              onOpenSidebar,
                              onOpenWorkspaceFile: opts.onOpenWorkspaceFile,
                              isToolExpanded: opts.isToolExpanded,
                              onToggleToolExpanded: opts.onToggleToolExpanded,
                              runActive: opts.runActive,
                              canvasPluginSurfaceUrl: opts.canvasPluginSurfaceUrl,
                              embedSandboxMode: opts.embedSandboxMode ?? "scripts",
                              allowExternalEmbedUrls: opts.allowExternalEmbedUrls ?? false,
                            })
                        : nothing}
                    </div>
                  `
                : nothing}
            </div>
          `
        : html`
            ${renderPairingQrExpiryNotices(pairingQrExpiryNotices)}
            ${renderMessageImages(images, imageRenderOptions)}
            ${renderAssistantAttachments(
              visibleAttachments,
              opts.localMediaPreviewRoots ?? [],
              opts.basePath,
              opts.assistantAttachmentAuthToken,
              opts.onRequestUpdate,
              opts.onAssistantAttachmentLoaded,
              opts.onRequestOpenImage,
              opts.onOpenImage,
            )}
            ${reasoningMarkdown
              ? html`<div class="chat-thinking">
                  ${unsafeHTML(toSanitizedMarkdownHtml(reasoningMarkdown))}
                </div>`
              : nothing}
            ${assistantViewContent}
            ${jsonResult
              ? html`<details class="chat-json-collapse">
                  <summary class="chat-json-summary">
                    <span class="chat-json-badge">JSON</span>
                    <span class="chat-json-label">${jsonSummaryLabel(jsonResult.parsed)}</span>
                  </summary>
                  <pre class="chat-json-content"><code>${jsonResult.pretty}</code></pre>
                </details>`
              : markdown
                ? normalizedRole === "user"
                  ? renderUserMessageMarkdown(markdown, messageKey, opts, markdownRenderOptions)
                  : renderMarkdownText(markdown, opts.isStreaming, markdownRenderOptions)
                : nothing}
            ${hasToolCards
              ? renderInlineToolCards(toolCards, {
                  messageKey,
                  sessionKey: opts.sessionKey,
                  agentId: opts.agentId,
                  onOpenSidebar,
                  onOpenWorkspaceFile: opts.onOpenWorkspaceFile,
                  isToolExpanded: opts.isToolExpanded,
                  onToggleToolExpanded: opts.onToggleToolExpanded,
                  runActive: opts.runActive,
                  canvasPluginSurfaceUrl: opts.canvasPluginSurfaceUrl,
                  embedSandboxMode: opts.embedSandboxMode ?? "scripts",
                  allowExternalEmbedUrls: opts.allowExternalEmbedUrls ?? false,
                })
              : nothing}
          `}
      ${duplicateCount > 1
        ? html`<div
            class="chat-duplicate-count"
            aria-label=${`${duplicateCount} consecutive identical messages collapsed`}
          >
            ×${duplicateCount}
          </div>`
        : nothing}
    </div>
  `;
}

function renderWorkspaceConflictTranscriptMessage(
  conflict: WorkspaceResultConflict,
  messageKey: string,
  entryId?: string,
) {
  const count = workspaceConflictCount(conflict);
  const visible = visibleWorkspaceConflictPaths(conflict);
  return html`
    <div
      class="chat-bubble chat-bubble--workspace-conflict"
      data-message-id=${messageKey}
      data-entry-id=${entryId || nothing}
    >
      <div class="chat-workspace-conflict-event" role="status">
        <div class="chat-workspace-conflict-event__header">
          <span aria-hidden="true">${icons.alertTriangle}</span>
          <strong
            >${t(
              count === 1
                ? "chat.workspaceConflict.eventTitleOne"
                : "chat.workspaceConflict.eventTitleMany",
              { count: String(count) },
            )}</strong
          >
        </div>
        <p>${t("chat.workspaceConflict.eventDescription")}</p>
        <ul class="chat-workspace-conflict-paths">
          ${visible.paths.map(
            (entryPath) =>
              html`<li><code>${workspaceConflictPathForDisplay(entryPath)}</code></li>`,
          )}
        </ul>
        ${visible.remaining > 0
          ? html`<div class="chat-workspace-conflict-more">
              ${t("chat.workspaceConflict.morePaths", { count: String(visible.remaining) })}
            </div>`
          : nothing}
        <div class="chat-workspace-conflict-ref">
          <span>${t("chat.workspaceConflict.stagedResult")}</span>
          <code>${conflict.stagedResultRef}</code>
        </div>
      </div>
    </div>
  `;
}
