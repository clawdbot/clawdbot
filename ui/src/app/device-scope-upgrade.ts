import { html } from "lit";
import { icons } from "../components/icons.ts";
import { t } from "../i18n/index.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { hasOperatorAdminAccess } from "./operator-access.ts";

export const SCOPE_UPGRADE_DETAILS_EVENT = "openclaw:scope-upgrade-details";
export const SCOPE_UPGRADE_TRIGGER_ID = "scope-upgrade-trigger";
const SCOPE_UPGRADE_SURFACE_SELECTOR = "openclaw-device-scope-upgrade-banner";

export function openScopeUpgradeDetails(event?: Event): void {
  event?.stopImmediatePropagation();
  const surface = globalThis.document?.querySelector(SCOPE_UPGRADE_SURFACE_SELECTOR);
  surface?.setAttribute("data-open-requested", "");
  globalThis.dispatchEvent(new Event(SCOPE_UPGRADE_DETAILS_EVENT));
}

export function renderScopeUpgradeTrigger(
  className: string,
  onClick: (event: Event) => void = openScopeUpgradeDetails,
) {
  return html`<button
    id=${SCOPE_UPGRADE_TRIGGER_ID}
    type="button"
    class=${className}
    aria-label=${t("connection.scopeUpgrade.showDetails")}
    aria-haspopup="dialog"
    @click=${onClick}
  >
    ${icons.shieldQuestion}
  </button>`;
}

function scopeUpgradeStatusVisible(snapshot: ApplicationGatewaySnapshot): boolean {
  const auth = snapshot.hello?.auth;
  return !(
    snapshot.phase !== "connected" ||
    auth?.scopes === undefined ||
    hasOperatorAdminAccess(auth)
  );
}

export function scopeUpgradeStatusUsesSessionHeader(snapshot: ApplicationGatewaySnapshot): boolean {
  return scopeUpgradeStatusVisible(snapshot) && snapshot.client?.scopeUpgradeReady === true;
}
