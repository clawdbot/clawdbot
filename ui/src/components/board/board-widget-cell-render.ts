import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import type { BoardTab } from "../../lib/board/types.ts";
import type { BoardGrantDecision, BoardViewWidget } from "../../lib/board/view-types.ts";
import { renderBoardPendingCapabilities } from "./board-widget-capabilities.ts";

export const BOARD_SIZE_PRESETS = {
  sm: { w: 3, h: 3 },
  md: { w: 6, h: 4 },
  lg: { w: 8, h: 6 },
  xl: { w: 12, h: 8 },
} as const;

export function closeBoardWidgetMenu(root: ParentNode): void {
  const menu = root.querySelector<HTMLElement & { open: boolean }>(".board-widget__menu");
  if (menu) {
    menu.open = false;
  }
}

export function renderBoardWidgetMenu(options: {
  widget: BoardViewWidget;
  tabs: readonly BoardTab[];
  disabled: boolean;
  onSelect: (event: CustomEvent<{ item: { value?: string } }>) => void;
}): TemplateResult {
  const { widget, tabs, disabled, onSelect } = options;
  const otherTabs = tabs.filter((tab) => tab.tabId !== widget.tabId);
  return html`
    <wa-dropdown class="board-widget__menu" placement="bottom-end" @wa-select=${onSelect}>
      <button
        class="board-widget__menu-trigger"
        slot="trigger"
        type="button"
        aria-label=${t("board.widget.menuLabel")}
        title=${t("board.widget.menuLabel")}
      >
        ⋮
      </button>
      <div class="board-widget__menu-heading">${t("board.widget.moveToTab")}</div>
      ${otherTabs.length > 0
        ? otherTabs.map(
            (tab) => html`
              <wa-dropdown-item value=${`move:${tab.tabId}`} ?disabled=${disabled}>
                ${tab.title}
              </wa-dropdown-item>
            `,
          )
        : html`<span class="board-widget__menu-empty">${t("board.widget.noOtherTabs")}</span>`}
      <div class="board-widget__menu-heading">${t("board.widget.resize")}</div>
      ${Object.entries(BOARD_SIZE_PRESETS).map(
        ([label, size]) => html`
          <wa-dropdown-item
            class="board-widget__preset"
            value=${`resize:${label}`}
            ?disabled=${disabled}
          >
            ${label.toUpperCase()}
            <span slot="details">${size.w}×${size.h}</span>
          </wa-dropdown-item>
        `,
      )}
      ${widget.contentKind === "html"
        ? html`<wa-dropdown-item
            class="board-widget__preset"
            type="checkbox"
            value="height:auto"
            ?checked=${widget.heightMode !== "fixed"}
            ?disabled=${disabled}
          >
            ${t("board.widget.autoHeight")}
          </wa-dropdown-item>`
        : nothing}
      <div class="board-widget__menu-separator" role="separator"></div>
      <wa-dropdown-item class="board-widget__menu-danger" value="remove" ?disabled=${disabled}>
        ${t("board.widget.remove")}
      </wa-dropdown-item>
    </wa-dropdown>
  `;
}

export function renderBoardWidgetPending(options: {
  widget: BoardViewWidget;
  disabled: boolean;
  onGrant: (decision: BoardGrantDecision) => void;
  error?: TemplateResult;
}): TemplateResult {
  return renderBoardPendingCapabilities(options);
}

export function renderBoardWidgetRejected(options: {
  widget: BoardViewWidget;
  disabled: boolean;
  onRemove: () => void;
}): TemplateResult {
  return html`
    <div class="board-widget__grant board-widget__grant--rejected" data-test-id="board-rejected">
      <strong>${t("board.widget.rejected")}</strong>
      <span>${t("board.widget.rejectedDetail")}</span>
      <button
        class="btn btn--small"
        type="button"
        ?disabled=${options.disabled}
        @click=${options.onRemove}
      >
        ${t("board.widget.remove")}
      </button>
    </div>
  `;
}

export function renderBoardWidgetError(error: unknown): TemplateResult {
  const message = error instanceof Error ? error.message : String(error);
  return html`
    <div class="board-widget__error" role="alert" data-test-id="board-widget-error">
      <strong>${t("board.widget.errorTitle")}</strong>
      <span>${t("board.widget.errorDetail")}</span>
      <details>
        <summary>${t("board.widget.errorShow")}</summary>
        <code>${message}</code>
      </details>
    </div>
  `;
}

export function renderBoardWidgetActionError(error: string, inline = false): TemplateResult {
  return html`
    <div
      class=${`board-widget__error ${inline ? "board-widget__error--inline" : ""}`}
      role="alert"
      data-test-id="board-widget-action-error"
    >
      <strong>${t("board.widget.actionErrorTitle")}</strong>
      <span>${t("board.widget.actionErrorDetail")}</span>
      <details>
        <summary>${t("board.widget.errorShow")}</summary>
        <code>${error}</code>
      </details>
    </div>
  `;
}
