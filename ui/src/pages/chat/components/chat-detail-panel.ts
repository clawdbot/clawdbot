import { property, state } from "lit/decorators.js";
import {
  localEditorFilePath,
  observeNativeGateway,
} from "../../../app/native-editor-locality.runtime.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.ts";
import type { SessionLinkTarget } from "../../../components/markdown-session-links.ts";
import { t } from "../../../i18n/index.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import { type EditorId, openEditor } from "../../../lib/editor-links.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { releaseChatMediaResourceSubscriber } from "./chat-message-media.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import {
  buildRawContent,
  handleSidebarClick,
  handleSidebarKeydown,
  renderSidebarPanel,
} from "./chat-sidebar-content.ts";
import {
  computeFileMatches,
  emptyCopyFeedback,
  readFileDraft,
  setFileDraft,
  type FileCopyAction,
} from "./chat-sidebar-file-view.ts";
import type { FileEditorViewHandle } from "./file-editor-view.ts";

type FileSidebarContent = Extract<SidebarContent, { kind: "file" }>;
type ChatDetailPanelContent = Exclude<SidebarContent, { kind: "task" }>;

class ChatDetailPanel extends OpenClawLightDomElement {
  @property({ attribute: false }) content: ChatDetailPanelContent | null = null;
  @property({ attribute: false }) execNode: string | null = null;
  @property() basePath = "";
  @property() canvasPluginSurfaceUrl: string | null = null;
  @property() embedSandboxMode: EmbedSandboxMode = "scripts";
  @property({ type: Boolean }) allowExternalEmbedUrls = false;
  @property({ type: Boolean }) embedded = false;
  @property({ attribute: false }) onOpenWorkspaceFile?:
    | ((target: { path: string; line?: number | null }) => void)
    | null = null;
  @property({ attribute: false }) onOpenSessionLink?: ((target: SessionLinkTarget) => void) | null =
    null;
  @property({ attribute: false }) onRevealInWorkspace?: ((path: string) => void) | null = null;
  @property({ attribute: false }) onOpenImage?: ((item: ImageLightboxItem) => void) | null = null;

  @state() private visibleContent: ChatDetailPanelContent | null = null;
  @state() private error: string | null = null;
  @state() private fileSearchOpen = false;
  @state() private fileSearchQuery = "";
  @state() private fileSearchMatchIndex = 0;
  @state() private fileEditorMenuOpen = false;
  @state() private fileCopyFeedback = emptyCopyFeedback;
  @state() private fileEditorLoading = false;
  @state() private fileEditing = false;
  @state() private fileDirty = false;
  @state() private fileReloading = false;
  @state() private fileSaving = false;
  @state() private fileSaveNotice:
    | { kind: "conflict" }
    | { kind: "error"; message: string }
    | null = null;

  private fileOperationVersion = 0;
  private showingRawText = false;
  private fileEditor: FileEditorViewHandle | null = null;
  private fileEditorLoad: Promise<void> | null = null;
  private fileDraftContent: string | null = null;
  private fileSavedContent = "";
  private fileHash = "";
  private readonly copyAttempts = new Map<FileCopyAction, number>();
  private readonly copyFeedbackTimers = new Map<
    FileCopyAction,
    ReturnType<typeof globalThis.setTimeout>
  >();
  private readonly requestAttachmentUpdate = () => this.requestUpdate();

  constructor() {
    super();
    observeNativeGateway(this);
  }

  override connectedCallback() {
    super.connectedCallback();
    this.fileCopyFeedback = emptyCopyFeedback;
    document.addEventListener("pointerdown", this.handleDocumentPointerDown);
  }

