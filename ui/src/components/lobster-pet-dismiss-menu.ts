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
  // wa-dropdown's `size` (auto-size) middleware runs after `flip` and clamps
  // `#menu` to `--auto-size-available-height` for whatever placement flip
  // lands on (Web Awesome 3.10.0 popup source, chunk.7MPIABXH.js:197-273), so
  // a popup anchored near a viewport edge can still get shrunk in place
  // rather than flipped away from it — flip's own bestFit candidates
  // (floating-ui/core 1.8.0 flip middleware, dist/floating-ui.core.mjs:444)
  // are evaluated against the anchor's transient position, not the menu's
  // real measured content. The pet always sits on the footer's bottom edge,
  // so rather than depend on flip picking correctly, `top-start` is set as
  // the preferred placement directly — it structurally has room by
  // construction; `shift` and `auto-size` (already on for every wa-dropdown)
  // then react to the menu's real measured content instead of a guess.
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
