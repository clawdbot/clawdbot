import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
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
import type { LinkFaviconFetcher } from "../link-favicon-loader.ts";
import { workspaceResultConflictFromTranscript } from "../workspace-conflict.ts";
import { renderAssistantAttachments } from "./chat-message-attachments.ts";
import { renderMessageImages, resolveRenderableMessageImages } from "./chat-message-images.ts";
import {
  detectJson,
  jsonSummaryLabel,
  renderMessageMarkdown,
  resolveMessageDisplayMarkdown,
  type AssistantMessageDisclosure,
} from "./chat-message-markdown.ts";
import {
  extractImages,
  extractPairingQrExpiryNotices,
  extractStructuredSvgAttachments,
  extractTranscriptAttachments,
  schedulePairingQrExpiryRefresh,
  type AssistantAttachmentItem,
  type ArtifactDownloadResolver,
  type PairingQrExpiryNotice,
} from "./chat-message-media.ts";
import type { SidebarContent } from "./chat-sidebar.ts";
import {
  renderExpandedToolCardContent,
  renderRawOutputToggle,
  renderToolApprovalReviews,
  renderToolCard,
  renderToolOutcome,
  renderToolPreview,
  resolveCollapsedToolDetail,
  shouldToggleSelectableDisclosure,
  syncToolDisclosureOverflow,
} from "./chat-tool-cards.ts";
import { renderWorkspaceConflictTranscriptMessage } from "./chat-workspace-conflict.ts";

function renderChatIcon(name: string) {
  return icons[name as IconName] ?? icons.zap;
}

function renderInlineToolCards(
  toolCards: ToolCard[],
  opts: Omit<Parameters<typeof renderToolCard>[1], "expanded" | "onToggleExpanded"> & {
    messageKey: string;
    isToolExpanded?: (toolCardId: string) => boolean;
    onToggleToolExpanded?: (toolCardId: string, expanded?: boolean) => void;
  },
) {
  return html`
    <div class="chat-tools-inline">
      ${toolCards.map((card, index) => {
        const disclosureId = `${opts.messageKey}:toolcard:${index}`;
        const expanded = opts.isToolExpanded?.(disclosureId) ?? false;
        return renderToolCard(card, {
          ...opts,
          expanded,
          onToggleExpanded: opts.onToggleToolExpanded
            ? () => opts.onToggleToolExpanded?.(disclosureId, expanded)
            : () => undefined,
        });
      })}
    </div>
  `;
}

type ReplyPreview = {
  sourceMessageId?: string;
  senderLabel?: string | null;
  text: string;
};

