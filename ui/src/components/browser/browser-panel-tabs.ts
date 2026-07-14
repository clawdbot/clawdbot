import { html, svg } from "lit";
import { t } from "../../i18n/index.ts";
import "../web-awesome-tabs.ts";
import type { BrowserPanelTab } from "./browser-client.ts";

const CLOSE_GLYPH = svg`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>`;
const PLUS_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3v10M3 8h10" /></svg>`;

function tabLabel(tab: BrowserPanelTab): string {
  if (tab.title.trim()) {
    return tab.title.trim();
  }
  try {
    return new URL(tab.url).host || t("browser.untitledTab");
  } catch {
    return tab.url || t("browser.untitledTab");
  }
}

export function renderBrowserPanelTabs(params: {
  tabs: BrowserPanelTab[];
  activeTargetId: string | null;
  onSelect: (targetId: string) => void;
  onClose: (targetId: string) => void;
  onNew: () => void;
}) {
  return html`
    <wa-tab-group
      class="bp-tabs"
      .active=${params.activeTargetId ?? ""}
      activation="auto"
      without-scroll-controls
      @wa-tab-show=${(event: CustomEvent<{ name: string }>) => params.onSelect(event.detail.name)}
    >
      ${params.tabs.map(
        (tab) => html`
          <wa-tab
            id=${`browser-tab-${tab.id}`}
            class="bp-tab"
            panel=${tab.id}
            aria-controls="browser-tab-panel"
            title=${tab.url}
            @auxclick=${(event: MouseEvent) => {
              if (event.button === 1) {
                event.preventDefault();
                params.onClose(tab.id);
              }
            }}
          >
            <span class="bp-tab__label">${tabLabel(tab)}</span>
          </wa-tab>
          <button
            slot="nav"
            class="bp-tab__close"
            type="button"
            title=${t("browser.closeTab")}
            aria-label=${`${t("browser.closeTab")}: ${tabLabel(tab)}`}
            @click=${() => params.onClose(tab.id)}
          >
            ${CLOSE_GLYPH}
          </button>
        `,
      )}
      <button
        slot="nav"
        class="bp-new"
        type="button"
        title=${t("browser.newTab")}
        aria-label=${t("browser.newTab")}
        @click=${params.onNew}
      >
        ${PLUS_GLYPH}
      </button>
    </wa-tab-group>
  `;
}
