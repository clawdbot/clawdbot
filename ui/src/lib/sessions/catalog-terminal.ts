import {
  TERMINAL_PANEL_TOGGLE_EVENT,
  type TerminalPanelToggleDetail,
} from "../../components/panel-toggle-contract.ts";
import type { CatalogSessionKey } from "./catalog-key.ts";

function openTerminal(detail: TerminalPanelToggleDetail): void {
  window.dispatchEvent(
    new CustomEvent<TerminalPanelToggleDetail>(TERMINAL_PANEL_TOGGLE_EVENT, { detail }),
  );
}

export function openCatalogSessionInTerminal(key: CatalogSessionKey): void {
  openTerminal({ open: true, catalog: key });
}

export function openTerminalSessionInTerminal(terminalSessionId: string): void {
  openTerminal({ open: true, terminalSessionId });
}
