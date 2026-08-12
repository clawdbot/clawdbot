// Session diff panel: renders selectable branch, working-tree, and commit diffs.
import { Task, TaskStatus } from "@lit/task";
import { html, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import type {
  SessionDiffFile,
  SessionsDiffResult,
} from "../../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import {
  pairSessionDiffLines,
  type SessionSplitDiffRow,
} from "../../../lib/chat/session-diff-split.ts";
import { parseSessionDiffPatch, type ParsedFilePatch } from "../../../lib/chat/session-diff.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import { openEditor } from "../../../lib/editor-links.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { getSafeLocalStorage } from "../../../local-storage.ts";
import { renderDiffBlock, renderDiffStatChips } from "./chat-diff-render.ts";
import type {
  SessionDiffMenuAction,
  SessionDiffMenuData,
  SessionDiffMenuDraft,
  SessionDiffScope,
} from "./session-diff-menus.ts";
import "./session-diff-menus.ts";
import { renderSessionSplitDiff } from "./session-diff-render.ts";

export type SessionDiffLoader = (params: SessionDiffScope) => Promise<SessionsDiffResult>;

type FileView = {
  file: SessionDiffFile;
  parsed: ParsedFilePatch | null;
};

type SessionDiffTaskResult = {
  result: SessionsDiffResult;
  views: FileView[];
};

type SessionDiffPreferences = { split: boolean; wrap: boolean };
const PREFERENCES_KEY = "openclaw.control.sessionDiff.v1";

function loadPreferences(): SessionDiffPreferences {
  try {
    const parsed = JSON.parse(getSafeLocalStorage()?.getItem(PREFERENCES_KEY) ?? "null") as {
      split?: unknown;
      wrap?: unknown;
    } | null;
    return { split: parsed?.split === true, wrap: parsed?.wrap === true };
  } catch {
    return { split: false, wrap: false };
  }
}

function savePreferences(preferences: SessionDiffPreferences): void {
  try {
    getSafeLocalStorage()?.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Preferences are opportunistic; restricted storage must not break the viewer.
  }
}

function statusLabel(file: SessionDiffFile): string {
  switch (file.status) {
    case "added":
      return t("chat.sessionDiff.statusAdded");
    case "deleted":
      return t("chat.sessionDiff.statusDeleted");
    case "renamed":
      return t("chat.sessionDiff.statusRenamed");
    default:
      return t("chat.sessionDiff.statusModified");
  }
}

function statusLetter(file: SessionDiffFile): string {
  return file.status === "added"
    ? "A"
    : file.status === "deleted"
      ? "D"
      : file.status === "renamed"
        ? "R"
        : "M";
}

function diffStat(file: Pick<SessionDiffFile, "additions" | "deletions">) {
  const modified = Math.min(file.additions, file.deletions);
  return {
    added: file.additions - modified,
    removed: file.deletions - modified,
    modified,
  };
}

function totalDiffStat(files: readonly SessionDiffFile[]) {
  return files.reduce(
    (total, file) => {
      const stat = diffStat(file);
      total.added += stat.added;
      total.removed += stat.removed;
      total.modified += stat.modified;
      return total;
    },
    { added: 0, removed: 0, modified: 0 },
  );
}

function splitPath(filePath: string): { directory: string; name: string } {
  const normalized = filePath.replaceAll("\\", "/");
  const separator = normalized.lastIndexOf("/");
  return separator < 0
    ? { directory: "", name: normalized }
    : { directory: normalized.slice(0, separator), name: normalized.slice(separator + 1) };
}

