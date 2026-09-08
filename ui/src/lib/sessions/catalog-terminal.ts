import type {
  SessionsCatalogStartTerminalParams,
  SessionsCatalogStartTerminalResult,
} from "@openclaw/gateway-protocol";
import {
  TERMINAL_PANEL_TOGGLE_EVENT,
  type TerminalPanelToggleDetail,
} from "../../components/panel-toggle-contract.ts";
import { t } from "../../i18n/index.ts";
import type { CatalogSessionKey } from "./catalog-key.ts";

function openTerminal(detail: TerminalPanelToggleDetail): void {
  window.dispatchEvent(
    new CustomEvent<TerminalPanelToggleDetail>(TERMINAL_PANEL_TOGGLE_EVENT, { detail }),
  );
}

export function openCatalogSessionInTerminal(key: CatalogSessionKey, agentId: string): void {
  openTerminal({ open: true, agentId, catalog: key });
}

export async function startCatalogSessionInTerminal(
  params: SessionsCatalogStartTerminalParams,
  isCurrent: () => boolean,
): Promise<SessionsCatalogStartTerminalResult> {
  // Upgrade the existing panel before dispatch so this request and its prompt
  // stay in memory instead of entering the shell's persisted lazy-event queue.
  await import("../../components/terminal/terminal-panel-registration.ts");
  if (!isCurrent()) {
    throw new Error(t("terminal.startCancelled"));
  }
  let started: Promise<SessionsCatalogStartTerminalResult> | undefined;
  openTerminal({
    open: true,
    catalogStart: {
      params,
      isCurrent,
      respondWith: (result) => {
        started = result;
      },
    },
  });
  if (!started) {
    throw new Error(t("terminal.panelUnavailable"));
  }
  return started;
}
