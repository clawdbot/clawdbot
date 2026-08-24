import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { formatByteSize } from "../../../lib/format.ts";
import {
  formatKeyboardShortcutCombo,
  isApplePlatform,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../../../lib/keyboard-shortcut-catalog.ts";
import type { SessionWorkspaceProps } from "./chat-session-workspace-types.ts";

function formatWorkspaceFileSize(file: { size?: number }): string {
  const size = file.size;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
    return "";
  }
  return formatByteSize(size, {
    style: "legacy-binary",
    maxUnit: "mega",
    separator: " ",
    fractionDigits: (value, unit) => (unit === "byte" ? null : Math.round(value * 10) % 10 ? 1 : 0),
  });
}

function renderWorkspaceArtifactSize(artifact: { sizeBytes?: number }): string {
  return formatWorkspaceFileSize({ size: artifact.sizeBytes });
}

function renderWorkspaceRailSection(
  title: string,
  content: TemplateResult | typeof nothing,
): TemplateResult | typeof nothing {
  if (content === nothing) {
    return nothing;
  }
  return html`
    <section class="chat-workspace-rail__section">
      <div class="chat-workspace-rail__section-title">${title}</div>
      ${content}
    </section>
  `;
}

export function renderSessionWorkspaceRail(
  sessionWorkspace: SessionWorkspaceProps | undefined,
  options: { embedded?: boolean } = {},
): TemplateResult | typeof nothing {
  // Standalone collapsed rails render nothing; the panel menu or workspace shortcut reopens them.
  if (!sessionWorkspace || (sessionWorkspace.collapsed && !options.embedded)) {
    return nothing;
  }
  // Narrow panes always present the rail as a bottom strip; a side column
  // would crush the thread below its readable minimum.
  const dock = sessionWorkspace.narrowLayout ? "bottom" : sessionWorkspace.dock;
  const terminalButton = sessionWorkspace.onToggleTerminal
    ? html`
        <openclaw-tooltip .content=${t("terminal.toggle")}>
          <button
            type="button"
            class="rail-header__action chat-workspace-rail__terminal"
            aria-label=${t("terminal.toggle")}
            @click=${sessionWorkspace.onToggleTerminal}
          >
            ${icons.terminal}
          </button>
        </openclaw-tooltip>
      `
    : nothing;
  const browserButton = sessionWorkspace.onToggleBrowser
    ? html`
        <openclaw-tooltip .content=${t("browser.toggle")}>
          <button
            type="button"
            class="rail-header__action chat-workspace-rail__terminal"
            aria-label=${t("browser.toggle")}
            @click=${sessionWorkspace.onToggleBrowser}
          >
            ${icons.globe}
          </button>
        </openclaw-tooltip>
      `
    : nothing;
  const custodianButton = sessionWorkspace.onToggleCustodian
    ? html`
        <openclaw-tooltip .content=${t("custodian.panel.toggle")}>
          <button
            type="button"
            class="rail-header__action chat-workspace-rail__terminal"
            aria-label=${t("custodian.panel.toggle")}
            @click=${sessionWorkspace.onToggleCustodian}
          >
            ${icons.lobster}
          </button>
        </openclaw-tooltip>
      `
    : nothing;
  const diffButton = sessionWorkspace.onOpenDiff
    ? html`
        <openclaw-tooltip .content=${t("chat.sessionDiff.show")}>
          <button
            type="button"
            class="rail-header__action chat-workspace-rail__terminal chat-session-diff-toggle"
            aria-label=${t("chat.sessionDiff.show")}
            @click=${sessionWorkspace.onOpenDiff}
          >
            ${icons.diff}
          </button>
        </openclaw-tooltip>
      `
    : nothing;
  const files = sessionWorkspace.list?.files ?? [];
  const modifiedFiles = files.filter((file) => file.kind === "modified");
  const readFiles = files.filter((file) => file.kind === "read");
  const artifacts = sessionWorkspace.list?.artifacts ?? [];
  const browser = sessionWorkspace.list?.browser ?? null;
  const hasSessionItems = files.length > 0 || artifacts.length > 0;
  const hasBrowserItems = (browser?.entries.length ?? 0) > 0;
  const hasItems = hasSessionItems || hasBrowserItems;
  const renderPathActions = (path: string, origin: "session" | "workspace"): TemplateResult => html`
    <span
      class="chat-workspace-rail__row-actions"
      role="group"
      aria-label=${t("chat.workspaceFiles.actions")}
    >
      <openclaw-tooltip .content=${t("chat.workspaceFiles.preview")}>
        <button
          class="chat-workspace-rail__row-action"
          type="button"
          aria-label=${t("chat.workspaceFiles.preview")}
          @click=${(event: Event) => {
            event.stopPropagation();
            sessionWorkspace.onOpenFile(path, origin);
          }}
        >
          ${icons.eye}
        </button>
      </openclaw-tooltip>
      <openclaw-tooltip .content=${t("chat.workspaceFiles.copyPath")}>
        <button
          class="chat-workspace-rail__row-action"
          type="button"
          aria-label=${t("chat.workspaceFiles.copyPath")}
          @click=${(event: Event) => {
            event.stopPropagation();
            sessionWorkspace.onCopyPath(path);
          }}
        >
          ${icons.copy}
        </button>
      </openclaw-tooltip>
    </span>
  `;
  const renderSessionSummary = (): TemplateResult | typeof nothing => {
    if (!sessionWorkspace.list) {
      return nothing;
    }
    const browserCount = browser?.entries.length ?? 0;
    return html`
      <div class="chat-workspace-rail__summary" aria-label=${t("chat.workspaceFiles.summary")}>
        <span
          >${t("chat.workspaceFiles.changedCount", { count: String(modifiedFiles.length) })}</span
        >
        <span>${t("chat.workspaceFiles.readCount", { count: String(readFiles.length) })}</span>
        <span>${t("chat.workspaceFiles.artifactCount", { count: String(artifacts.length) })}</span>
        <span>${t("chat.workspaceFiles.browserCount", { count: String(browserCount) })}</span>
      </div>
    `;
  };
  const renderFileRows = (rows: typeof files): TemplateResult | typeof nothing =>
    rows.length === 0
      ? nothing
      : html`
          <div class="chat-workspace-rail__list" role="list">
            ${rows.map((file) => {
              const size = formatWorkspaceFileSize(file);
              const itemId = `file:${file.path}`;
              const isActive = itemId === sessionWorkspace.activeId;
              return html`
                <div
                  class="chat-workspace-rail__file ${isActive
                    ? "chat-workspace-rail__file--active"
                    : ""}"
                  role="listitem"
                >
                  <button
                    class="chat-workspace-rail__file-open"
                    type="button"
                    @click=${() => sessionWorkspace.onOpenFile(file.path, "session")}
                  >
                    <span class="chat-workspace-rail__file-icon">${icons.fileText}</span>
                    <span class="chat-workspace-rail__file-main">
                      <openclaw-tooltip .content=${file.path || file.name}>
                        <span class="chat-workspace-rail__file-name"
                          >${file.path || file.name}</span
                        >
                      </openclaw-tooltip>
                      ${size
                        ? html`<span class="chat-workspace-rail__file-meta">${size}</span>`
                        : nothing}
                    </span>
                  </button>
                  ${file.missing
                    ? html`<span class="chat-workspace-rail__file-badge"
                        >${t("chat.workspaceFiles.missing")}</span
                      >`
                    : nothing}
                  ${renderPathActions(file.path, "session")}
                </div>
              `;
            })}
          </div>
        `;
  const renderBrowserBadge = (
    sessionKind: "modified" | "read" | "mixed" | undefined,
  ): TemplateResult | typeof nothing => {
    if (!sessionKind) {
      return nothing;
    }
    const label =
      sessionKind === "modified"
        ? t("chat.workspaceFiles.changed")
        : sessionKind === "read"
          ? t("chat.workspaceFiles.read")
          : t("chat.workspaceFiles.session");
    return html`<span class="chat-workspace-rail__file-badge">${label}</span>`;
  };
  const renderBrowserRows = (): TemplateResult => {
    const entries = browser?.entries ?? [];
    const parentPath = browser?.parentPath;
    return html`
      <section class="chat-workspace-rail__browser">
        <div class="chat-workspace-rail__browser-tools">
          <label class="chat-workspace-rail__search">
            <span class="chat-workspace-rail__search-icon" aria-hidden="true">${icons.search}</span>
            <input
              type="search"
              placeholder=${t("chat.workspaceFiles.search")}
              aria-label=${t("chat.workspaceFiles.search")}
              .value=${browser?.search ?? ""}
              @input=${(event: Event & { currentTarget: HTMLInputElement }) => {
                sessionWorkspace.onSearch(event.currentTarget.value);
              }}
            />
          </label>
        </div>
        ${browser?.search
          ? html`<div class="chat-workspace-rail__browser-caption">
              ${t("chat.workspaceFiles.searchResults")}
            </div>`
          : nothing}
        <div class="chat-workspace-rail__list chat-workspace-rail__list--browser" role="list">
          ${!browser?.search && parentPath != null
            ? html`
                <div
                  class="chat-workspace-rail__file chat-workspace-rail__file--directory"
                  role="listitem"
                >
                  <button
                    class="chat-workspace-rail__file-open"
                    type="button"
                    @click=${() => sessionWorkspace.onBrowsePath(parentPath)}
                  >
                    <span class="chat-workspace-rail__file-icon">${icons.folder}</span>
                    <span class="chat-workspace-rail__file-main">
                      <span class="chat-workspace-rail__file-name">..</span>
                      <span class="chat-workspace-rail__file-meta"
                        >${t("chat.workspaceFiles.parentFolder")}</span
                      >
                    </span>
                  </button>
                </div>
              `
            : nothing}
          ${entries.length === 0
            ? html`<div class="chat-workspace-rail__state">
                ${browser?.search
                  ? t("chat.workspaceFiles.noSearchResults")
                  : t("chat.workspaceFiles.noBrowserFiles")}
              </div>`
            : entries.map((entry) => {
                const size = entry.kind === "file" ? formatWorkspaceFileSize(entry) : "";
                const itemId = `file:${entry.path}`;
                const isActive = itemId === sessionWorkspace.activeId;
                return html`
                  <div
                    class="chat-workspace-rail__file ${entry.kind === "directory"
                      ? "chat-workspace-rail__file--directory"
                      : ""} ${isActive ? "chat-workspace-rail__file--active" : ""}"
                    role="listitem"
                  >
                    <button
                      class="chat-workspace-rail__file-open"
                      type="button"
                      @click=${() =>
                        entry.kind === "directory"
                          ? sessionWorkspace.onBrowsePath(entry.path)
                          : sessionWorkspace.onOpenFile(entry.path, "workspace")}
                    >
                      <span class="chat-workspace-rail__file-icon"
                        >${entry.kind === "directory" ? icons.folder : icons.fileText}</span
                      >
                      <span class="chat-workspace-rail__file-main">
                        <openclaw-tooltip .content=${entry.path || entry.name}>
                          <span class="chat-workspace-rail__file-name">${entry.name}</span>
                        </openclaw-tooltip>
                        <span class="chat-workspace-rail__file-meta">
                          ${entry.kind === "directory"
                            ? entry.path || t("chat.workspaceFiles.root")
                            : [entry.path, size].filter(Boolean).join(" / ")}
                        </span>
                      </span>
                    </button>
                    ${renderBrowserBadge(entry.sessionKind)}
                    ${entry.kind === "file" ? renderPathActions(entry.path, "workspace") : nothing}
                  </div>
                `;
              })}
        </div>
        ${browser?.truncated
          ? html`<div class="chat-workspace-rail__state">
              ${t("chat.workspaceFiles.truncated")}
            </div>`
          : nothing}
      </section>
    `;
  };
  const renderArtifactRows = (): TemplateResult | typeof nothing =>
    artifacts.length === 0
      ? nothing
      : html`
          <div class="chat-workspace-rail__list" role="list">
            ${artifacts.map((artifact) => {
              const size = renderWorkspaceArtifactSize(artifact);
              const itemId = `artifact:${artifact.id}`;
              const isActive = itemId === sessionWorkspace.activeId;
              const isImage = artifact.mimeType?.startsWith("image/");
              return html`
                <div
                  class="chat-workspace-rail__file ${isActive
                    ? "chat-workspace-rail__file--active"
                    : ""}"
                  role="listitem"
                >
                  <button
                    class="chat-workspace-rail__file-open"
                    type="button"
                    @click=${() => sessionWorkspace.onOpenArtifact(artifact.id)}
                  >
                    <span class="chat-workspace-rail__file-icon"
                      >${isImage ? icons.image : icons.paperclip}</span
                    >
                    <span class="chat-workspace-rail__file-main">
                      <openclaw-tooltip .content=${artifact.title}>
                        <span class="chat-workspace-rail__file-name">${artifact.title}</span>
                      </openclaw-tooltip>
                      ${size || artifact.mimeType
                        ? html`<span class="chat-workspace-rail__file-meta"
                            >${[artifact.mimeType, size].filter(Boolean).join(" / ")}</span
                          >`
                        : nothing}
                    </span>
                  </button>
                  <span class="chat-workspace-rail__row-actions">
                    <openclaw-tooltip .content=${t("chat.workspaceFiles.preview")}>
                      <button
                        class="chat-workspace-rail__row-action"
                        type="button"
                        aria-label=${t("chat.workspaceFiles.preview")}
                        @click=${(event: Event) => {
                          event.stopPropagation();
                          sessionWorkspace.onOpenArtifact(artifact.id);
                        }}
                      >
                        ${icons.eye}
                      </button>
                    </openclaw-tooltip>
                  </span>
                </div>
              `;
            })}
          </div>
        `;
  return html`
    <aside class="chat-workspace-rail" aria-label=${t("chat.workspaceFiles.label")}>
      ${options.embedded
        ? nothing
        : html`<div class="rail-header chat-workspace-rail__header">
            <div class="rail-header__copy chat-workspace-rail__title">
              <span class="rail-header__eyebrow chat-workspace-rail__eyebrow"
                >${t("chat.workspaceFiles.workspace")}</span
              >
              <strong class="rail-header__title">${t("chat.workspaceFiles.files")}</strong>
            </div>
            <div class="rail-header__actions chat-workspace-rail__actions">
              ${diffButton} ${terminalButton} ${browserButton} ${custodianButton}
              ${sessionWorkspace.narrowLayout
                ? nothing
                : html`
                    <openclaw-tooltip
                      .content=${dock === "bottom"
                        ? t("chat.workspaceFiles.dockRight")
                        : t("chat.workspaceFiles.dockBottom")}
                    >
                      <button
                        class="rail-header__action chat-workspace-rail__dock"
                        type="button"
                        aria-label=${dock === "bottom"
                          ? t("chat.workspaceFiles.dockRight")
                          : t("chat.workspaceFiles.dockBottom")}
                        @click=${() =>
                          sessionWorkspace.onSetDock(dock === "bottom" ? "right" : "bottom")}
                      >
                        ${dock === "bottom" ? icons.panelRightOpen : icons.panelBottomOpen}
                      </button>
                    </openclaw-tooltip>
                  `}
              <openclaw-tooltip .content=${t("chat.workspaceFiles.refresh")}>
                <button
                  class="rail-header__action chat-workspace-rail__refresh"
                  type="button"
                  aria-label=${t("chat.workspaceFiles.refresh")}
                  ?disabled=${sessionWorkspace.loading}
                  @click=${sessionWorkspace.onRefresh}
                >
                  ${icons.refresh}
                </button>
              </openclaw-tooltip>
              <openclaw-tooltip
                .content=${`${t("chat.workspaceFiles.collapse")} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.workspaceFiles)})`}
              >
                <button
                  type="button"
                  class="rail-header__action chat-workspace-rail__collapse-toggle"
                  aria-label=${t("chat.workspaceFiles.collapse")}
                  aria-keyshortcuts=${isApplePlatform() ? "Meta+Shift+B" : "Control+Shift+B"}
                  aria-expanded="true"
                  @click=${sessionWorkspace.onToggleCollapsed}
                >
                  <span class="nav-collapse-toggle__icon" aria-hidden="true"
                    >${dock === "bottom" ? icons.panelBottomClose : icons.panelRightClose}</span
                  >
                </button>
              </openclaw-tooltip>
            </div>
          </div>`}
      ${sessionWorkspace.list?.root
        ? html`
            <openclaw-tooltip .content=${sessionWorkspace.list.root}>
              <div class="chat-workspace-rail__path">${sessionWorkspace.list.root}</div>
            </openclaw-tooltip>
          `
        : nothing}
      ${renderSessionSummary()}
      ${sessionWorkspace.error
        ? html`<div class="chat-workspace-rail__state chat-workspace-rail__state--error">
            ${sessionWorkspace.error}
          </div>`
        : sessionWorkspace.loading && !hasItems
          ? html`<div class="chat-workspace-rail__state">${t("chat.workspaceFiles.loading")}</div>`
          : html`
              <div class="chat-workspace-rail__scroll">
                ${hasSessionItems
                  ? html`
                      ${renderWorkspaceRailSection(
                        t("chat.workspaceFiles.changed"),
                        renderFileRows(modifiedFiles),
                      )}
                      ${renderWorkspaceRailSection(
                        t("chat.workspaceFiles.read"),
                        renderFileRows(readFiles),
                      )}
                      ${renderWorkspaceRailSection(
                        t("chat.workspaceFiles.artifacts"),
                        renderArtifactRows(),
                      )}
                    `
                  : nothing}
                ${renderWorkspaceRailSection(
                  t("chat.workspaceFiles.browser"),
                  browser ? renderBrowserRows() : nothing,
                )}
              </div>
            `}
    </aside>
  `;
}