function absolutePath(root: string, filePath: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${filePath.replace(/^[\\/]+/, "")}`;
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

class SessionDiffPanel extends OpenClawLightDomElement {
  @property({ attribute: false }) loader: SessionDiffLoader | null = null;
  @property({ attribute: false }) openFile: ((path: string) => void) | null = null;
  @property({ attribute: false }) revealFile: ((path: string) => void) | null = null;

  @state() private collapsedPaths = new Set<string>();
  @state() private menu: SessionDiffMenuData | null = null;
  @state() private scope: SessionDiffScope = { scope: "all" };
  @state() private split = loadPreferences().split;
  @state() private wrap = loadPreferences().wrap;

  private readonly splitCache = new WeakMap<ParsedFilePatch, SessionSplitDiffRow[]>();

  private readonly diffTask = new Task(this, {
    args: () =>
      [
        this.loader,
        this.scope.scope,
        this.scope.scope === "commit" ? this.scope.commit : null,
      ] as const,
    task: async ([loader, scope, commit]): Promise<SessionDiffTaskResult | null> => {
      if (!loader) {
        return null;
      }
      const params: SessionDiffScope = scope === "commit" ? { scope, commit: commit! } : { scope };
      const result = await loader(params);
      return {
        result,
        views: result.files.map((file) => ({
          file,
          parsed: file.patch
            ? parseSessionDiffPatch(file.patch, (count) =>
                t("chat.sessionDiff.unmodifiedLines", { count: String(count) }),
              )
            : null,
        })),
      };
    },
    onComplete: (value) => {
      const currentPaths = new Set(value?.views.map((view) => view.file.path) ?? []);
      this.collapsedPaths = new Set(
        [...this.collapsedPaths].filter((path) => currentPaths.has(path)),
      );
    },
  });

  private get loading(): boolean {
    return this.diffTask.status === TaskStatus.PENDING;
  }

  private refresh(): Promise<void> {
    return this.diffTask.run();
  }

  private toggleFile(path: string): void {
    const next = new Set(this.collapsedPaths);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    this.collapsedPaths = next;
  }

  private openAnchoredMenu(event: Event, menu: SessionDiffMenuDraft, upward = false): void {
    event.stopPropagation();
    const trigger = event.currentTarget;
    if (!(trigger instanceof HTMLElement)) {
      return;
    }
    const bounds = trigger.getBoundingClientRect();
    this.menu = {
      ...menu,
      anchor: { x: upward ? bounds.left : bounds.right, y: upward ? bounds.top : bounds.bottom },
      trigger,
    } as SessionDiffMenuData;
  }

  private handleMenuAction(action: SessionDiffMenuAction): void {
    switch (action.kind) {
      case "collapse-all": {
        const views = this.diffTask.value?.views ?? [];
        this.collapsedPaths = new Set(views.map((view) => view.file.path));
        return;
      }
      case "expand-all":
        this.collapsedPaths = new Set();
        return;
      case "toggle-wrap":
        this.wrap = !this.wrap;
        savePreferences({ split: this.split, wrap: this.wrap });
        return;
      case "toggle-split":
        this.split = !this.split;
        savePreferences({ split: this.split, wrap: this.wrap });
        return;
      case "scope":
        this.scope = action.value;
        return;
      case "copy-path":
        void copyToClipboard(action.path);
        return;
      case "open-file":
        this.openFile?.(action.path);
        return;
      case "reveal-file":
        this.revealFile?.(action.path);
        return;
      case "open-editor":
        openEditor(action.editor, action.path);
    }
  }

  private renderSummary(result: SessionsDiffResult): TemplateResult {
    const branchLabel =
      result.baseRef && result.branch && result.baseRef !== result.branch
        ? `${result.baseRef} → ${result.branch}`
        : (result.branch ?? result.baseRef ?? "");
    const syncCommand =
      result.root && result.branch
        ? `git fetch ${shellArgument(result.root)} ${shellArgument(result.branch)} && git checkout FETCH_HEAD`
        : null;
    return html`
      <div class="session-diff__summary">
        <span class="session-diff__branch" title=${result.root ?? ""}>
          ${icons.gitBranch}
          <span class="session-diff__branch-label">${branchLabel}</span>
        </span>
        ${renderDiffStatChips(totalDiffStat(result.files))}
        <span class="session-diff__summary-spacer"></span>
        ${syncCommand && result.root && result.branch
          ? html`<button
              class="btn btn--ghost btn--sm session-diff__toolbar-button"
              type="button"
              @click=${(event: Event) =>
                this.openAnchoredMenu(event, {
                  kind: "sync",
                  command: syncCommand,
                  root: result.root!,
                  branch: result.branch!,
                })}
            >
              ${t("chat.sessionDiff.sync")} ${icons.chevronDown}
            </button>`
          : nothing}
        <openclaw-tooltip .content=${t("chat.sessionDiff.viewOptions")}>
          <button
            class="btn btn--ghost btn--icon session-diff__toolbar-icon"
            type="button"
            aria-label=${t("chat.sessionDiff.viewOptions")}
            @click=${(event: Event) =>
              this.openAnchoredMenu(event, {
                kind: "view",
                split: this.split,
                wrap: this.wrap,
              })}
          >
            ${icons.moreHorizontal}
          </button>
        </openclaw-tooltip>
        <openclaw-tooltip .content=${t("chat.sessionDiff.refresh")}>
          <button
            class="btn btn--ghost btn--icon session-diff__refresh"
            type="button"
            aria-label=${t("chat.sessionDiff.refresh")}
            ?disabled=${this.loading}
            @click=${() => void this.refresh()}
          >
            ${icons.refresh}
          </button>
        </openclaw-tooltip>
      </div>
    `;
  }

  private splitRows(parsed: ParsedFilePatch): SessionSplitDiffRow[] {
    const cached = this.splitCache.get(parsed);
    if (cached) {
      return cached;
    }
    const rows = pairSessionDiffLines(parsed.lines);
    this.splitCache.set(parsed, rows);
    return rows;
  }

  private renderFileBody(view: FileView): TemplateResult {
    const { file, parsed } = view;
    if (file.binary === true) {
      return html`<div class="session-diff__note">${t("chat.sessionDiff.binaryFile")}</div>`;
    }
    if (!parsed) {
      return html`<div class="session-diff__note">${t("chat.sessionDiff.tooLarge")}</div>`;
    }
    return html`
      ${this.split ? renderSessionSplitDiff(this.splitRows(parsed)) : renderDiffBlock(parsed.lines)}
      ${parsed.truncated
        ? html`<div class="session-diff__note">${t("chat.sessionDiff.truncatedFile")}</div>`
        : nothing}
    `;
  }

  private renderFile(view: FileView, result: SessionsDiffResult): TemplateResult {
    const { file } = view;
    const collapsed = this.collapsedPaths.has(file.path);
    const { directory, name } = splitPath(file.path);
    const absPath = result.root ? absolutePath(result.root, file.path) : undefined;
    const pathTitle = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
    return html`
      <section class="session-diff__file" data-status=${file.status}>
        <div class="session-diff__file-header">
          <button
            class="session-diff__file-toggle"
            type="button"
            aria-expanded=${String(!collapsed)}
            title=${pathTitle}
            @click=${() => this.toggleFile(file.path)}
          >
            <span class="session-diff__chevron ${collapsed ? "" : "session-diff__chevron--open"}">
              ${icons.chevronRight}
            </span>
            <span
              class="session-diff__status session-diff__status--${file.status}"
              title=${statusLabel(file)}
              >${statusLetter(file)}</span
            >
            <span class="session-diff__path">
              ${file.oldPath
                ? html`<span class="session-diff__old-path">${file.oldPath} →</span>`
                : nothing}
              <span class="session-diff__filename">${name}</span>
              ${directory
                ? html`<span class="session-diff__directory">${directory}</span>`
                : nothing}
            </span>
            ${file.untracked === true
              ? html`<span class="session-diff__badge">${t("chat.sessionDiff.untracked")}</span>`
              : nothing}
            ${renderDiffStatChips(diffStat(file))}
          </button>
          <button
            class="btn btn--ghost btn--icon session-diff__file-menu"
            type="button"
            aria-label=${t("chat.sessionDiff.fileActions", { path: file.path })}
            @click=${(event: Event) =>
              this.openAnchoredMenu(event, {
                kind: "file",
                path: file.path,
                ...(absPath ? { absolutePath: absPath } : {}),
                canOpenFile: Boolean(this.openFile),
                canReveal: Boolean(this.revealFile),
              })}
          >
            ${icons.moreHorizontal}
          </button>
        </div>
        ${collapsed
          ? nothing
          : html`<div
              class="session-diff__file-body"
              style=${`contain-intrinsic-size:auto ${Math.max(
                80,
                Math.min(12_000, (view.parsed?.lines.length ?? 2) * 19),
              )}px`}
            >
              ${this.renderFileBody(view)}
            </div>`}
      </section>
    `;
  }

  private scopeTitle(result: SessionsDiffResult): string {
    const scope = this.scope;
    if (scope.scope === "uncommitted") {
      return t("chat.sessionDiff.uncommitted");
    }
    if (scope.scope === "commit") {
      const commit = result.commits?.find((entry) => entry.sha === scope.commit);
      return commit ? `${commit.sha} ${commit.subject}` : scope.commit;
    }
    return t("chat.sessionDiff.allChanges");
  }

  private renderFooter(result: SessionsDiffResult): TemplateResult {
    const branchLabel = result.branch ?? result.baseRef ?? t("chat.sessionDiff.allChanges");
    const label =
      result.aheadCount && result.baseRef
        ? t("chat.sessionDiff.commitsAhead", {
            count: String(result.aheadCount),
            base: result.baseRef,
          })
        : branchLabel;
    return html`<button
      class="session-diff__footer"
      type="button"
      aria-label=${t("chat.sessionDiff.scopeMenu")}
      @click=${(event: Event) =>
        this.openAnchoredMenu(event, { kind: "scope", active: this.scope, result }, true)}
    >
      <span>${label}</span>${icons.chevronUp}
    </button>`;
  }

  private renderBody(): TemplateResult {
    if (this.diffTask.status === TaskStatus.ERROR) {
      const error = this.diffTask.error;
      return html`<div class="callout danger">
        ${error instanceof Error ? error.message : String(error)}
      </div>`;
    }
    const value = this.diffTask.value;
    if (!value) {
      return html`<div class="session-diff__note">${t("chat.sessionDiff.loading")}</div>`;
    }
    const { result, views } = value;
    if (result.unavailableReason === "not_git") {
      return html`<div class="session-diff__note">${t("chat.sessionDiff.notGit")}</div>`;
    }
    if (result.unavailableReason === "unknown_session") {
      return html`<div class="session-diff__note">${t("chat.sessionDiff.unknownSession")}</div>`;
    }
    return html`
      ${this.renderSummary(result)}
      <div class="session-diff__section-title">${this.scopeTitle(result)}</div>
      <div class="session-diff__files">
        ${result.unavailableReason === "unknown_commit"
          ? html`<div class="session-diff__note">${t("chat.sessionDiff.unknownCommit")}</div>`
          : result.files.length === 0
            ? html`<div class="session-diff__note">${t("chat.sessionDiff.empty")}</div>`
            : views.map((view) => this.renderFile(view, result))}
        ${result.truncated === true
          ? html`<div class="session-diff__note">${t("chat.sessionDiff.truncatedResult")}</div>`
          : nothing}
      </div>
      ${this.renderFooter(result)}
    `;
  }

  override render() {
    return html`
      <div
        class="session-diff ${this.wrap ? "session-diff--wrap" : ""}"
        aria-busy=${String(this.loading)}
      >
        ${this.renderBody()}
        ${this.menu
          ? keyed(
              this.menu,
              html`<openclaw-session-diff-menu
                .menu=${this.menu}
                .onAction=${(action: SessionDiffMenuAction) => this.handleMenuAction(action)}
                .onClose=${() => {
                  this.menu = null;
                }}
              ></openclaw-session-diff-menu>`,
            )
          : nothing}
      </div>
    `;
  }
}

if (!customElements.get("openclaw-session-diff")) {
  customElements.define("openclaw-session-diff", SessionDiffPanel);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-session-diff": SessionDiffPanel;
  }
}
