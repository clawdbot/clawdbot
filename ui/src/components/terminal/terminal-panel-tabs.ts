import { html, nothing, svg } from "lit";
import { t } from "../../i18n/index.ts";
import "../web-awesome-tabs.ts";

export type TerminalPanelTab = {
  id: string;
  sequence: number;
  shellName: string | null;
  agentId: string | null;
  cwd: string | null;
  status: "live" | "exited";
  exitReason?: string;
  exitCode?: number | null;
};

const TERMINAL_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4l3 3-3 3M8 11h5" /></svg>`;
const CLOSE_GLYPH = svg`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>`;
const PLUS_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3v10M3 8h10" /></svg>`;

function terminalTabLabel(tab: TerminalPanelTab): string {
  return tab.shellName ?? t("terminal.tabLabel", { n: String(tab.sequence) });
}

function terminalTabHint(tab: TerminalPanelTab): string | null {
  return tab.agentId === null || tab.cwd === null
    ? null
    : t("terminal.tabHint", { agent: tab.agentId, cwd: tab.cwd });
}

function terminalTabStatusLabel(tab: TerminalPanelTab): string | null {
  if (tab.status !== "exited") {
    return null;
  }
  if (tab.exitReason === "detached") {
    return t("terminal.detached");
  }
  return tab.exitReason === "process_exit" && typeof tab.exitCode === "number"
    ? t("terminal.exitedCode", { code: String(tab.exitCode) })
    : t("terminal.exited");
}

export function renderTerminalPanelTabs(params: {
  tabs: TerminalPanelTab[];
  activeId: string | null;
  booting: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  return html`
    <wa-tab-group
      class="tp-tabs"
      .active=${params.activeId ?? ""}
      activation="auto"
      without-scroll-controls
      @wa-tab-show=${(event: CustomEvent<{ name: string }>) => params.onSelect(event.detail.name)}
    >
      ${params.tabs.map((tab) => {
        const statusLabel = terminalTabStatusLabel(tab);
        return html`
          <wa-tab
            id=${`terminal-tab-${tab.id}`}
            class="tp-tab ${tab.status === "exited" ? "is-exited" : ""}"
            panel=${tab.id}
            aria-controls="terminal-tab-panel"
            title=${terminalTabHint(tab) || nothing}
          >
            <span class="tp-tab__icon" aria-hidden="true">${TERMINAL_GLYPH}</span>
            <span class="tp-tab__label">${terminalTabLabel(tab)}</span>
            ${statusLabel ? html`<span class="tp-tab__status">${statusLabel}</span>` : nothing}
          </wa-tab>
          <button
            slot="nav"
            class="tp-tab__close"
            type="button"
            title=${t("terminal.closeSession")}
            aria-label=${`${t("terminal.closeSession")}: ${terminalTabLabel(tab)}`}
            @click=${() => params.onClose(tab.id)}
          >
            ${CLOSE_GLYPH}
          </button>
        `;
      })}
      <button
        slot="nav"
        class="tp-new"
        type="button"
        ?disabled=${params.booting}
        title=${t("terminal.newSession")}
        aria-label=${t("terminal.newSession")}
        @click=${params.onNew}
      >
        ${PLUS_GLYPH}
      </button>
    </wa-tab-group>
  `;
}
