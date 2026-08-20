import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import "./menu-surface.ts";
import "./web-awesome.ts";

export type LobsterPetDismissMenuPosition = { x: number; y: number };

export function renderLobsterPetDismissMenu(params: {
  position: LobsterPetDismissMenuPosition | null;
  onDismiss: (permanently: boolean) => void;
  onClose: () => void;
}) {
  const position = params.position;
  if (!position) {
    return nothing;
  }
  // Auto-size clamps the menu to whatever placement flip picks rather than
  // relocating it, so top-start is forced directly since the footer always
  // has clear room above — leaving it to flip risks a shrunk-in-place menu.
  return html`
    <openclaw-menu-surface>
      <wa-dropdown
        class="session-menu lobster-pet-dismiss-menu"
        .open=${true}
        placement="top-start"
        .distance=${0}
        aria-label=${t("quickSettings.appearance.lobsterVisits")}
        @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
          event.preventDefault();
          if (event.detail.item.value === "dismiss") {
            params.onDismiss(false);
          } else if (event.detail.item.value === "dismiss-permanently") {
            params.onDismiss(true);
          }
        }}
        @wa-after-hide=${params.onClose}
      >
        <button
          slot="trigger"
          type="button"
          tabindex="-1"
          aria-hidden="true"
          aria-label=${t("quickSettings.appearance.lobsterVisits")}
          style="position: fixed; left: ${position.x}px; top: ${position.y}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
        ></button>
        <wa-dropdown-item class="session-menu__item" value="dismiss"
          >${t("common.dismiss")}</wa-dropdown-item
        >
        <wa-dropdown-item class="session-menu__item" value="dismiss-permanently"
          >${t("common.dismissAndDontShowAgain")}</wa-dropdown-item
        >
      </wa-dropdown>
    </openclaw-menu-surface>
  `;
}
