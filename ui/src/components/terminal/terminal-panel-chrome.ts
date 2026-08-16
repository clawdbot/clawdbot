import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import type { DockPanelPlacement } from "../dock-panel-layout.ts";
import { icons } from "../icons.ts";
import { renderPanelEmptyState } from "../panel-empty-state.ts";
import {
  TerminalOpenTimeoutError,
  TerminalOpenUnusableSessionError,
} from "./terminal-connection.ts";
import type { TerminalPanelSessionTab } from "./terminal-panel-session-types.ts";
import { renderTerminalPanelTabs } from "./terminal-panel-tabs.ts";
import {
  renderTerminalPanelActions,
  renderTerminalUploadLayer,
  type TerminalPanelUploadController,
} from "./terminal-panel-upload.ts";

type TerminalDock = Exclude<DockPanelPlacement, "left">;

export function renderTerminalPanelToolbar(
  fullscreen: boolean,
  embedded: boolean,
  dock: TerminalDock,
  uploadController: TerminalPanelUploadController,
  sessionPicker: TemplateResult,
  setDock: (dock: TerminalDock) => void,
  openFullscreen: () => void,
  hidePanel: () => void,
): TemplateResult {
  return renderTerminalPanelActions({
    fullscreen,
    embedded,
    dock,
    upload: uploadController,
    sessionPicker,
    onDock: setDock,
    onOpenFullscreen: openFullscreen,
    onHide: hidePanel,
  });
}

export function renderTerminalPanelHeader(
  tabs: TerminalPanelSessionTab[],
  activeId: string | null,
  booting: boolean,
  toolbar: TemplateResult,
  selectTab: (id: string) => void,
  closeTab: (id: string) => void | Promise<void>,
  openSession: () => void,
): TemplateResult {
  return html`<header class="rail-header tp-header">
    ${renderTerminalPanelTabs({
      tabs,
      activeId,
      booting,
      onSelect: selectTab,
      onClose: closeTab,
      onNew: openSession,
    })}
    ${toolbar}
  </header>`;
}

export function renderTerminalPanelViewport(
  activeId: string | null,
  connecting: boolean,
  errorText: string | null,
  uploadController: TerminalPanelUploadController,
): TemplateResult {
  return html`
    ${errorText ? html`<div class="tp-error" role="alert">${errorText}</div>` : nothing}
    <wa-tab-panel
      id="terminal-tab-panel"
      class="tp-viewport"
      name=${activeId ?? "terminal"}
      active
      aria-labelledby=${activeId ? `terminal-tab-${activeId}` : nothing}
      @dragenter=${uploadController.handleDragEnter}
      @dragover=${uploadController.handleDragOver}
      @dragleave=${uploadController.handleDragLeave}
      @drop=${uploadController.handleDrop}
    >
      ${connecting
        ? html`<div class="tp-connecting" role="status">
            <span class="tp-connecting__spinner" aria-hidden="true"></span>
            <span>${t("terminal.connecting")}</span>
          </div>`
        : nothing}
      ${!activeId && !connecting && !errorText
        ? renderPanelEmptyState({
            icon: icons.terminal,
            heading: t("chat.sidePanel.terminal"),
            description: t("chat.sidePanel.terminalEmpty"),
          })
        : nothing}
      ${renderTerminalUploadLayer(uploadController)}
    </wa-tab-panel>
  `;
}

/** Operator-facing text for a failed terminal.open; typed errors map to copy. */
export function terminalOpenErrorText(error: unknown): string {
  if (error instanceof TerminalOpenTimeoutError) {
    return t("terminal.connectionTimedOut");
  }
  if (error instanceof TerminalOpenUnusableSessionError) {
    return t("terminal.unavailable");
  }
  return error instanceof Error ? error.message : String(error);
}
