import DOMPurify from "dompurify";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../../../components/icons.ts";
import {
  handleMarkdownCodeBlockCopy,
  highlightCode,
  markdownFileLinkFromEvent,
  toSanitizedMarkdownHtml,
} from "../../../components/markdown.ts";
import { extractRawText } from "../../../lib/chat/message-extract.ts";
import "../../../components/tooltip.ts";
import {
  resolveCanvasIframeUrl,
  resolveEmbedSandbox,
  type EmbedSandboxMode,
} from "../../../lib/chat/tool-display.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";

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

type FileSidebarContent = {
  kind: "file";
  path: string;
  name: string;
  content: string;
  root?: string | null;
  language?: string;
  line?: number | null;
  rawText?: string | null;
  fullMessageRequest?: SidebarFullMessageRequest;
  unavailableReason?: DetailUnavailableReason | null;
};

export type SidebarContent =
  | MarkdownSidebarContent
  | CanvasSidebarContent
  | ImageSidebarContent
  | FileSidebarContent;

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

export function buildRawSidebarContent(
  content: SidebarContent | null | undefined,
): SidebarContent | null {
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

export function splitHighlightedHtmlIntoLines(highlightedHtml: string): string[] {
  const lines = [""];
  const openSpans: string[] = [];
  const tokenPattern = /<span(?:\s[^>]*)?>|<\/span>|\n/g;
  let cursor = 0;
  for (const match of highlightedHtml.matchAll(tokenPattern)) {
    const lineIndex = lines.length - 1;
    lines[lineIndex] += highlightedHtml.slice(cursor, match.index);
    const token = match[0];
    if (token === "\n") {
      lines[lineIndex] += "</span>".repeat(openSpans.length);
      lines.push(openSpans.join(""));
    } else if (token === "</span>") {
      lines[lineIndex] += token;
      openSpans.pop();
    } else {
      lines[lineIndex] += token;
      openSpans.push(token);
    }
    cursor = match.index + token.length;
  }
  lines[lines.length - 1] += highlightedHtml.slice(cursor);
  return lines;
}

export function computeFileSearchMatches(content: string, query: string): number[] {
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

export function editorOpenUrl(
  editor: "cursor" | "vscode" | "windsurf" | "zed",
  absPath: string,
  line?: number | null,
): string {
  const normalizedPath = absPath.replaceAll("\\", "/");
  const urlPath = normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
  const encodedPath = urlPath
    .split("/")
    .map((segment, index) =>
      index === 1 && /^[a-z]:$/i.test(segment) ? segment : encodeURIComponent(segment),
    )
    .join("/");
  return `${editor}://file${encodedPath}${line ? `:${line}` : ""}`;
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

function highlightedFileLines(
  content: FileSidebarContent,
  targetLine: number | null | undefined,
  matches: readonly number[] = [],
  currentMatch: number | null = null,
): string {
  const highlighted = highlightCode(content.content, content.language ?? "");
  const lines = splitHighlightedHtmlIntoLines(highlighted);
  const matchingLines = new Set(matches);
  const joined = lines
    .map((line, index) => {
      const lineNumber = index + 1;
      const classes = ["file-view__line"];
      if (lineNumber === targetLine) {
        classes.push("file-view__line--target");
      }
      if (matchingLines.has(lineNumber)) {
        classes.push("file-view__line--match");
      }
      if (lineNumber === currentMatch) {
        classes.push("file-view__line--current");
      }
      const lineHtml = line || "\n";
      return `<div class="${classes.join(" ")}" data-line="${lineNumber}"><span class="file-view__ln">${lineNumber}</span><span class="file-view__lc">${lineHtml}</span></div>`;
    })
    .join("");
  return DOMPurify.sanitize(joined, {
    ALLOWED_TAGS: ["div", "span"],
    ALLOWED_ATTR: ["class", "data-line"],
  });
}

type FileViewControls = {
  copied: boolean;
  currentMatchIndex: number;
  editorMenuOpen: boolean;
  matches: number[];
  query: string;
  searchOpen: boolean;
  onCopyContents: () => void;
  onNextMatch: () => void;
  onOpenEditor: (editor: "cursor" | "vscode" | "windsurf" | "zed") => void;
  onPreviousMatch: () => void;
  onReveal?: (path: string) => void;
  onSearchInput: (query: string) => void;
  onSearchKeydown: (event: KeyboardEvent) => void;
  onToggleEditorMenu: () => void;
  onToggleSearch: () => void;
};

function renderFileSidebarContent(
  content: FileSidebarContent,
  onViewRawText: () => void,
  controls?: FileViewControls,
) {
  const currentMatch = controls?.matches[controls.currentMatchIndex] ?? null;
  const highlightedLines = highlightedFileLines(
    content,
    content.line,
    controls?.matches,
    currentMatch,
  );
  const absolutePath = absoluteFilePath(content);
  const matchNumber = controls?.matches.length ? controls.currentMatchIndex + 1 : 0;
  const gutterDigits = String(Math.max(content.content.split("\n").length, 1)).length;
  return html`
    <section class="sidebar-file-view">
      <div class="sidebar-file-view__path-bar">
        <div class="sidebar-file-view__path-field">
          <span class="sidebar-file-view__path" title=${content.path}>${content.path}</span>
          <openclaw-tooltip content="Copy path">
            <button
              class="btn btn--sm sidebar-file-view__action"
              type="button"
              aria-label="Copy path"
              @click=${() => void copyToClipboard(content.path)}
            >
              ${icons.copy}
            </button>
          </openclaw-tooltip>
        </div>
        ${controls
          ? html`
              <div class="sidebar-file-view__actions">
                <openclaw-tooltip content="Search in file">
                  <button
                    class="btn btn--sm sidebar-file-view__action"
                    type="button"
                    aria-label="Search in file"
                    aria-pressed=${String(controls.searchOpen)}
                    @click=${controls.onToggleSearch}
                  >
                    ${icons.search}
                  </button>
                </openclaw-tooltip>
                ${controls.onReveal
                  ? html`
                      <openclaw-tooltip content="Show in Files">
                        <button
                          class="btn btn--sm sidebar-file-view__action"
                          type="button"
                          aria-label="Show in Files"
                          @click=${() => controls.onReveal?.(content.path)}
                        >
                          ${icons.folder}
                        </button>
                      </openclaw-tooltip>
                    `
                  : nothing}
                <div class="sidebar-file-view__editor">
                  <openclaw-tooltip
                    .content=${absolutePath ? "Open in editor" : "Workspace root unknown"}
                  >
                    <button
                      class="btn btn--sm sidebar-file-view__action"
                      type="button"
                      aria-label=${absolutePath ? "Open in editor" : "Workspace root unknown"}
                      aria-haspopup="menu"
                      aria-expanded=${String(controls.editorMenuOpen)}
                      ?disabled=${!absolutePath}
                      @click=${controls.onToggleEditorMenu}
                    >
                      ${icons.externalLink}
                    </button>
                  </openclaw-tooltip>
                  ${controls.editorMenuOpen && absolutePath
                    ? html`
                        <div class="sidebar-file-view__editor-menu" role="menu">
                          ${(["cursor", "vscode", "windsurf", "zed"] as const).map(
                            (editor) => html`
                              <button
                                class="sidebar-file-view__editor-item"
                                type="button"
                                role="menuitem"
                                @click=${() => controls.onOpenEditor(editor)}
                              >
                                ${{
                                  cursor: "Cursor",
                                  vscode: "VS Code",
                                  windsurf: "Windsurf",
                                  zed: "Zed",
                                }[editor]}
                              </button>
                            `,
                          )}
                        </div>
                      `
                    : nothing}
                </div>
                <openclaw-tooltip content="Copy file contents">
                  <button
                    class="btn btn--sm sidebar-file-view__action ${controls.copied ? "copied" : ""}"
                    type="button"
                    aria-label=${controls.copied ? "Copied" : "Copy file contents"}
                    @click=${controls.onCopyContents}
                  >
                    ${controls.copied ? icons.check : icons.copy}
                  </button>
                </openclaw-tooltip>
              </div>
            `
          : nothing}
      </div>
      ${controls?.searchOpen
        ? html`
            <div class="file-view__search">
              <input
                type="search"
                aria-label="Search in file"
                placeholder="Search"
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
                aria-label="Previous match"
                ?disabled=${controls.matches.length === 0}
                @click=${controls.onPreviousMatch}
              >
                ${icons.chevronDown}
              </button>
              <button
                class="btn btn--sm file-view__search-action"
                type="button"
                aria-label="Next match"
                ?disabled=${controls.matches.length === 0}
                @click=${controls.onNextMatch}
              >
                ${icons.chevronDown}
              </button>
            </div>
          `
        : nothing}
      <div class="file-view" style="--file-view-ln-digits: ${gutterDigits}">
        ${unsafeHTML(highlightedLines)}
      </div>
      <div class="sidebar-file-view__footer">
        <button @click=${onViewRawText} class="btn btn--sm" type="button">View Raw Text</button>
      </div>
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

export function renderMarkdownSidebar(props: MarkdownSidebarProps) {
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
          : content?.kind === "markdown"
            ? "Markdown Preview"
            : "Tool Details";
  return html`
    <div class="sidebar-panel">
      <div class="sidebar-header">
        <div class="sidebar-title">${title}</div>
        <openclaw-tooltip content="Close sidebar">
          <button @click=${props.onClose} class="btn" type="button" aria-label="Close sidebar">
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
                      View Raw Text
                    </button>
                  `
                : nothing}
            `
          : content
            ? content.kind === "file"
              ? renderFileSidebarContent(content, props.onViewRawText, props.fileView)
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
                                View Raw Text
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
                                  View Raw Text
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
                              <span>Rendered Markdown</span>
                            </div>
                            <div class="sidebar-markdown-shell__hint">
                              Sanitized rich-text preview for quick reading.
                            </div>
                          </div>
                          <button @click=${props.onViewRawText} class="btn btn--sm" type="button">
                            View Raw Text
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
                                No previewable markdown content.
                              </div>
                            `}
                      </section>
                    `
            : html` <div class="muted">No content available</div> `}
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

  private requestVersion = 0;
  private showingRawText = false;
  private copyFeedbackTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("pointerdown", this.handleDocumentPointerDown);
  }

  override disconnectedCallback() {
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown);
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
    if (this.copyFeedbackTimer) {
      globalThis.clearTimeout(this.copyFeedbackTimer);
      this.copyFeedbackTimer = null;
    }
  }

  protected override updated(changed: Map<string, unknown>) {
    if (changed.has("content")) {
      const content = this.visibleContent;
      if (content?.kind === "file" && content.line != null) {
        void this.scrollToFileLine(content);
      }
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

  private async scrollToFileLine(content: FileSidebarContent) {
    await this.updateComplete;
    if (this.visibleContent !== content || this.showingRawText) {
      return;
    }
    this.querySelector(".file-view__line--target")?.scrollIntoView?.({ block: "center" });
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
    this.querySelector(".file-view__line--current")?.scrollIntoView?.({ block: "center" });
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

  private readonly openInEditor = (editor: "cursor" | "vscode" | "windsurf" | "zed") => {
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
            editorMenuOpen: this.fileEditorMenuOpen,
            matches,
            query: this.fileSearchQuery,
            searchOpen: this.fileSearchOpen,
            onCopyContents: this.copyFileContents,
            onNextMatch: () => this.moveFileSearch(1),
            onOpenEditor: this.openInEditor,
            onPreviousMatch: () => this.moveFileSearch(-1),
            onReveal: this.onRevealInWorkspace ?? undefined,
            onSearchInput: this.updateFileSearch,
            onSearchKeydown: this.handleFileSearchKeydown,
            onToggleEditorMenu: () => {
              this.fileEditorMenuOpen = !this.fileEditorMenuOpen;
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
