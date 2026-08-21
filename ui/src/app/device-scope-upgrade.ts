import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { hasOperatorAdminAccess } from "./operator-access.ts";

const SCOPE_UPGRADE_BANNER_DISMISSED_KEY = "openclaw.control.scopeUpgradeBannerDismissed.v1";

export const SCOPE_UPGRADE_DETAILS_EVENT = "openclaw:scope-upgrade-details";

export function hasDismissedScopeUpgradeBanner(): boolean {
  try {
    return globalThis.localStorage?.getItem(SCOPE_UPGRADE_BANNER_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissScopeUpgradeBanner(): void {
  try {
    globalThis.localStorage?.setItem(SCOPE_UPGRADE_BANNER_DISMISSED_KEY, "1");
  } catch {
    // The current page can still collapse the banner when storage is unavailable.
  }
}

export type ScopeUpgradeState =
  | { phase: "hidden" }
  | { phase: "guidance" }
  | { phase: "available" }
  | { phase: "requesting" }
  | { phase: "pending"; requestId: string }
  | { phase: "rejected"; requestId: string; expired: boolean }
  | { phase: "error"; message: string };

export function readScopeUpgradeAvailability(
  snapshot: ApplicationGatewaySnapshot,
): ScopeUpgradeState {
  const auth = snapshot.hello?.auth;
  if (
    snapshot.phase !== "connected" ||
    auth?.scopes === undefined ||
    hasOperatorAdminAccess(auth)
  ) {
    return { phase: "hidden" };
  }
  return isGatewayMethodAdvertised(snapshot, "device.scopes.requestUpgrade") === true &&
    isGatewayMethodAdvertised(snapshot, "device.scopes.waitUpgrade") === true &&
    snapshot.client?.scopeUpgradeReady === true
    ? { phase: "available" }
    : { phase: "guidance" };
}
