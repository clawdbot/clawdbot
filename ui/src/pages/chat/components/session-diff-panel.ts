// Session diff panel: renders selectable branch, working-tree, and commit diffs.
import { Task, TaskStatus } from "@lit/task";
import { html, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import type {
  SessionDiffFile,
  SessionsDiffResult,
} from "../../../../../packages/gateway-protocol/src/index.js";
import {
  localEditorFilePath,
  observeNativeGateway,
} from "../../../app/native-editor-locality.runtime.ts";
import { icons } from "../../../components/icons.ts";
import { renderPanelLoadingSkeleton } from "../../../components/panel-loading-skeleton.ts";
import { t } from "../../../i18n/index.ts";
import "../../../components/tooltip.ts";
import {
  expandSessionDiffGap,
  splitSessionDiffFileText,
  type SessionDiffGapDirection,
} from "../../../lib/chat/session-diff-gaps.ts";
import { parseSessionDiffPatch, type ParsedFilePatch } from "../../../lib/chat/session-diff.ts";
import type { DiffLine } from "../../../lib/chat/tool-call-diff.ts";
import { openEditor } from "../../../lib/editor-links.ts";
import { formatUiError } from "../../../lib/format-error.ts";
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
export type SessionDiffFileTextLoader = (path: string) => Promise<string | null>;

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

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function scopeParams(scope: SessionDiffScope): SessionDiffScope {
  return scope.scope === "commit"
    ? { scope: "commit", commit: scope.commit }
    : { scope: scope.scope };
}

function taskResult(result: SessionsDiffResult): SessionDiffTaskResult {
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
}

class SessionDiffPanel extends OpenClawLightDomElement {
  @property({ attribute: false }) execNode: string | null = null;
  @property({ attribute: false }) loader: SessionDiffLoader | null = null;
  @property({ attribute: false }) loadFileText: SessionDiffFileTextLoader | null = null;
  @property({ attribute: false }) openFile: ((path: string) => void) | null = null;
  @property({ attribute: false }) revealFile: ((path: string) => void) | null = null;

  @state() private collapsedPaths = new Set<string>();
  @state() private menu: SessionDiffMenuData | null = null;
  @state() private scope: SessionDiffScope = { scope: "all" };
  @state() private split = loadPreferences().split;
  @state() private wrap = loadPreferences().wrap;

  private readonly fileTextCache = new WeakMap<FileView, Promise<string[] | null>>();
  private readonly unavailableFileText = new WeakSet<FileView>();
  private prefetchedDiffResult: SessionsDiffResult | null = null;

  constructor() {
    super();
    observeNativeGateway(this, () => {
      this.menu = null;
    });
  }

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
      const result = this.prefetchedDiffResult ?? (await loader(params));
      this.prefetchedDiffResult = null;
      return taskResult(result);
    },
    onComplete: (value) => {
      const currentPaths = new Set(value?.views.map((view) => view.file.path) ?? []);
      this.collapsedPaths = new Set(
        [...this.collapsedPaths].filter((path) => currentPaths.has(path)),
      );
    },
  });

  private get loading(): boolean {
    return this.loader !== null && this.diffTask.status === TaskStatus.PENDING;
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

  private openAnchoredMenu(
    event: Event,
    menu: SessionDiffMenuDraft,
    placement: "bottom-end" | "bottom-start" | "top-start" = "bottom-end",
  ): void {
    event.stopPropagation();
    const trigger = event.currentTarget;
    if (!(trigger instanceof HTMLElement)) {
      return;
    }
    const bounds = trigger.getBoundingClientRect();
    this.menu = {
      ...menu,
      ...(menu.kind === "scope" && placement !== "bottom-end" ? { placement } : {}),
      anchor: {
        x: placement.endsWith("start") ? bounds.left : bounds.right,
        y: placement.startsWith("top") ? bounds.top : bounds.bottom,
      },
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

  private canExpandGaps(view: FileView): boolean {
    return (
      this.scope.scope !== "commit" &&
      Boolean(this.loadFileText) &&
      view.file.binary !== true &&
      view.parsed !== null &&
      !view.parsed.truncated &&
      !this.unavailableFileText.has(view)
    );
  }

  private loadFileLines(view: FileView): Promise<string[] | null> {
    const cached = this.fileTextCache.get(view);
    if (cached) {
      return cached;
    }
    const load = this.loadFileText;
    const pending = load
      ? load(view.file.path)
          .then((text) => (text === null ? null : splitSessionDiffFileText(text)))
          .catch(() => null)
      : Promise.resolve(null);
    this.fileTextCache.set(view, pending);
    return pending;
  }

  private async expandGap(
    view: FileView,
    line: DiffLine,
    direction: SessionDiffGapDirection,
  ): Promise<void> {
    const parsed = view.parsed;
    const loader = this.loader;
    if (!parsed || !line.gap || !loader || !this.canExpandGaps(view)) {
      return;
    }
    const scope = this.scope;
    let freshResult: SessionsDiffResult;
    try {
      freshResult = await loader(scopeParams(scope));
    } catch {
      return;
    }
    if (
      this.loader !== loader ||
      this.scope !== scope ||
      !this.diffTask.value?.views.includes(view)
    ) {
      return;
    }
    const freshFile = freshResult.files.find((file) => file.path === view.file.path);
    // The panel renders a snapshot; revalidate its patch server-side because gap-interior
    // edits are invisible to row validation. The remaining diff-to-file fetch race is a few
    // milliseconds and is an accepted tradeoff without shared snapshot identity.
    if (!freshFile || freshFile.patch !== view.file.patch) {
      this.fileTextCache.delete(view);
      this.prefetchedDiffResult = freshResult;
      await this.diffTask.run();
      return;
    }
    const fileLines = await this.loadFileLines(view);
    if (!fileLines || !this.diffTask.value?.views.includes(view)) {
      this.unavailableFileText.add(view);
      this.requestUpdate();
      return;
    }
    const expanded = expandSessionDiffGap(parsed.lines, line.gap, fileLines, direction, (count) =>
      t("chat.sessionDiff.unmodifiedLines", { count: String(count) }),
    );
    if (!expanded) {
      this.unavailableFileText.add(view);
      this.requestUpdate();
      return;
    }
    parsed.lines = expanded;
    this.requestUpdate();
  }

  private renderGap(view: FileView, line: DiffLine): unknown {
    const gap = line.gap;
    if (!gap || !this.canExpandGaps(view)) {
      return line.text;
    }
    const chunkCount = gap.count <= 25 ? gap.count : Math.min(20, gap.count);
    return html`<span class="session-diff__gap-controls">
      <button
        type="button"
        aria-label=${t("chat.sessionDiff.expandPreviousLines", {
          count: String(chunkCount),
        })}
        @click=${() => void this.expandGap(view, line, "up")}
      >
        ${icons.chevronUp}
      </button>
      <button
        class="session-diff__gap-count"
        type="button"
        aria-label=${t("chat.sessionDiff.expandAllLines", { count: String(gap.count) })}
        @click=${() => void this.expandGap(view, line, "all")}
      >
        ${line.text}
      </button>
      <button
        type="button"
        aria-label=${t("chat.sessionDiff.expandNextLines", { count: String(chunkCount) })}
        @click=${() => void this.expandGap(view, line, "down")}
      >
        ${icons.chevronDown}
      </button>
    </span>`;
  }

  private renderFileBody(view: FileView): TemplateResult {
    const { file, parsed } = view;
    if (file.binary === true) {
      return html`<div class="session-diff__note">${t("chat.sessionDiff.binaryFile")}</div>`;
    }
    if (!parsed) {
      return html`<div class="session-diff__note">${t("chat.sessionDiff.tooLarge")}</div>`;
    }
    const renderGap = (line: DiffLine) => this.renderGap(view, line);
    return html`
      ${this.split
        ? renderSessionSplitDiff(parsed.lines, renderGap, file)
        : renderDiffBlock(parsed.lines, "succeeded", renderGap, file)}
      ${parsed.truncated
        ? html`<div class="session-diff__note">${t("chat.sessionDiff.truncatedFile")}</div>`
        : nothing}
    `;
  }

  private renderFile(view: FileView, result: SessionsDiffResult): TemplateResult {
    const { file } = view;
    const collapsed = this.collapsedPaths.has(file.path);
    const { directory, name } = splitPath(file.path);
    const absPath = result.root
      ? (localEditorFilePath({ root: result.root, path: file.path }, this.execNode) ?? undefined)
      : undefined;
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
        this.openAnchoredMenu(event, { kind: "scope", active: this.scope, result }, "top-start")}
    >
      <span>${label}</span>${icons.chevronUp}
    </button>`;
  }

  private renderBody(): TemplateResult | typeof nothing {
    if (this.diffTask.status === TaskStatus.ERROR) {
      const error = this.diffTask.error;
      return html`<div class="callout danger">${formatUiError(error)}</div>`;
    }
    if (this.loading) {
      return renderPanelLoadingSkeleton("review", t("chat.sessionDiff.loading"));
    }
    const value = this.diffTask.value;
    if (!value) {
      return nothing;
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
      <button
        class="session-diff__section-title"
        type="button"
        aria-label=${t("chat.sessionDiff.scopeMenu")}
        @click=${(event: Event) =>
          this.openAnchoredMenu(
            event,
            { kind: "scope", active: this.scope, result },
            "bottom-start",
          )}
      >
        <span>${this.scopeTitle(result)}</span>${icons.chevronDown}
      </button>
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
