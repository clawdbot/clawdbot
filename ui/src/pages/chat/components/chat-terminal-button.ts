// Chat header action for toggling the native terminal or resuming an eligible catalog session.
import { html, nothing } from "lit";
import type { SessionCatalogSession } from "../../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { parseCatalogSessionKey } from "../../../lib/sessions/catalog-key.ts";
import { openCatalogSessionInTerminal } from "../../../lib/sessions/catalog-terminal.ts";

export function renderChatTerminalButton(
  state: { sessionKey: string; terminalAvailable?: boolean } | null | undefined,
  session: SessionCatalogSession | null,
  onToggleTerminal: (() => void) | undefined,
) {
  const catalogKey = state ? parseCatalogSessionKey(state.sessionKey) : null;
  if (
    (catalogKey && (!state?.terminalAvailable || !session?.canOpenTerminal)) ||
    (!catalogKey && !onToggleTerminal)
  ) {
    return nothing;
  }
  const label = catalogKey ? t("chat.catalog.openInTerminal") : t("terminal.toggle");
  return html`
    <openclaw-tooltip .content=${label}>
      <button
        class="btn btn--ghost btn--icon chat-icon-btn"
        type="button"
        aria-label=${label}
        @click=${() =>
          catalogKey ? openCatalogSessionInTerminal(catalogKey) : onToggleTerminal?.()}
      >
        ${icons.terminal}
      </button>
    </openclaw-tooltip>
  `;
}