function renderReplyPreview(
  replyTarget: NormalizedMessage["replyTarget"],
  preview: ReplyPreview | undefined,
  onOpenReply: ((replyToId: string) => void) | undefined,
  onResolveReply: ((replyToId: string) => void) | undefined,
  navigationLoading: boolean,
) {
  if (!replyTarget) {
    return nothing;
  }
  const replyToId = replyTarget.kind === "id" ? replyTarget.id : null;
  const name = preview?.senderLabel?.trim()
    ? preview.senderLabel
    : replyTarget.kind === "current"
      ? t("chat.messages.currentMessage")
      : t("chat.messages.message");
  const content = preview?.text.trim() ?? "";
  const resolveMissingPreview = (element?: Element) => {
    if (element && replyToId && !preview) {
      onResolveReply?.(replyToId);
    }
  };
  const body = html`
    <span class="chat-reply-preview__icon"
      >${navigationLoading
        ? html`<span class="session-run-spinner" aria-hidden="true"></span>`
        : icons.messageSquare}</span
    >
    <span class="chat-reply-preview__label"> ${t("chat.messages.replyingTo", { name })} </span>
    ${content
      ? html`<span class="chat-reply-preview__text"
          >${truncateUtf16Safe(content, 120)}${content.length > 120 ? "..." : ""}</span
        >`
      : nothing}
  `;
  if (replyToId && onOpenReply) {
    return html`
      <button
        ${ref(resolveMissingPreview)}
        type="button"
        class="chat-reply-preview chat-reply-preview--message"
        ?disabled=${navigationLoading}
        aria-busy=${navigationLoading ? "true" : "false"}
        @click=${() => onOpenReply(replyToId)}
      >
        ${body}
      </button>
    `;
  }
  return html`
    <div
      ${ref(resolveMissingPreview)}
      class="chat-reply-preview chat-reply-preview--message chat-reply-preview--unavailable"
    >
      ${body}
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
    autoExpandToolCalls?: boolean;
    isToolMessageExpanded?: (messageId: string) => boolean | undefined;
    onToggleToolMessageExpanded?: (messageId: string, expanded?: boolean) => void;
    isUserMessageExpanded?: (messageId: string) => boolean;
    onToggleUserMessageExpanded?: (messageId: string) => void;
    assistantMessageDisclosure?: AssistantMessageDisclosure;
    actionMarkdown?: string;
    isToolExpanded?: (toolCardId: string) => boolean;
    onToggleToolExpanded?: (toolCardId: string, expanded?: boolean) => void;
    onRequestUpdate?: () => void;
    canvasPluginSurfaceUrl?: string | null;
    resourceBasePath?: string;
    localMediaPreviewRoots?: readonly string[];
    connectionEpoch?: number;
    assistantAttachmentAuthToken?: string | null;
    resolveArtifactDownload?: ArtifactDownloadResolver;
    onRequestOpenImage?: () => number;
    onOpenImage?: (item: ImageLightboxItem, requestVersion?: number) => void;
    onAssistantAttachmentLoaded?: () => void;
    embedSandboxMode?: EmbedSandboxMode;
    allowExternalEmbedUrls?: boolean;
    fetchLinkFavicon?: LinkFaviconFetcher;
    onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
    entryId?: string;
    /** Freshly submitted user turn: play the one-shot composer entry animation. */
    entryAnimated?: boolean;
    resolveReplyPreview?: (replyToId: string) => ReplyPreview | undefined;
    onResolveReply?: (replyToId: string) => void;
    onOpenReply?: (replyToId: string) => void;
    replyNavigationId?: string | null;
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
    connectionEpoch: opts.connectionEpoch,
    localMediaPreviewRoots: opts.localMediaPreviewRoots ?? [],
    resourceBasePath: opts.resourceBasePath,
    authToken: opts.assistantAttachmentAuthToken,
    onRequestUpdate: opts.onRequestUpdate,
    onRequestOpenImage: opts.onRequestOpenImage,
    onOpenImage: opts.onOpenImage,
    resolveArtifactDownload: opts.resolveArtifactDownload,
  };
  schedulePairingQrExpiryRefresh(messageKey, message, opts.onRequestUpdate);
  const images = resolveRenderableMessageImages(extractImages(message), imageRenderOptions);
  const hasImages = images.length > 0;
  const pairingQrExpiryNotices = extractPairingQrExpiryNotices(message);
  const hasPairingQrExpiryNotices = pairingQrExpiryNotices.length > 0;

  const displayMarkdown = resolveMessageDisplayMarkdown(message, normalizedMessage);
  const actionText = opts.actionMarkdown ?? displayMarkdown;
  const assistantAttachments = normalizedMessage.content.filter(
    (item): item is AssistantAttachmentItem =>
      item.type === "attachment" || item.type === "attachment_error",
  );
  const attachmentUrls = new Set<string>();
  const visibleAttachments = [
    ...assistantAttachments,
    ...extractStructuredSvgAttachments(message),
    ...extractTranscriptAttachments(message),
  ].filter((item) => {
    if (item.type === "attachment_error") {
      return true;
    }
    const { attachment } = item;
    if (attachmentUrls.has(attachment.url)) {
      return false;
    }
    attachmentUrls.add(attachment.url);
    return true;
  });
  const assistantViewBlocks = normalizedMessage.content.filter(
    (item): item is Extract<MessageContentItem, { type: "canvas" }> => item.type === "canvas",
  );
  const extractedThinking =
    opts.showReasoning && role === "assistant" ? extractThinkingCached(message) : null;
  const reasoningMarkdown = extractedThinking ? formatReasoningMarkdown(extractedThinking) : null;
  const markdown =
    (normalizedRole === "user" ? opts.actionMarkdown : undefined) ?? (displayMarkdown || null);
  const markdownRenderOptions: MarkdownRenderOptions = {
    assistantTranscriptRoleHeaders: role === "assistant",
    codeBlockChrome: role === "user" ? "none" : "copy",
    codeBlockInteraction: role === "assistant" ? "interactive" : "static",
    fileLinks: true,
    interactiveImages: opts.onOpenImage !== undefined,
    sessionLinks: true,
    tableInteractions: "enabled",
    linkFavicons: Boolean(opts.fetchLinkFavicon) && !opts.isStreaming,
  };

  // Detect pure-JSON messages and render as collapsible block
  const jsonResult = markdown && !opts.isStreaming ? detectJson(markdown) : null;

  const bubbleClasses = [
    "chat-bubble",
    hasImages ? "chat-bubble--with-images" : "",
    isToolShell ? "chat-bubble--tool-shell" : "",
    opts.isStreaming ? "streaming" : "",
    opts.entryAnimated ? "chat-bubble--user-turn-enter" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Suppress empty bubbles when tool cards are the only content and toggle is off
  if (
    !markdown &&
    !hasToolCards &&
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
  const standaloneToolPayload =
    isStandaloneToolMessage &&
    Boolean(markdown) &&
    !jsonResult &&
    !hasImages &&
    singleToolCard?.outputText?.trim() === markdown?.trim();
  const bodyMarkdown = standaloneToolPayload ? null : markdown;
  // One expanded card already closes with its own outcome line; every other
  // shape renders inline rows only, so the message body records the failure.
  const expandsSingleToolCard =
    Boolean(singleToolCard) && (!markdown || standaloneToolPayload) && !hasImages;
  const failedToolCard = expandsSingleToolCard ? undefined : toolCards.find(isToolCardError);
  const singleToolDisplay = singleToolCard
    ? resolveToolDisplay({
        name: singleToolCard.name,
        args: singleToolCard.args,
        detailMode: "explain",
      })
    : null;
  const singleToolDisplayDetail =
    singleToolCard && singleToolDisplay
      ? resolveCollapsedToolDetail(singleToolCard, singleToolDisplay.detail)
      : undefined;
  const toolSummaryLabelRaw = singleToolDisplayDetail
    ? !markdown && !hasImages
      ? singleToolDisplayDetail
      : singleToolCard?.outputText?.trim()
        ? "output"
        : undefined
    : toolNames.length <= 3
      ? toolNames.join(", ")
      : `${toolNames.slice(0, 2).join(", ")} +${toolNames.length - 2} more`;
  const toolPreview = markdown ? (formatCollapsedToolPreviewText(markdown) ?? "") : "";
  const toolMessageLabelRaw =
    singleToolDisplay && !markdown && !hasImages
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
          (block) => html`<div class="chat-tool-card__widget-host">
            ${renderToolPreview(block.preview, "chat_message", {
              rawText: block.rawText ?? null,
              canvasPluginSurfaceUrl: opts.canvasPluginSurfaceUrl,
              boardProvider: opts.boardProvider,
              embedSandboxMode: opts.embedSandboxMode ?? "scripts",
              sessionKey: opts.sessionKey,
            })}
            ${block.rawText
              ? html`<div class="chat-tool-card__widget-raw">
                  ${renderRawOutputToggle(block.rawText)}
                </div>`
              : nothing}
          </div>`,
        )}`
      : nothing;

  const duplicateCount = Math.max(1, Math.floor(opts.duplicateCount ?? 1));
  const duplicateSuffix =
    duplicateCount > 1
      ? {
          count: duplicateCount,
          label: t("chat.messages.duplicatesCollapsed", { count: String(duplicateCount) }),
        }
      : undefined;

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

  const toolRenderOptions = { ...opts, messageKey, onOpenSidebar };
  // Collapsed tool results must not load attachments or render hidden markdown.
  const renderBody = () => html`
    ${renderPairingQrExpiryNotices(pairingQrExpiryNotices)}
    ${renderMessageImages(images, imageRenderOptions)}
    ${renderAssistantAttachments(
      visibleAttachments,
      imageRenderOptions,
      onOpenSidebar,
      opts.onAssistantAttachmentLoaded,
      normalizedRole === "assistant",
    )}
    ${isStandaloneToolMessage ? assistantViewContent : nothing}
    ${reasoningMarkdown
      ? html`<div class="chat-thinking">
          ${unsafeHTML(
            toSanitizedMarkdownHtml(reasoningMarkdown, {
              codeBlockInteraction: "interactive",
            }),
          )}
        </div>`
      : nothing}
    ${isStandaloneToolMessage ? nothing : assistantViewContent}
    ${jsonResult
      ? html`<details
          class="chat-json-collapse"
          ?open=${isStandaloneToolMessage && Boolean(opts.autoExpandToolCalls)}
        >
          <summary class="chat-json-summary">
            <span class="chat-json-badge">${t("chat.codeBlock.jsonBadge")}</span>
            <span class="chat-json-label">${jsonSummaryLabel(jsonResult.parsed)}</span>
          </summary>
          <pre class="chat-json-content"><code>${jsonResult.text}</code></pre>
        </details>`
      : bodyMarkdown
        ? renderMessageMarkdown(
            bodyMarkdown,
            messageKey,
            { ...opts, role: isStandaloneToolMessage ? "tool" : normalizedRole },
            markdownRenderOptions,
            duplicateSuffix,
          )
        : nothing}
    ${hasToolCards
      ? isStandaloneToolMessage && expandsSingleToolCard && singleToolCard
        ? renderExpandedToolCardContent(singleToolCard, toolRenderOptions)
        : renderInlineToolCards(toolCards, {
            ...toolRenderOptions,
            showApprovalReviews: isStandaloneToolMessage ? false : undefined,
          })
      : nothing}
    ${isStandaloneToolMessage && failedToolCard
      ? renderToolOutcome("failed", failedToolCard.exitCode)
      : nothing}
  `;

  return html`
    <div
      class="${bubbleClasses}"
      data-message-id=${messageKey}
      data-entry-id=${opts.entryId || nothing}
      data-message-text=${actionText || nothing}
    >
      ${renderReplyPreview(
        normalizedMessage.replyTarget,
        normalizedMessage.replyTarget?.kind === "id"
          ? (opts.resolveReplyPreview?.(normalizedMessage.replyTarget.id) ??
              normalizedMessage.replyPreview)
          : undefined,
        opts.onOpenReply,
        opts.onResolveReply,
        normalizedMessage.replyTarget?.kind === "id" &&
          opts.replyNavigationId === normalizedMessage.replyTarget.id,
      )}
      ${onlyToolCards
        ? renderInlineToolCards(toolCards, toolRenderOptions)
        : isStandaloneToolMessage
          ? html`
              <div
                class="chat-tool-msg-collapse chat-tool-msg-collapse--manual ${toolMessageExpanded
                  ? "is-open"
                  : ""}"
              >
                <button
                  class="chat-inline-disclosure chat-tool-msg-summary"
                  type="button"
                  aria-expanded=${String(toolMessageExpanded)}
                  @pointerenter=${syncToolDisclosureOverflow}
                  @focus=${syncToolDisclosureOverflow}
                  @click=${(event: MouseEvent) => {
                    if (shouldToggleSelectableDisclosure(event)) {
                      opts.onToggleToolMessageExpanded?.(
                        toolMessageDisclosureId,
                        toolMessageExpanded,
                      );
                    }
                  }}
                >
                  <span class="chat-tool-msg-summary__icon">${toolMessageIcon}</span>
                  <span class="chat-tool-disclosure__content">
                    <span class="chat-tool-msg-summary__label">${toolMessageLabel}</span>
                    ${toolSummaryLabel
                      ? html`<span class="chat-tool-msg-summary__names">${toolSummaryLabel}</span>`
                      : toolPreview
                        ? html`<span class="chat-tool-msg-summary__preview">${toolPreview}</span>`
                        : nothing}
                  </span>
                  <span class="chat-tool-row__chevron" aria-hidden="true"
                    >${icons.chevronRight}</span
                  >
                </button>
                ${toolMessageExpanded
                  ? html`<div class="chat-tool-msg-body">${renderBody()}</div>`
                  : nothing}
                ${toolCards.map((card) => renderToolApprovalReviews(card))}
              </div>
            `
          : renderBody()}
      ${duplicateCount > 1 && (!markdown || jsonResult)
        ? html`<div
            class="chat-duplicate-count"
            aria-label=${t("chat.messages.duplicatesCollapsed", {
              count: String(duplicateCount),
            })}
          >
            ×${duplicateCount}
          </div>`
        : nothing}
    </div>
  `;
}
