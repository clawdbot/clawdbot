import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../../../components/icons.ts";
import "../../../components/web-awesome.ts";
import {
  handleMarkdownCodeBlockCopy,
  markdownFileLinkFromEvent,
  toSanitizedMarkdownHtml,
} from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import "../../../components/tooltip.ts";
import { extractRawText } from "../../../lib/chat/message-extract.ts";
import {
  resolveCanvasIframeUrl,
  resolveEmbedSandbox,
  type EmbedSandboxMode,
} from "../../../lib/chat/tool-display.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import { type EditorId, editorOpenUrl } from "../../../lib/editor-links.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import "./session-diff-panel.ts";
import { renderChatSidebarEditorMenu } from "./chat-sidebar-editor-menu.ts";
import type { FileEditorViewHandle } from "./file-editor-view.ts";
import type { SessionDiffLoader } from "./session-diff-panel.ts";

export const CHAT_DETAIL_FULL_MESSAGE_MAX_CHARS = 500_000;

type DetailUnavailableReason = "not_found" | "oversized" | "not_visible";
export type DetailFullMessageResult = {
  ok?: boolean;
  message?: unknown;
  unavailableReason?: DetailUnavailableReason;
};

export type SidebarFullMessageRequest = {
  sessionKey: string;
  agentId?: string;
  messageId: string;
  kind: "assistant_message" | "tool_output";
};

type MarkdownSidebarContent = {
  kind: "markdown";
  content: string;
  rawText?: string | null;
  fullMessageRequest?: SidebarFullMessageRequest;
  unavailableReason?: DetailUnavailableReason | null;
};

type CanvasSidebarContent = {
  kind: "canvas";
  docId: string;
  title?: string;
  entryUrl: string;
  preferredHeight?: number;
  /** Per-preview sandbox ceiling; keeps widget iframes below the global embed mode. */
  sandbox?: "strict" | "scripts";
  rawText?: string | null;
  fullMessageRequest?: SidebarFullMessageRequest;
  unavailableReason?: DetailUnavailableReason | null;
};

type ImageSidebarContent = {
  kind: "image";
  title: string;
  src: string;
  mimeType?: string | null;
  rawText?: string | null;
  fullMessageRequest?: SidebarFullMessageRequest;
  unavailableReason?: DetailUnavailableReason | null;
};

type SessionDiffSidebarContent = {
  kind: "session-diff";
  /** Fetches a fresh sessions.diff snapshot; the panel refetches on refresh. */
  load: SessionDiffLoader;
  rawText?: string | null;
  fullMessageRequest?: SidebarFullMessageRequest;
  unavailableReason?: DetailUnavailableReason | null;
};

type FileSaveOutcome =
  | { ok: true; hash: string; updatedAtMs?: number }
  | { ok: false; code: "conflict"; currentHash?: string }
  | { ok: false; code: "error"; message: string };

type FileSidebarEdit = {
  hash: string;
  save: (params: { content: string; expectedHash: string }) => Promise<FileSaveOutcome>;
  /** `editable: false` means the latest content no longer qualifies for edit mode. */
  fetchLatest: () => Promise<{ content: string; hash: string; editable: boolean } | null>;
};

type FileSidebarContent = {
  kind: "file";
  path: string;
  name: string;
  content: string;
  /** Stable per-session identity used to retain an unsaved in-memory draft. */
  draftKey?: string;
  root?: string | null;
  language?: string;
  line?: number | null;
  rawText?: string | null;
  fullMessageRequest?: SidebarFullMessageRequest;
  unavailableReason?: DetailUnavailableReason | null;
  edit?: FileSidebarEdit;
};

type RetainedFileDraft = {
  content: string;
  expectedHash: string;
};

const retainedFileDrafts = new Map<string, RetainedFileDraft>();

function retainedFileDraftKey(content: FileSidebarContent): string {
  return content.draftKey ?? `${content.root ?? ""}\u0000${content.path}`;
}

function setRetainedFileDraft(content: FileSidebarContent, draft: RetainedFileDraft | null) {
  const key = retainedFileDraftKey(content);
  retainedFileDrafts.delete(key);
  if (!draft) {
    return;
  }
  retainedFileDrafts.set(key, draft);
}

export type SidebarContent =
  | MarkdownSidebarContent
  | CanvasSidebarContent
  | ImageSidebarContent
  | FileSidebarContent
  | SessionDiffSidebarContent;

