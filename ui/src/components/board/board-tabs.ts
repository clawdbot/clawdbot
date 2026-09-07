import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import type { BoardTab } from "../../lib/board/types.ts";

function renderTab(tab: BoardTab, activeTabId: string, hoverTabId: string): TemplateResult {
  const active = tab.tabId === activeTabId;
  const dropTarget = tab.tabId === hoverTabId;
  return html`
    <wa-tab
      class=${`board-tabs__tab ${active ? "board-tabs__tab--active" : ""} ${dropTarget ? "board-tabs__tab--drop" : ""}`}
      panel=${tab.tabId}
      ?active=${active}
      data-board-tab-id=${tab.tabId}
    >
      ${tab.title}
    </wa-tab>
  `;
}

function renderOverflowTab(tab: BoardTab): TemplateResult {
  return html`
    <wa-dropdown-item
      class="board-tabs__overflow-item"
      value=${tab.tabId}
      data-board-tab-id=${tab.tabId}
    >
      ${tab.title}
    </wa-dropdown-item>
  `;
}

export function renderBoardTabs(options: {
  tabs: readonly BoardTab[];
  activeTabId: string;
  hoverTabId: string;
  onTabShow: (event: CustomEvent<{ name: string }>) => void;
  onOverflowSelect: (event: CustomEvent<{ item: { value?: string } }>) => void;
}): TemplateResult | typeof nothing {
  const { tabs, activeTabId, hoverTabId, onTabShow, onOverflowSelect } = options;
  if (tabs.length <= 1) {
    return nothing;
  }
  const visible = tabs.slice(0, 6);
  const active = tabs.find((tab) => tab.tabId === activeTabId);
  if (active && !visible.some((tab) => tab.tabId === active.tabId)) {
    visible[visible.length - 1] = active;
  }
  const visibleIds = new Set(visible.map((tab) => tab.tabId));
  const overflow = tabs.filter((tab) => !visibleIds.has(tab.tabId));
  return html`
    <nav class="board-tabs" aria-label=${t("board.tabsLabel")}>
      <wa-tab-group
        class="board-tabs__track"
        .active=${activeTabId}
        activation="manual"
        without-scroll-controls
        @wa-tab-show=${onTabShow}
      >
        ${visible.map((tab) => renderTab(tab, activeTabId, hoverTabId))}
      </wa-tab-group>
      ${
        overflow.length > 0
          ? html`
              <wa-dropdown
                class="board-tabs__overflow"
                placement="bottom-end"
                @wa-select=${onOverflowSelect}
              >
                <button
                  class="board-tabs__overflow-trigger"
                  slot="trigger"
                  type="button"
                  aria-label=${t("board.moreTabs")}
                  title=${t("board.moreTabs")}
                >
                  •••
                </button>
                ${overflow.map((tab) => renderOverflowTab(tab))}
              </wa-dropdown>
            `
          : nothing
      }
    </nav>
  `;
}
