import {
  TERMINAL_PANEL_TOGGLE_EVENT,
  type TerminalPanelToggleDetail,
} from "../../components/panel-toggle-contract.ts";
import type { CatalogSessionKey } from "./catalog-key.ts";

export function openCatalogSessionInTerminal(key: CatalogSessionKey): void {
  window.dispatchEvent(
    new CustomEvent<TerminalPanelToggleDetail>(TERMINAL_PANEL_TOGGLE_EVENT, {
      detail: { open: true, catalog: key },
    }),
  );
}