  override disconnectedCallback() {
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown);
    this.destroyFileEditor();
    this.clearFileCopyFeedback();
    releaseChatMediaResourceSubscriber(this.requestAttachmentUpdate);
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: Map<string, unknown>) {
    if (!changed.has("content")) {
      return;
    }
    releaseChatMediaResourceSubscriber(this.requestAttachmentUpdate);
    this.visibleContent = this.content;
    this.error = null;
    this.showingRawText = false;
    this.fileSearchOpen = false;
    this.fileSearchQuery = "";
    this.fileSearchMatchIndex = 0;
    this.fileEditorMenuOpen = false;
    this.clearFileCopyFeedback();
    this.fileCopyFeedback = emptyCopyFeedback;
    this.fileOperationVersion += 1;
    this.fileEditing = false;
    this.fileDirty = false;
    this.fileReloading = false;
    this.fileSaving = false;
    this.fileSaveNotice = null;
    const retainedDraft =
      this.content?.kind === "file" && this.content.edit ? readFileDraft(this.content) : undefined;
    const restoredDraft =
      this.content?.kind === "file" && retainedDraft?.content !== this.content.content
        ? retainedDraft
        : undefined;
    if (retainedDraft && !restoredDraft && this.content?.kind === "file") {
      setFileDraft(this.content, null);
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
  }

  private clearFileCopyFeedback() {
    for (const timer of this.copyFeedbackTimers.values()) {
      globalThis.clearTimeout(timer);
    }
    this.copyFeedbackTimers.clear();
    // Keep attempt tokens monotonic so old work cannot become current after reconnection.
    for (const [action, attempt] of this.copyAttempts) {
      this.copyAttempts.set(action, attempt + 1);
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
          setFileDraft(
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
      ? computeFileMatches(content.content, this.fileSearchQuery)
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
    const absPath = localEditorFilePath(content, this.execNode);
    if (!absPath) {
      return;
    }
    this.fileEditorMenuOpen = false;
    openEditor(editor, absPath, content.line);
  };

  private readonly copyFileValue = (action: FileCopyAction) => {
    const content = this.visibleContent;
    if (content?.kind !== "file") {
      return;
    }
    const attempt = (this.copyAttempts.get(action) ?? 0) + 1;
    this.copyAttempts.set(action, attempt);
    void copyToClipboard(action === "path" ? content.path : content.content).then((copied) => {
      // A newer copy or file selection owns feedback; stale completions must stay invisible.
      if (
        this.copyAttempts.get(action) !== attempt ||
        this.visibleContent !== content ||
        !this.isConnected
      ) {
        return;
      }
      this.fileCopyFeedback = {
        ...this.fileCopyFeedback,
        [action]: copied ? "copied" : "failed",
      };
      globalThis.clearTimeout(this.copyFeedbackTimers.get(action));
      this.copyFeedbackTimers.set(
        action,
        globalThis.setTimeout(
          () => {
            this.copyFeedbackTimers.delete(action);
            this.fileCopyFeedback = { ...this.fileCopyFeedback, [action]: undefined };
          },
          copied ? 1500 : 2000,
        ),
      );
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
      setFileDraft(content, null);
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
    setFileDraft(
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
            message: formatUiError(error),
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
          this.fileSaveNotice = {
            kind: "error",
            message: t("chat.detailPanel.reloadFailed"),
          };
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
            message: formatUiError(error),
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
            message: t("chat.detailPanel.overwriteLoadFailed"),
          };
          return;
        }
        await this.saveFileContent(content, localContent, latest.hash, version);
      })
      .catch((error: unknown) => {
        if (version === this.fileOperationVersion) {
          this.fileSaveNotice = {
            kind: "error",
            message: formatUiError(error),
          };
        }
      })
      .finally(() => {
        if (version === this.fileOperationVersion) {
          this.fileSaving = false;
        }
      });
  };

  private readonly close = () => {
    this.dispatchEvent(new CustomEvent("chat-detail-panel-close", { bubbles: true }));
  };

  private readonly showRawText = () => {
    const rawContent = buildRawContent(this.visibleContent);
    if (!rawContent) {
      return;
    }
    this.showingRawText = true;
    this.visibleContent = rawContent;
    this.error = null;
  };

  private readonly handlePanelClick = (event: MouseEvent) => {
    handleSidebarClick(event, this);
  };

  private readonly handlePanelKeyDown = (event: KeyboardEvent) => {
    handleSidebarKeydown(event, this);
  };

  override render() {
    const matches = this.fileSearchMatches();
    const currentMatchIndex = matches.length
      ? Math.min(this.fileSearchMatchIndex, matches.length - 1)
      : 0;
    return renderSidebarPanel({
      content: this.visibleContent,
      error: this.error,
      fileView: {
        copyFeedback: this.fileCopyFeedback,
        currentMatchIndex,
        dirty: this.fileDirty,
        execNode: this.execNode,
        editorMenuOpen: this.fileEditorMenuOpen,
        editing: this.fileEditing,
        loadingEditor: this.fileEditorLoading,
        mountKey: this.fileOperationVersion,
        matches,
        query: this.fileSearchQuery,
        saveNotice: this.fileSaveNotice,
        saving: this.fileSaving,
        searchOpen: this.fileSearchOpen,
        onCopy: this.copyFileValue,
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
      embedded: this.embedded,
      onClose: this.close,
      onOpenImage: this.onOpenImage ?? undefined,
      onViewRawText: this.showRawText,
      onClick: this.handlePanelClick,
      onKeydown: this.handlePanelKeyDown,
      onAttachmentUpdate: this.requestAttachmentUpdate,
    });
  }
}

if (!customElements.get("openclaw-chat-detail-panel")) {
  customElements.define("openclaw-chat-detail-panel", ChatDetailPanel);
}
