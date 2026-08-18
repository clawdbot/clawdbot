import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { sessionRefFromPath } from "../../../app-session-route-paths.ts";
import { icons } from "../../../components/icons.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.ts";
import {
  handleMarkdownCodeBlockClick,
  initializeMarkdownCodeBlocks,
} from "../../../components/markdown-code-blocks.ts";
import {
  markdownFileLinkFromEvent,
  markdownFileLinkFromKeyboardEvent,
} from "../../../components/markdown-file-links.ts";
import {
  markdownSessionHref,
  markdownSessionLinkFromEvent,
  markdownSessionLinkFromKeyboardEvent,
  type SessionLinkTarget,
} from "../../../components/markdown-session-links.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { extractRawText } from "../../../lib/chat/message-extract.ts";
import {
  resolveCanvasIframeUrl,
  resolveEmbedSandbox,
  type EmbedSandboxMode,
} from "../../../lib/chat/tool-display.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { shouldHandleNavigationClick } from "../../../lib/navigation-click.ts";
import { openInlineChatImage } from "./chat-image-lightbox.ts";
import { openResolvedImage } from "./chat-message-image-open.ts";
import { renderSidebarFile, type FileViewControls } from "./chat-sidebar-file-view.ts";
import type { SidebarContent, SidebarFullMessageLoader } from "./chat-sidebar.ts";
import "./session-diff-panel.ts";

type DetailUnavailableReason = NonNullable<
  Extract<SidebarContent, { kind: "markdown" }>["unavailableReason"]
>;
type SidebarFullMessageRequest = Parameters<SidebarFullMessageLoader>[0];

type ChatDetailPanelContent = Exclude<SidebarContent, { kind: "task" }>;

function hasFullMessageRequest(
  content: ChatDetailPanelContent,
): content is ChatDetailPanelContent & {
  fullMessageRequest: SidebarFullMessageRequest;
} {
  return Boolean(
    content.fullMessageRequest && (content.kind === "markdown" || content.kind === "canvas"),
  );
}

function formatUnavailableReason(reason: DetailUnavailableReason | null | undefined): string {
  switch (reason) {
    case "oversized":
      return t("chat.detailPanel.fullContentOversized");
    case "not_visible":
      return t("chat.detailPanel.fullContentNotVisible");
    default:
      return t("chat.detailPanel.fullContentUnavailable");
  }
}

function extractMessageText(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  if ("text" in message && typeof message.text === "string") {
    return message.text;
  }
  return extractRawText(message);
}

function toPlainTextCodeFence(value: string, language = ""): string {
  const fenceHeader = language ? `\`\`\`${language}` : "```";
  return `${fenceHeader}\n${value}\n\`\`\``;
}

export function buildRawContent(
  content: ChatDetailPanelContent | null | undefined,
): ChatDetailPanelContent | null {
  if (!content) {
    return null;
  }
  if (content.kind === "markdown") {
    const rawText = content.rawText ?? content.content;
    return {
      kind: "markdown",
      content: toPlainTextCodeFence(rawText),
      rawText,
      ...(content.unavailableReason ? { unavailableReason: content.unavailableReason } : {}),
    };
  }
  if (content.kind === "file") {
    const rawText = content.rawText ?? content.content;
    return {
      kind: "markdown",
      content: toPlainTextCodeFence(rawText, content.language),
      rawText,
      ...(content.unavailableReason ? { unavailableReason: content.unavailableReason } : {}),
    };
  }
  if (content.rawText?.trim()) {
    return {
      kind: "markdown",
      content: toPlainTextCodeFence(content.rawText, "json"),
      rawText: content.rawText,
      ...(content.unavailableReason ? { unavailableReason: content.unavailableReason } : {}),
    };
  }
  return null;
}

// Editing is only offered for uniform line endings: the editor serializes with
// one configured separator, so a mixed-endings file would have its untouched
// lines silently rewritten on save.

function resolveSidebarCanvasSandbox(
  content: ChatDetailPanelContent,
  embedSandboxMode: EmbedSandboxMode,
): string {
  return content.kind === "canvas"
    ? resolveEmbedSandbox(embedSandboxMode, content.sandbox)
    : "allow-scripts";
}

type MarkdownSidebarProps = {
  content: ChatDetailPanelContent | null;
  error: string | null;
  fileView?: FileViewControls;
  onClose: () => void;
  onOpenImage?: (item: ImageLightboxItem) => void;
  onViewRawText: () => void;
  canvasPluginSurfaceUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  embedded?: boolean;
};

