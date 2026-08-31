import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import type { ApplicationContext } from "./context.ts";
import { hasOperatorAdminAccess } from "./operator-access.ts";

type GatewaySnapshot = ApplicationContext["gateway"]["snapshot"];

function isPanelAvailable(snapshot: GatewaySnapshot, method: string): boolean {
  return (
    snapshot.phase === "connected" &&
    hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
    isGatewayMethodAdvertised(snapshot, method) === true
  );
}

export function isBrowserPanelAvailable(snapshot: GatewaySnapshot): boolean {
  return isPanelAvailable(snapshot, "browser.request");
}

export function isDesktopPanelAvailable(snapshot: GatewaySnapshot): boolean {
  return isPanelAvailable(snapshot, "desktop.observe");
}
