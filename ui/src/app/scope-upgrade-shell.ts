import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../components/icons.ts";
import { t } from "../i18n/index.ts";
import type { ApplicationContext } from "./context.ts";
import { readScopeUpgradeAvailability } from "./device-scope-upgrade.ts";
import {
  isOptionalElementDefined,
  type LazyCustomElementRequestController,
  type OptionalCustomElement,
} from "./lazy-custom-element.ts";

export const SCOPE_UPGRADE_DESKTOP_TRIGGER_ID = "scope-upgrade-desktop-trigger";
export const SCOPE_UPGRADE_MOBILE_TRIGGER_ID = "scope-upgrade-mobile-trigger";
export const SCOPE_UPGRADE_NATIVE_TRIGGER_ID = "scope-upgrade-native-trigger";

const SCOPE_UPGRADE_SURFACE_ELEMENT = {
  tagName: "openclaw-device-scope-upgrade-banner",
  label: "device scope upgrade banner",
  loadModule: () => import("./device-scope-upgrade.runtime.ts"),
} satisfies OptionalCustomElement;

export function renderScopeUpgradeShellStatusTrigger(options: {
  id: string;
  className: string;
  onActivate?: () => void;
}): TemplateResult {
  const label = t("connection.scopeUpgrade.showDetails");
  return html`<openclaw-tooltip class="scope-upgrade-status-host" .content=${label}>
    <button
      id=${options.id}
      type="button"
      class="${options.className} scope-upgrade-status-trigger"
      aria-label=${label}
      aria-haspopup="dialog"
      @click=${options.onActivate}
    >
      ${icons.shieldQuestion}
    </button>
  </openclaw-tooltip>`;
}

export function renderScopeUpgradeShellSurface(
  lazyCustomElements: LazyCustomElementRequestController,
  snapshot: ApplicationContext["gateway"]["snapshot"],
  options: {
    mobile: boolean;
    anchorId: string;
    popoverPlacement: "bottom-start" | "bottom-end";
  },
) {
  if (readScopeUpgradeAvailability(snapshot).phase === "hidden") {
    return { inline: nothing, overlay: nothing };
  }
  lazyCustomElements.preload(SCOPE_UPGRADE_SURFACE_ELEMENT);
  const overlay = html`<openclaw-device-scope-upgrade-banner
    .props=${{ snapshot, ...options }}
  ></openclaw-device-scope-upgrade-banner>`;
  return isOptionalElementDefined(SCOPE_UPGRADE_SURFACE_ELEMENT)
    ? { inline: nothing, overlay }
    : {
        inline: html`<openclaw-update-banner
          .props=${{
            statusBanner: { tone: "warn", text: t("connection.scopeUpgrade.guidance") },
          }}
        ></openclaw-update-banner>`,
        overlay,
      };
}
