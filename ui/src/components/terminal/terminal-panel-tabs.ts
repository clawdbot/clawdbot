import { svg } from "lit";
import { t } from "../../i18n/index.ts";
import { renderPanelTabStrip, type PanelTabStripTab } from "../panel-tab-strip.ts";

export type TerminalPanelTab = {
  id: string;
  sequence: number;
  shellName: string | null;
  agentId: string | null;
  cwd: string | null;
  status: "connecting" | "live" | "exited";
  exitReason?: string;
  exitCode?: number | null;
};

const TERMINAL_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4l3 3-3 3M8 11h5" /></svg>`;

function terminalTabLabel(tab: TerminalPanelTab): string {
  return tab.shellName ?? t("terminal.tabLabel", { n: String(tab.sequence) });
}

function terminalTabHint(tab: TerminalPanelTab): string | null {
  return tab.agentId === null || tab.cwd === null
    ? null
    : t("terminal.tabHint", { agent: tab.agentId, cwd: tab.cwd });
}

function terminalTabStatusLabel(tab: TerminalPanelTab): string | null {
  if (tab.status === "connecting") {
    return t("terminal.connecting");
  }
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
  const tabs: PanelTabStripTab[] = params.tabs.map((tab) => {
    const label = terminalTabLabel(tab);
    return {
      id: tab.id,
      domId: `terminal-tab-${tab.id}`,
      label,
      title: terminalTabHint(tab),
      icon: TERMINAL_GLYPH,
      statusLabel: terminalTabStatusLabel(tab),
      className: `is-${tab.status}`,
      closeLabel: `${t("terminal.closeSession")}: ${label}`,
    };
  });
  return renderPanelTabStrip({
    tabs,
    activeId: params.activeId,
    ariaControls: "terminal-tab-panel",
    onSelect: params.onSelect,
    onClose: params.onClose,
    onNew: params.onNew,
    newLabel: t("terminal.newSession"),
    newDisabled: params.booting,
  });
}
