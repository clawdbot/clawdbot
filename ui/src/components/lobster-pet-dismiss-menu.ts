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
  // Web Awesome caps `#menu` to `--auto-size-available-height` and its `size`
  // middleware runs after `flip`, so a popup anchored near a viewport edge is
  // shrunk in place instead of flipping and silently scrolls its own items.
  // The pet lives on the footer ledge, i.e. always at the bottom edge, so the
  // anchor is clamped like every other pointer-anchored menu (session-menu.ts,
  // catalog-session-menu.ts, native-link-menu.ts, sidebar-menus-controller.ts).
  const menuWidth = 264;
  const menuHeight = 80;
  const x = Math.max(8, Math.min(position.x, window.innerWidth - menuWidth - 8));
  const y = Math.max(8, Math.min(position.y, window.innerHeight - menuHeight - 8));
  return html`
    <openclaw-menu-surface>
      <wa-dropdown
        class="session-menu lobster-pet-dismiss-menu"
        .open=${true}
        placement="bottom-start"
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
          style="position: fixed; left: ${x}px; top: ${y}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
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