function renderMarkdownSidebar(props: MarkdownSidebarProps) {
  const content = props.content;
  const markdownHtml =
    content?.kind === "markdown" && content.content.trim()
      ? toSanitizedMarkdownHtml(content.content, {
          codeBlockInteraction: "interactive",
          fileLinks: true,
          interactiveImages: props.onOpenImage !== undefined,
          sessionLinks: true,
        })
      : "";
  const canvasSandbox =
    content?.kind === "canvas"
      ? resolveSidebarCanvasSandbox(content, props.embedSandboxMode ?? "scripts")
      : "";
  const canvasSrc =
    content?.kind === "canvas"
      ? resolveCanvasIframeUrl(
          content.entryUrl,
          props.canvasPluginSurfaceUrl,
          props.allowExternalEmbedUrls ?? false,
        )
      : null;
  const title =
    content?.kind === "canvas"
      ? content.title?.trim() || t("chat.detailPanel.renderPreview")
      : content?.kind === "image"
        ? content.title.trim() || t("chat.detailPanel.imagePreview")
        : content?.kind === "file"
          ? content.name.trim() || t("chat.detailPanel.file")
          : content?.kind === "session-diff"
            ? t("chat.sessionDiff.title")
            : content?.kind === "markdown"
              ? t("chat.detailPanel.markdownPreview")
              : t("chat.detailPanel.toolDetails");
  return html`
    <div class="sidebar-panel">
      ${props.embedded
        ? nothing
        : html`<div class="sidebar-header">
            <div class="sidebar-title">${title}</div>
            <div class="sidebar-header__actions">
              <openclaw-tooltip .content=${t("chat.detailPanel.close")}>
                <button
                  @click=${props.onClose}
                  class="btn"
                  type="button"
                  aria-label=${t("chat.detailPanel.close")}
                >
                  ${icons.x}
                </button>
              </openclaw-tooltip>
            </div>
          </div> `}
      <div class="sidebar-content">
        ${props.error
          ? html`
              <div class="callout danger">${props.error}</div>
              ${content?.rawText?.trim()
                ? html`
                    <button
                      @click=${props.onViewRawText}
                      class="btn"
                      type="button"
                      style="margin-top: 12px;"
                    >
                      ${t("chat.detailPanel.viewRawText")}
                    </button>
                  `
                : nothing}
            `
          : content
            ? content.kind === "file"
              ? renderSidebarFile(content, props.onViewRawText, props.fileView)
              : content.kind === "session-diff"
                ? html`<openclaw-session-diff
                    .loader=${content.load}
                    .loadFileText=${content.loadFileText ?? null}
                    .openFile=${content.openFile ?? null}
                    .revealFile=${content.revealFile ?? null}
                  ></openclaw-session-diff>`
                : content.kind === "canvas"
                  ? html`
                      <div class="chat-tool-card__preview" data-kind="canvas">
                        <div class="chat-tool-card__preview-panel" data-side="front">
                          ${keyed(
                            `${canvasSandbox}\u0000${canvasSrc ?? ""}\u0000${content.preferredHeight ?? ""}`,
                            html`
                              <iframe
                                class="chat-tool-card__preview-frame"
                                title=${content.title?.trim() ||
                                t("chat.detailPanel.renderPreview")}
                                sandbox=${canvasSandbox}
                                src=${canvasSrc ?? nothing}
                                style=${content.preferredHeight
                                  ? `height:${content.preferredHeight}px`
                                  : ""}
                              ></iframe>
                            `,
                          )}
                        </div>
                        ${content.rawText?.trim()
                          ? html`
                              <div style="margin-top: 12px;">
                                <button @click=${props.onViewRawText} class="btn" type="button">
                                  ${t("chat.detailPanel.viewRawText")}
                                </button>
                              </div>
                            `
                          : nothing}
                      </div>
                    `
                  : content.kind === "image"
                    ? html`
                        <div class="chat-tool-card__preview" data-kind="image">
                          <div class="chat-tool-card__preview-panel" data-side="front">
                            <button
                              type="button"
                              class="chat-tool-card__preview-image-button"
                              aria-label=${t("chat.imageLightbox.open", { title })}
                              @click=${() =>
                                openResolvedImage(props.onOpenImage, content.src, title)}
                            >
                              <img
                                class="chat-tool-card__preview-image"
                                src=${content.src}
                                alt=${title}
                                style="display:block;max-width:100%;height:auto;border-radius:8px;"
                              />
                            </button>
                          </div>
                          ${content.rawText?.trim()
                            ? html`
                                <div style="margin-top: 12px;">
                                  <button @click=${props.onViewRawText} class="btn" type="button">
                                    ${t("chat.detailPanel.viewRawText")}
                                  </button>
                                </div>
                              `
                            : nothing}
                        </div>
                      `
                    : html`
                        <section class="sidebar-markdown-shell">
                          <div class="sidebar-markdown-shell__toolbar">
                            <div class="sidebar-markdown-shell__intro">
                              <div class="sidebar-markdown-shell__eyebrow">
                                ${icons.scrollText}
                                <span>${t("chat.detailPanel.renderedMarkdown")}</span>
                              </div>
                              <div class="sidebar-markdown-shell__hint">
                                ${t("chat.detailPanel.renderedMarkdownHint")}
                              </div>
                            </div>
                            <button @click=${props.onViewRawText} class="btn btn--sm" type="button">
                              ${t("chat.detailPanel.viewRawText")}
                            </button>
                          </div>
                          ${markdownHtml
                            ? html`
                                <article class="sidebar-markdown-reader sidebar-markdown">
                                  ${unsafeHTML(markdownHtml)}
                                </article>
                              `
                            : html`
                                <div class="sidebar-markdown-empty">
                                  ${t("chat.detailPanel.noPreviewableMarkdown")}
                                </div>
                              `}
                        </section>
                      `
            : html` <div class="muted">${t("chat.detailPanel.noContent")}</div> `}
      </div>
    </div>
  `;
}

