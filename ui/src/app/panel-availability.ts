import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import type { ApplicationContext } from "./context.ts";
import { hasOperatorAdminAccess } from "./operator-access.ts";

type GatewaySnapshot = ApplicationContext["gateway"]["snapshot"];

export function isBrowserPanelAvailable(snapshot: GatewaySnapshot): boolean {
  return (
    snapshot.phase === "connected" &&
    hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
    isGatewayMethodAdvertised(snapshot, "browser.request") === true
  );
}

export function isDesktopPanelAvailable(snapshot: GatewaySnapshot): boolean {
  return (
    snapshot.phase === "connected" &&
    hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
    isGatewayMethodAdvertised(snapshot, "desktop.observe") === true
  );
}