function hasFullMessageRequest(content: SidebarContent): content is SidebarContent & {
  fullMessageRequest: NonNullable<SidebarContent["fullMessageRequest"]>;
} {
  return Boolean(
    content.fullMessageRequest && (content.kind === "markdown" || content.kind === "canvas"),
  );
}

function formatUnavailableReason(reason: DetailUnavailableReason | null | undefined): string {
  switch (reason) {
    case "oversized":
      return "Full content is unavailable because the stored transcript entry is too large to return safely.";
    case "not_visible":
      return "Full content is unavailable because this transcript entry does not have a visible WebChat projection.";
    default:
      return "Full content is no longer available for this transcript entry.";
  }
}

function extractMessageText(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const record = message as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  return extractRawText(message);
}

function toPlainTextCodeFence(value: string, language = ""): string {
  const fenceHeader = language ? `\`\`\`${language}` : "```";
  return `${fenceHeader}\n${value}\n\`\`\``;
}

function buildRawSidebarContent(content: SidebarContent | null | undefined): SidebarContent | null {
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
export function hasUniformLineEndings(content: string): boolean {
  const crlf = content.split("\r\n").length - 1;
  const bareCr = (content.match(/\r(?!\n)/g) ?? []).length;
  const bareLf = (content.match(/(?<!\r)\n/g) ?? []).length;
  return [crlf, bareCr, bareLf].filter((count) => count > 0).length <= 1;
}

function computeFileSearchMatches(content: string, query: string): number[] {
  const normalizedQuery = query.toLocaleLowerCase();
  if (!normalizedQuery) {
    return [];
  }
  return content
    .split("\n")
    .flatMap((line, index) =>
      line.toLocaleLowerCase().includes(normalizedQuery) ? [index + 1] : [],
    );
}

function absoluteFilePath(content: FileSidebarContent): string | null {
  if (
    content.path.startsWith("/") ||
    /^[a-z]:[\\/]/i.test(content.path) ||
    content.path.startsWith("\\\\")
  ) {
    return content.path;
  }
  if (!content.root) {
    return null;
  }
  return `${content.root.replace(/[\\/]+$/, "")}/${content.path.replace(/^[\\/]+/, "")}`;
}

type FileViewControls = {
  copied: boolean;
  currentMatchIndex: number;
  dirty: boolean;
  editorMenuOpen: boolean;
  editing: boolean;
  loadingEditor: boolean;
  mountKey: number;
  matches: number[];
  query: string;
  saveNotice: { kind: "conflict" } | { kind: "error"; message: string } | null;
  saving: boolean;
  searchOpen: boolean;
  onCopyContents: () => void;
  onDiscard: () => void;
  onEdit: () => void;
  onNextMatch: () => void;
  onOpenEditor: (editor: EditorId) => void;
  onOverwrite: () => void;
  onPreviousMatch: () => void;
  onReload: () => void;
  onReveal?: (path: string) => void;
  onSave: () => void;
  onSearchInput: (query: string) => void;
  onSearchKeydown: (event: KeyboardEvent) => void;
  onEditorMenuOpenChange: (open: boolean) => void;
  onToggleSearch: () => void;
};

function renderFileSidebarContent(
  content: FileSidebarContent,
  onViewRawText: () => void,
  controls?: FileViewControls,
) {
  const absolutePath = absoluteFilePath(content);
  const matchNumber = controls?.matches.length ? controls.currentMatchIndex + 1 : 0;
  return html`
    <section class="sidebar-file-view">
      <div class="sidebar-file-view__path-bar">
        <div class="sidebar-file-view__path-field">
          <span class="sidebar-file-view__path" title=${content.path}>${content.path}</span>
          <openclaw-tooltip .content=${t("chat.detailPanel.copyPath")}>
            <button
              class="btn btn--sm sidebar-file-view__action"
              type="button"
              aria-label=${t("chat.detailPanel.copyPath")}
              @click=${() => void copyToClipboard(content.path)}
            >
              ${icons.copy}
            </button>
          </openclaw-tooltip>
        </div>
        ${controls
          ? html`
              <div class="sidebar-file-view__actions">
                ${controls.editing
                  ? html`
                      <button
                        class="btn btn--sm"
                        type="button"
                        ?disabled=${!controls.dirty || controls.saving}
                        @click=${controls.onSave}
                      >
                        ${controls.saving ? "Saving…" : "Save"}
                      </button>
                      <button
                        class="btn btn--sm"
                        type="button"
                        ?disabled=${controls.saving}
                        @click=${controls.onDiscard}
                      >
                        ${t("chat.detailPanel.discard")}
                      </button>
                    `
                  : html`
                      ${content.edit
                        ? html`
                            <openclaw-tooltip .content=${t("chat.detailPanel.editFile")}>
                              <button
                                class="btn btn--sm sidebar-file-view__action"
                                type="button"
                                aria-label=${t("chat.detailPanel.editFile")}
                                ?disabled=${controls.loadingEditor}
                                @click=${controls.onEdit}
                              >
                                ${icons.edit}
                              </button>
                            </openclaw-tooltip>
                          `
                        : nothing}
                      <openclaw-tooltip .content=${t("chat.detailPanel.searchInFile")}>
                        <button
                          class="btn btn--sm sidebar-file-view__action"
                          type="button"
                          aria-label=${t("chat.detailPanel.searchInFile")}
                          aria-pressed=${String(controls.searchOpen)}
                          @click=${controls.onToggleSearch}
                        >
                          ${icons.search}
                        </button>
                      </openclaw-tooltip>
                      ${controls.onReveal
                        ? html`
                            <openclaw-tooltip .content=${t("chat.detailPanel.showInFiles")}>
                              <button
                                class="btn btn--sm sidebar-file-view__action"
                                type="button"
                                aria-label=${t("chat.detailPanel.showInFiles")}
                                @click=${() => controls.onReveal?.(content.path)}
                              >
                                ${icons.folder}
                              </button>
                            </openclaw-tooltip>
                          `
                        : nothing}
                      ${renderChatSidebarEditorMenu({
                        absolutePath,
                        open: controls.editorMenuOpen,
                        onOpenChange: controls.onEditorMenuOpenChange,
                        onOpenEditor: controls.onOpenEditor,
                      })}
                      <openclaw-tooltip content="Copy file contents">
                        <button
                          class="btn btn--sm sidebar-file-view__action ${controls.copied
                            ? "copied"
                            : ""}"
                          type="button"
                          aria-label=${controls.copied ? "Copied" : "Copy file contents"}
                          @click=${controls.onCopyContents}
                        >
                          ${controls.copied ? icons.check : icons.copy}
                        </button>
                      </openclaw-tooltip>
                    `}
              </div>
            `
          : nothing}
      </div>
      ${controls?.searchOpen
        ? html`
            <div class="file-view__search">
              <input
                type="search"
                aria-label=${t("chat.detailPanel.searchInFile")}
                placeholder=${t("common.search")}
                .value=${controls.query}
                @input=${(event: Event) =>
                  controls.onSearchInput((event.currentTarget as HTMLInputElement).value)}
                @keydown=${controls.onSearchKeydown}
              />
              <span class="file-view__search-counter"
                >${matchNumber}/${controls.matches.length}</span
              >
              <button
                class="btn btn--sm file-view__search-action file-view__search-action--previous"
                type="button"
                aria-label=${t("chat.detailPanel.previousMatch")}
                ?disabled=${controls.matches.length === 0}
                @click=${controls.onPreviousMatch}
              >
                ${icons.chevronDown}
              </button>
              <button
                class="btn btn--sm file-view__search-action"
                type="button"
                aria-label=${t("chat.detailPanel.nextMatch")}
                ?disabled=${controls.matches.length === 0}
                @click=${controls.onNextMatch}
              >
                ${icons.chevronDown}
              </button>
            </div>
          `
        : nothing}
      ${controls?.saveNotice
        ? html`
            <div class="file-view__save-notice" role="alert">
              <span>
                ${controls.saveNotice.kind === "conflict"
                  ? "File changed on disk since it was loaded."
                  : controls.saveNotice.message}
              </span>
              ${controls.saveNotice.kind === "conflict"
                ? html`
                    <div class="file-view__save-notice-actions">
                      <button
                        class="btn btn--sm"
                        type="button"
                        ?disabled=${controls.saving}
                        @click=${controls.onReload}
                      >
                        ${t("common.reload")}
                      </button>
                      <button
                        class="btn btn--sm"
                        type="button"
                        ?disabled=${controls.saving}
                        @click=${controls.onOverwrite}
                      >
                        ${t("chat.detailPanel.overwrite")}
                      </button>
                    </div>
                  `
                : nothing}
            </div>
          `
        : nothing}
      <div class="file-view">
        ${keyed(controls?.mountKey ?? content, html`<div class="file-view__mount"></div>`)}
        ${controls?.loadingEditor
          ? html`<div class="file-view__loading muted">${t("common.loading")}</div>`
          : nothing}
      </div>
      ${controls?.editing
        ? nothing
        : html`
            <div class="sidebar-file-view__footer">
              <button @click=${onViewRawText} class="btn btn--sm" type="button">
                ${t("chat.detailPanel.viewRawText")}
              </button>
            </div>
          `}
    </section>
  `;
}

function resolveSidebarCanvasSandbox(
  content: SidebarContent,
  embedSandboxMode: EmbedSandboxMode,
): string {
  return content.kind === "canvas"
    ? resolveEmbedSandbox(embedSandboxMode, content.sandbox)
    : "allow-scripts";
}

type MarkdownSidebarProps = {
  content: SidebarContent | null;
  error: string | null;
  fileView?: FileViewControls;
  onClose: () => void;
  onViewRawText: () => void;
  canvasPluginSurfaceUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
};

function renderMarkdownSidebar(props: MarkdownSidebarProps) {
  const content = props.content;
  const markdownHtml =
    content?.kind === "markdown" && content.content.trim()
      ? toSanitizedMarkdownHtml(content.content, { fileLinks: true })
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
      ? content.title?.trim() || "Render Preview"
      : content?.kind === "image"
        ? content.title.trim() || "Image Preview"
        : content?.kind === "file"
          ? content.name.trim() || "File"
          : content?.kind === "session-diff"
            ? t("chat.sessionDiff.title")
            : content?.kind === "markdown"
              ? "Markdown Preview"
              : "Tool Details";
  return html`
    <div class="sidebar-panel">
      <div class="sidebar-header">
        <div class="sidebar-title">${title}</div>
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
              ? renderFileSidebarContent(content, props.onViewRawText, props.fileView)
              : content.kind === "session-diff"
                ? html`<openclaw-session-diff .loader=${content.load}></openclaw-session-diff>`
                : content.kind === "canvas"
                  ? html`
                      <div class="chat-tool-card__preview" data-kind="canvas">
                        <div class="chat-tool-card__preview-panel" data-side="front">
                          ${keyed(
                            `${canvasSandbox}\u0000${canvasSrc ?? ""}\u0000${content.preferredHeight ?? ""}`,
                            html`
                              <iframe
                                class="chat-tool-card__preview-frame"
                                title=${content.title?.trim() || "Render preview"}
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
                            <img
                              class="chat-tool-card__preview-image"
                              src=${content.src}
                              alt=${title}
                              style="display:block;max-width:100%;height:auto;border-radius:8px;"
                            />
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

class ChatDetailPanel extends OpenClawLightDomElement {
  @property({ attribute: false }) content: SidebarContent | null = null;
  @property({ attribute: false }) loadFullMessage?:
    | ((request: SidebarFullMessageRequest) => Promise<DetailFullMessageResult | null | undefined>)
    | null = null;
  @property() canvasPluginSurfaceUrl: string | null = null;
  @property() embedSandboxMode: EmbedSandboxMode = "scripts";
  @property({ type: Boolean }) allowExternalEmbedUrls = false;
  @property({ attribute: false }) onOpenWorkspaceFile?:
    | ((target: { path: string; line?: number | null }) => void)
    | null = null;
  @property({ attribute: false }) onRevealInWorkspace?: ((path: string) => void) | null = null;

  @state() private visibleContent: SidebarContent | null = null;
  @state() private error: string | null = null;
  @state() private fileSearchOpen = false;
  @state() private fileSearchQuery = "";
  @state() private fileSearchMatchIndex = 0;
  @state() private fileEditorMenuOpen = false;
  @state() private fileContentsCopied = false;
  @state() private fileEditorLoading = false;
  @state() private fileEditing = false;
  @state() private fileDirty = false;
  @state() private fileReloading = false;
  @state() private fileSaving = false;
  @state() private fileSaveNotice:
    | { kind: "conflict" }
    | { kind: "error"; message: string }
    | null = null;

  private requestVersion = 0;
  private fileOperationVersion = 0;
  private showingRawText = false;
  private fileEditor: FileEditorViewHandle | null = null;
  private fileEditorLoad: Promise<void> | null = null;
  private fileDraftContent: string | null = null;
  private fileSavedContent = "";
  private fileHash = "";
  private copyFeedbackTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("pointerdown", this.handleDocumentPointerDown);
  }

  override disconnectedCallback() {
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown);
    this.destroyFileEditor();
    if (this.copyFeedbackTimer) {
      globalThis.clearTimeout(this.copyFeedbackTimer);
      this.copyFeedbackTimer = null;
    }
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: Map<string, unknown>) {
    if (!changed.has("content")) {
      return;
    }
    this.requestVersion += 1;
    this.visibleContent = this.content;
    this.error = null;
    this.showingRawText = false;
    this.fileSearchOpen = false;
    this.fileSearchQuery = "";
    this.fileSearchMatchIndex = 0;
    this.fileEditorMenuOpen = false;
    this.fileContentsCopied = false;
    this.fileOperationVersion += 1;
    this.fileEditing = false;
    this.fileDirty = false;
    this.fileReloading = false;
    this.fileSaving = false;
    this.fileSaveNotice = null;
    const retainedDraft =
      this.content?.kind === "file" && this.content.edit
        ? retainedFileDrafts.get(retainedFileDraftKey(this.content))
        : undefined;
    const restoredDraft =
      this.content?.kind === "file" && retainedDraft?.content !== this.content.content
        ? retainedDraft
        : undefined;
    if (retainedDraft && !restoredDraft && this.content?.kind === "file") {
      setRetainedFileDraft(this.content, null);
    }
    this.fileDraftContent = restoredDraft?.content ?? null;
    this.fileSavedContent = this.content?.kind === "file" ? this.content.content : "";
    this.fileHash =
      restoredDraft?.expectedHash ??
      (this.content?.kind === "file" ? (this.content.edit?.hash ?? "") : "");
    this.fileEditing = Boolean(restoredDraft);
    this.fileDirty = Boolean(restoredDraft);
    this.fileEditorLoading = this.content?.kind === "file";
    this.destroyFileEditor();
    if (this.copyFeedbackTimer) {
      globalThis.clearTimeout(this.copyFeedbackTimer);
      this.copyFeedbackTimer = null;
    }
  }

  protected override updated(changed: Map<string, unknown>) {
    const visibleContent = this.visibleContent;
    if (visibleContent?.kind === "file" && !this.showingRawText) {
      void this.ensureFileEditor().then(() => {
        this.syncFileEditor();
        if (changed.has("content") && visibleContent.line != null) {
          this.scrollToFileLine(visibleContent);
        }
      });
    }
    if (!changed.has("content") && !changed.has("loadFullMessage")) {
      return;
    }
    const content = this.content;
    if (!content || this.showingRawText) {
      return;
    }
    const version = ++this.requestVersion;
    void this.upgradeToFullMessage(content, version);
  }

  private scrollToFileLine(content: FileSidebarContent) {
    if (this.visibleContent !== content || this.showingRawText) {
      return;
    }
    if (content.line != null) {
      this.fileEditor?.scrollToLine(content.line, true);
    }
  }

  private destroyFileEditor() {
    this.fileOperationVersion += 1;
    this.fileEditor?.destroy();
    this.fileEditor = null;
    this.fileEditorLoad = null;
  }

  private ensureFileEditor(): Promise<void> {
    if (this.fileEditor) {
      return Promise.resolve();
    }
    if (this.fileEditorLoad) {
      return this.fileEditorLoad;
    }
    const content = this.visibleContent;
    const parent = this.querySelector<HTMLElement>(".file-view__mount");
    if (content?.kind !== "file" || !parent) {
      return Promise.resolve();
    }
    const version = this.fileOperationVersion;
    this.fileEditorLoading = true;
    this.fileEditorLoad = import("./file-editor-view.ts")
      .then(async ({ createFileEditorView }) => {
        const current = this.visibleContent;
        if (version !== this.fileOperationVersion || current?.kind !== "file") {
          return;
        }
        const editor = await createFileEditorView({
          parent,
          content: this.fileDraftContent ?? current.content,
          name: current.name,
          editable: this.fileEditing,
          onSave: this.saveFile,
        });
        if (
          version !== this.fileOperationVersion ||
          !this.isConnected ||
          this.visibleContent?.kind !== "file"
        ) {
          editor.destroy();
          return;
        }
        this.fileEditor = editor;
        this.fileDraftContent = null;
        editor.onDocChanged((nextContent) => {
          const dirty = nextContent !== this.fileSavedContent;
          if (dirty !== this.fileDirty) {
            this.fileDirty = dirty;
          }
          if (!dirty && this.visibleContent?.kind === "file") {
            this.fileHash = this.visibleContent.edit?.hash ?? "";
          }
          setRetainedFileDraft(
            current,
            dirty ? { content: nextContent, expectedHash: this.fileHash } : null,
          );
          if (this.fileSaveNotice?.kind === "error") {
            this.fileSaveNotice = null;
          }
        });
      })
      .finally(() => {
        if (version === this.fileOperationVersion) {
          this.fileEditorLoad = null;
          this.fileEditorLoading = false;
        }
      });
    return this.fileEditorLoad;
  }

  private syncFileEditor() {
    const content = this.visibleContent;
    const editor = this.fileEditor;
    if (content?.kind !== "file" || !editor) {
      return;
    }
    if (!this.fileEditing) {
      editor.setContent(content.content);
    }
    editor.setEditable(this.fileEditing && !this.fileReloading);
    const matches = this.fileSearchMatches();
    editor.setDecorations({
      targetLine: content.line,
      matches,
      currentMatch: matches[this.fileSearchMatchIndex] ?? null,
    });
  }

  private readonly handleDocumentPointerDown = (event: PointerEvent) => {
    if (!this.fileEditorMenuOpen) {
      return;
    }
    const editor = this.querySelector(".sidebar-file-view__editor");
    if (!editor || !event.composedPath().includes(editor)) {
      this.fileEditorMenuOpen = false;
    }
  };

  private fileSearchMatches(): number[] {
    const content = this.visibleContent;
    return content?.kind === "file"
      ? computeFileSearchMatches(content.content, this.fileSearchQuery)
      : [];
  }

  private async scrollToCurrentFileMatch() {
    await this.updateComplete;
    const line = this.fileSearchMatches()[this.fileSearchMatchIndex];
    if (line != null) {
      this.fileEditor?.scrollToLine(line, true);
    }
  }

  private readonly toggleFileSearch = () => {
    this.fileSearchOpen = !this.fileSearchOpen;
    this.fileEditorMenuOpen = false;
    if (!this.fileSearchOpen) {
      this.fileSearchQuery = "";
      this.fileSearchMatchIndex = 0;
      return;
    }
    void this.updateComplete.then(() => {
      this.querySelector<HTMLInputElement>(".file-view__search input")?.focus();
    });
  };

  private readonly updateFileSearch = (query: string) => {
    this.fileSearchQuery = query;
    this.fileSearchMatchIndex = 0;
    void this.scrollToCurrentFileMatch();
  };

  private moveFileSearch(offset: number) {
    const matches = this.fileSearchMatches();
    if (matches.length === 0) {
      return;
    }
    this.fileSearchMatchIndex =
      (this.fileSearchMatchIndex + offset + matches.length) % matches.length;
    void this.scrollToCurrentFileMatch();
  }

  private readonly handleFileSearchKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.fileSearchOpen = false;
      this.fileSearchQuery = "";
      this.fileSearchMatchIndex = 0;
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      this.moveFileSearch(event.shiftKey ? -1 : 1);
    }
  };

  private readonly openInEditor = (editor: EditorId) => {
    const content = this.visibleContent;
    if (content?.kind !== "file") {
      return;
    }
    const absPath = absoluteFilePath(content);
    if (!absPath) {
      return;
    }
    this.fileEditorMenuOpen = false;
    // A custom-scheme window hands off to the OS without navigating this page.
    window.open(editorOpenUrl(editor, absPath, content.line));
  };

  private readonly copyFileContents = () => {
    const content = this.visibleContent;
    if (content?.kind !== "file") {
      return;
    }
    void copyToClipboard(content.content).then((copied) => {
      if (!copied) {
        return;
      }
      this.fileContentsCopied = true;
      if (this.copyFeedbackTimer) {
        globalThis.clearTimeout(this.copyFeedbackTimer);
      }
      this.copyFeedbackTimer = globalThis.setTimeout(() => {
        this.copyFeedbackTimer = null;
        this.fileContentsCopied = false;
      }, 1500);
    });
  };

  private readonly editFile = () => {
    const content = this.visibleContent;
    if (content?.kind !== "file" || !content.edit || !this.fileEditor) {
      return;
    }
    this.fileSavedContent = content.content;
    this.fileHash = content.edit.hash;
    this.fileDirty = false;
    this.fileSaveNotice = null;
    this.fileSearchOpen = false;
    this.fileSearchQuery = "";
    this.fileSearchMatchIndex = 0;
    this.fileEditorMenuOpen = false;
    this.fileEditing = true;
    this.fileEditor.setEditable(true);
    void this.updateComplete.then(() => this.fileEditor?.focus());
  };

  private readonly discardFileEdits = () => {
    if (!this.fileEditing || this.fileSaving) {
      return;
    }
    this.fileEditor?.setContent(this.fileSavedContent);
    const content = this.visibleContent;
    if (content?.kind === "file") {
      setRetainedFileDraft(content, null);
      this.fileHash = content.edit?.hash ?? "";
    }
    this.fileDirty = false;
    this.fileSaveNotice = null;
    this.fileEditing = false;
    this.fileEditor?.setEditable(false);
  };

  private updateSavedFile(content: FileSidebarContent, nextContent: string, hash: string) {
    this.fileSavedContent = nextContent;
    this.fileHash = hash;
    this.fileDirty = this.fileEditor?.getContent() !== nextContent;
    const draftContent = this.fileEditor?.getContent();
    setRetainedFileDraft(
      content,
      this.fileDirty && draftContent != null ? { content: draftContent, expectedHash: hash } : null,
    );
    this.fileSaveNotice = null;
    this.visibleContent = {
      ...content,
      content: nextContent,
      rawText: nextContent,
      ...(content.edit ? { edit: { ...content.edit, hash } } : {}),
    };
  }

  private async saveFileContent(
    content: FileSidebarContent,
    nextContent: string,
    expectedHash: string,
    version: number,
  ) {
    if (!content.edit) {
      return;
    }
    const outcome = await content.edit.save({ content: nextContent, expectedHash });
    if (version !== this.fileOperationVersion || this.visibleContent?.kind !== "file") {
      return;
    }
    if (outcome.ok) {
      this.updateSavedFile(this.visibleContent, nextContent, outcome.hash);
    } else if (outcome.code === "conflict") {
      this.fileSaveNotice = { kind: "conflict" };
    } else {
      this.fileSaveNotice = { kind: "error", message: outcome.message };
    }
  }

  private readonly saveFile = () => {
    const content = this.visibleContent;
    const editor = this.fileEditor;
    if (
      content?.kind !== "file" ||
      !content.edit ||
      !editor ||
      !this.fileEditing ||
      !this.fileDirty ||
      this.fileSaving
    ) {
      return;
    }
    const version = this.fileOperationVersion;
    this.fileSaving = true;
    this.fileSaveNotice = null;
    void this.saveFileContent(content, editor.getContent(), this.fileHash, version)
      .catch((error: unknown) => {
        if (version === this.fileOperationVersion) {
          this.fileSaveNotice = {
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      })
      .finally(() => {
        if (version === this.fileOperationVersion) {
          this.fileSaving = false;
        }
      });
  };

  private readonly reloadFile = () => {
    const content = this.visibleContent;
    const editor = this.fileEditor;
    if (content?.kind !== "file" || !content.edit || !editor || this.fileSaving) {
      return;
    }
    const version = this.fileOperationVersion;
    this.fileSaving = true;
    this.fileReloading = true;
    editor.setEditable(false);
    void content.edit
      .fetchLatest()
      .then((latest) => {
        if (version !== this.fileOperationVersion || this.visibleContent?.kind !== "file") {
          return;
        }
        if (!latest) {
          this.fileSaveNotice = { kind: "error", message: "Failed to reload the latest file." };
          return;
        }
        this.fileEditor?.setContent(latest.content);
        this.updateSavedFile(this.visibleContent, latest.content, latest.hash);
        // A reload can bring back content that no longer qualifies for edit
        // mode (e.g. the agent rewrote the file with mixed line endings);
        // drop the edit capability instead of letting a save corrupt it.
        if (!latest.editable && this.visibleContent?.kind === "file") {
          this.fileEditing = false;
          this.fileDirty = false;
          const { edit: _removed, ...readOnly } = this.visibleContent;
          this.visibleContent = readOnly;
        }
      })
      .catch((error: unknown) => {
        if (version === this.fileOperationVersion) {
          this.fileSaveNotice = {
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      })
      .finally(() => {
        if (version === this.fileOperationVersion) {
          this.fileReloading = false;
          this.fileSaving = false;
          this.fileEditor?.setEditable(this.fileEditing);
        }
      });
  };

  private readonly overwriteFile = () => {
    const content = this.visibleContent;
    const editor = this.fileEditor;
    if (content?.kind !== "file" || !content.edit || !editor || this.fileSaving) {
      return;
    }
    const version = this.fileOperationVersion;
    // Overwrite deliberately replaces whatever is on disk (even content that
    // would fail the edit gates) with the local editor text the user chose.
    const localContent = editor.getContent();
    this.fileSaving = true;
    void content.edit
      .fetchLatest()
      .then(async (latest) => {
        if (version !== this.fileOperationVersion) {
          return;
        }
        if (!latest) {
          this.fileSaveNotice = {
            kind: "error",
            message: "Failed to load the latest file before overwriting.",
          };
          return;
        }
        await this.saveFileContent(content, localContent, latest.hash, version);
      })
      .catch((error: unknown) => {
        if (version === this.fileOperationVersion) {
          this.fileSaveNotice = {
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      })
      .finally(() => {
        if (version === this.fileOperationVersion) {
          this.fileSaving = false;
        }
      });
  };

  private async upgradeToFullMessage(content: SidebarContent, version: number) {
    if (!hasFullMessageRequest(content) || !this.loadFullMessage) {
      return;
    }
    const request = content.fullMessageRequest;
    try {
      const result = await this.loadFullMessage(request);
      if (version !== this.requestVersion || this.content !== content) {
        return;
      }
      if (!result?.ok || !result.message || typeof result.message !== "object") {
        this.visibleContent = {
          ...content,
          unavailableReason: result?.unavailableReason ?? "not_found",
        };
        this.error = formatUnavailableReason(result?.unavailableReason ?? "not_found");
        return;
      }
      const fetchedText = extractMessageText(result.message);
      const rawText =
        fetchedText ??
        (typeof content.rawText === "string"
          ? content.rawText
          : content.kind === "markdown"
            ? content.content
            : null);
      this.visibleContent =
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
            };
      this.error = null;
    } catch (error) {
      if (version !== this.requestVersion || this.content !== content) {
        return;
      }
      this.error = `Failed to load full content: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  private readonly close = () => {
    this.dispatchEvent(new CustomEvent("chat-detail-panel-close", { bubbles: true }));
  };

  private readonly showRawText = () => {
    const rawContent = buildRawSidebarContent(this.visibleContent);
    if (!rawContent) {
      return;
    }
    this.requestVersion += 1;
    this.showingRawText = true;
    this.visibleContent = rawContent;
    this.error = null;
  };

  private readonly handlePanelClick = (event: Event) => {
    handleMarkdownCodeBlockCopy(event);
    const target = markdownFileLinkFromEvent(event);
    if (target) {
      this.onOpenWorkspaceFile?.(target);
    }
  };

  override render() {
    const matches = this.fileSearchMatches();
    const currentMatchIndex = matches.length
      ? Math.min(this.fileSearchMatchIndex, matches.length - 1)
      : 0;
    return html`
      <div @click=${this.handlePanelClick}>
        ${renderMarkdownSidebar({
          content: this.visibleContent,
          error: this.error,
          fileView: {
            copied: this.fileContentsCopied,
            currentMatchIndex,
            dirty: this.fileDirty,
            editorMenuOpen: this.fileEditorMenuOpen,
            editing: this.fileEditing,
            loadingEditor: this.fileEditorLoading,
            mountKey: this.fileOperationVersion,
            matches,
            query: this.fileSearchQuery,
            saveNotice: this.fileSaveNotice,
            saving: this.fileSaving,
            searchOpen: this.fileSearchOpen,
            onCopyContents: this.copyFileContents,
            onDiscard: this.discardFileEdits,
            onEdit: this.editFile,
            onNextMatch: () => this.moveFileSearch(1),
            onOpenEditor: this.openInEditor,
            onOverwrite: this.overwriteFile,
            onPreviousMatch: () => this.moveFileSearch(-1),
            onReload: this.reloadFile,
            onReveal: this.onRevealInWorkspace ?? undefined,
            onSave: this.saveFile,
            onSearchInput: this.updateFileSearch,
            onSearchKeydown: this.handleFileSearchKeydown,
            onEditorMenuOpenChange: (open) => {
              this.fileEditorMenuOpen = open;
            },
            onToggleSearch: this.toggleFileSearch,
          },
          canvasPluginSurfaceUrl: this.canvasPluginSurfaceUrl,
          embedSandboxMode: this.embedSandboxMode,
          allowExternalEmbedUrls: this.allowExternalEmbedUrls,
          onClose: this.close,
          onViewRawText: this.showRawText,
        })}
      </div>
    `;
  }
}

if (!customElements.get("openclaw-chat-detail-panel")) {
  customElements.define("openclaw-chat-detail-panel", ChatDetailPanel);
}
