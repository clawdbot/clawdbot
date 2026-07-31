// Catalog viewer header action for opening an eligible native session in a terminal.
import { html, nothing } from "lit";
import type { SessionCatalogSession } from "../../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { parseCatalogSessionKey } from "../../../lib/sessions/catalog-key.ts";
import { openCatalogSessionInTerminal } from "../../../lib/sessions/catalog-terminal.ts";

export function renderCatalogTerminalButton(
  state: { sessionKey: string; terminalAvailable?: boolean } | null | undefined,
  session: SessionCatalogSession | null,
) {
  const catalogKey = state ? parseCatalogSessionKey(state.sessionKey) : null;
  if (!catalogKey || !session?.canOpenTerminal || !state?.terminalAvailable) {
    return nothing;
  }
  return html`
    <openclaw-tooltip .content=${t("chat.catalog.openInTerminal")}>
      <button
        class="btn btn--ghost btn--icon chat-icon-btn"
        type="button"
        aria-label=${t("chat.catalog.openInTerminal")}
        @click=${() => openCatalogSessionInTerminal(catalogKey)}
      >
        ${icons.terminal}
      </button>
    </openclaw-tooltip>
  `;
}
