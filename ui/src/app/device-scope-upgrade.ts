import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { hasOperatorAdminAccess } from "./operator-access.ts";

export const SCOPE_UPGRADE_DETAILS_EVENT = "openclaw:scope-upgrade-details";
const SCOPE_UPGRADE_SURFACE_SELECTOR = "openclaw-device-scope-upgrade-banner";

export function openScopeUpgradeDetails(): void {
  const surface = globalThis.document?.querySelector(SCOPE_UPGRADE_SURFACE_SELECTOR);
  surface?.setAttribute("data-open-requested", "");
  globalThis.dispatchEvent(new Event(SCOPE_UPGRADE_DETAILS_EVENT));
}

export function scopeUpgradeStatusVisible(snapshot: ApplicationGatewaySnapshot): boolean {
  const auth = snapshot.hello?.auth;
  return !(
    snapshot.phase !== "connected" ||
    auth?.scopes === undefined ||
    hasOperatorAdminAccess(auth)
  );
}