export function renderSidebarPanel(
  props: MarkdownSidebarProps & {
    onClick: (event: MouseEvent) => void;
    onKeydown: (event: KeyboardEvent) => void;
  },
) {
  // Markdown previews and file editors need a bounded host wrapper so their
  // inner content can shrink and scroll. Content-sized kinds keep auto height.
  const fillHost =
    props.content?.kind === "file" ||
    props.content?.kind === "markdown" ||
    props.content?.kind === "session-diff";
  return html`
    <div
      class=${fillHost ? "sidebar-panel-host--fill" : ""}
      ${ref((element) => {
        if (element instanceof HTMLElement) {
          initializeMarkdownCodeBlocks(element);
        }
      })}
      @click=${props.onClick}
      @keydown=${props.onKeydown}
    >
      ${renderMarkdownSidebar(props)}
    </div>
  `;
}

export async function upgradeSidebarMessage(
  content: ChatDetailPanelContent,
  loadFullMessage: SidebarFullMessageLoader | null | undefined,
): Promise<{ content: ChatDetailPanelContent; error: string | null } | { error: string } | null> {
  if (!hasFullMessageRequest(content) || !loadFullMessage) {
    return null;
  }
  const request = content.fullMessageRequest;
  try {
    const result = await loadFullMessage(request);
    if (!result?.ok || !result.message || typeof result.message !== "object") {
      return {
        content: {
          ...content,
          unavailableReason: result?.unavailableReason ?? "not_found",
        },
        error: formatUnavailableReason(result?.unavailableReason ?? "not_found"),
      };
    }
    const fetchedText = extractMessageText(result.message);
    const rawText =
      fetchedText ??
      (typeof content.rawText === "string"
        ? content.rawText
        : content.kind === "markdown"
          ? content.content
          : null);
    return {
      content:
        content.kind === "markdown"
          ? {
              ...content,
              content: rawText || content.content,
              rawText: rawText || content.rawText || content.content,
              unavailableReason: null,
            }
          : {
              ...content,
              rawText: rawText || content.rawText || null,
              unavailableReason: null,
            },
      error: null,
    };
  } catch (error) {
    return {
      error: t("chat.detailPanel.fullContentLoadFailed", {
        error: formatUiError(error),
      }),
    };
  }
}

type SidebarNavigationCallbacks = {
  basePath: string;
  onOpenImage?: ((item: ImageLightboxItem) => void) | null;
  onOpenSessionLink?: ((target: SessionLinkTarget) => void) | null;
  onOpenWorkspaceFile?: ((target: { path: string; line?: number | null }) => void) | null;
};

export function handleSidebarClick(event: MouseEvent, callbacks: SidebarNavigationCallbacks) {
  if (openInlineChatImage(event, callbacks.onOpenImage ?? undefined)) {
    return;
  }
  handleMarkdownCodeBlockClick(event);
  const target = markdownFileLinkFromEvent(event);
  if (target) {
    callbacks.onOpenWorkspaceFile?.(target);
    return;
  }
  const sessionTarget =
    markdownSessionLinkFromEvent(event) ??
    markdownSessionHref(event, sessionRefFromPath, callbacks.basePath);
  if (sessionTarget && shouldHandleNavigationClick(event)) {
    event.preventDefault();
    callbacks.onOpenSessionLink?.(sessionTarget);
  }
}

export function handleSidebarKeydown(event: KeyboardEvent, callbacks: SidebarNavigationCallbacks) {
  const target = markdownFileLinkFromKeyboardEvent(event);
  if (target) {
    callbacks.onOpenWorkspaceFile?.(target);
    return;
  }
  const sessionTarget =
    markdownSessionLinkFromKeyboardEvent(event) ??
    (event.key === "Enter"
      ? markdownSessionHref(event, sessionRefFromPath, callbacks.basePath)
      : null);
  if (sessionTarget) {
    event.preventDefault();
    callbacks.onOpenSessionLink?.(sessionTarget);
  }
}
