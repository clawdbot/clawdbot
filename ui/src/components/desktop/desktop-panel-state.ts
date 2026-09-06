import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { registerDesktopEnglish } from "../../i18n/locales/en-desktop.ts";

registerDesktopEnglish();

export type DesktopPanelState =
  | "picker"
  | "inventory-error"
  | "credentials"
  | "connecting"
  | "connected"
  | "disconnected";

export function renderDesktopPanelRecovery(props: {
  inventoryError: boolean;
  reason: string | null;
  onRetry: () => void;
}) {
  return html`
    <div class="desktop-status">
      ${
        props.inventoryError
          ? nothing
          : html`<div>
              ${t("desktop.disconnected", {
                reason: props.reason ?? t("desktop.unknownReason"),
              })}
            </div>`
      }
      <button class="desktop-button desktop-button--primary" type="button" @click=${props.onRetry}>
        ${t(props.inventoryError ? "common.retry" : "desktop.reconnect")}
      </button>
    </div>
  `;
}
