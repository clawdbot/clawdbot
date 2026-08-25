import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { localEditorFilePath } from "../../../app/native-editor-locality.runtime.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import type { EditorId } from "../../../lib/editor-links.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import { renderChatSidebarEditorMenu } from "./chat-sidebar-editor-menu.ts";

type FileSidebarContent = Extract<SidebarContent, { kind: "file" }>;

type RetainedFileDraft = {
  content: string;
  expectedHash: string;
};

const retainedFileDrafts = new Map<string, RetainedFileDraft>();

function retainedFileDraftKey(content: FileSidebarContent): string {
  return content.draftKey ?? `${content.root ?? ""}\u0000${content.path}`;
}

export function readFileDraft(content: FileSidebarContent): RetainedFileDraft | undefined {
  return retainedFileDrafts.get(retainedFileDraftKey(content));
}

export function setFileDraft(content: FileSidebarContent, draft: RetainedFileDraft | null) {
  const key = retainedFileDraftKey(content);
  retainedFileDrafts.delete(key);
  if (!draft) {
    return;
  }
  retainedFileDrafts.set(key, draft);
}

export function hasUniformLineEndings(content: string): boolean {
  const crlf = content.split("\r\n").length - 1;
  const bareCr = (content.match(/\r(?!\n)/g) ?? []).length;
  const bareLf = (content.match(/(?<!\r)\n/g) ?? []).length;
  return [crlf, bareCr, bareLf].filter((count) => count > 0).length <= 1;
}

export function computeFileMatches(content: string, query: string): number[] {
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

export type FileCopyAction = "path" | "contents";
type FileCopyFeedback = Partial<Record<FileCopyAction, "copied" | "failed">>;
export const emptyCopyFeedback: FileCopyFeedback = {};

export type FileViewControls = {
  copyFeedback: FileCopyFeedback;
  currentMatchIndex: number;
  dirty: boolean;
  execNode: string | null;
  editorMenuOpen: boolean;
  editing: boolean;
  loadingEditor: boolean;
  mountKey: number;
  matches: number[];
  query: string;
  saveNotice: { kind: "conflict" } | { kind: "error"; message: string } | null;
  saving: boolean;
  searchOpen: boolean;
  onCopy: (action: FileCopyAction) => void;
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

function renderFileCopyButton(action: FileCopyAction, controls?: FileViewControls) {
  const feedback = controls?.copyFeedback[action];
  const label = t(
    feedback === "failed"
      ? "common.copyFailed"
      : feedback === "copied"
        ? "common.copied"
        : action === "path"
          ? "chat.detailPanel.copyPath"
          : "chat.detailPanel.copyContents",
  );
  return html`
    <openclaw-tooltip .content=${label}>
      <button
        class="btn btn--sm sidebar-file-view__action ${feedback === "copied" ? "copied" : ""}"
        type="button"
        aria-label=${label}
        @click=${() => controls?.onCopy(action)}
      >
        ${feedback === "copied" ? icons.check : icons.copy}
      </button>
    </openclaw-tooltip>
  `;
}

export function renderSidebarFile(
  content: FileSidebarContent,
  onViewRawText: () => void,
  controls?: FileViewControls,
) {
  const absolutePath = localEditorFilePath(content, controls?.execNode);
  const matchNumber = controls?.matches.length ? controls.currentMatchIndex + 1 : 0;
  return html`
    <section class="sidebar-file-view">
      <div class="sidebar-file-view__path-bar">
        <div class="sidebar-file-view__path-field">
          <span class="sidebar-file-view__path" title=${content.path}>${content.path}</span>
          ${renderFileCopyButton("path", controls)}
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
                        ${controls.saving ? t("common.saving") : t("common.save")}
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
                      ${renderFileCopyButton("contents", controls)}
                    `}
              </div>
            `
          : nothing}
      </div>
      ${Object.values(controls?.copyFeedback ?? {}).includes("failed")
        ? html`<div class="file-view__save-notice" role="alert">${t("common.copyFailed")}</div>`
        : nothing}
      ${controls?.searchOpen
        ? html`
            <div class="file-view__search">
              <input
                type="search"
                aria-label=${t("chat.detailPanel.searchInFile")}
                placeholder=${t("common.search")}
                .value=${controls.query}
                @input=${(event: Event & { currentTarget: HTMLInputElement }) =>
                  controls.onSearchInput(event.currentTarget.value)}
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
                  ? t("chat.detailPanel.fileChanged")
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
