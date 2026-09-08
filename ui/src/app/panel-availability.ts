import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import type { ApplicationContext } from "./context.ts";
import { hasNativeBrowserBridge } from "./native-browser-host.ts";
import { hasOperatorAdminAccess } from "./operator-access.ts";

type GatewaySnapshot = Pick<ApplicationContext["gateway"]["snapshot"], "phase" | "hello">;

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

export function isBrowserPanelSurfaceAvailable(snapshot: GatewaySnapshot): boolean {
  return hasNativeBrowserBridge() || isBrowserPanelAvailable(snapshot);
}

export function isDesktopPanelAvailable(snapshot: GatewaySnapshot): boolean {
  return isPanelAvailable(snapshot, "desktop.observe");
}

const homePanelAccess = new WeakMap<
  ApplicationContext["gateway"],
  { gatewayUrl: string; allowed: boolean }
>();

/** Presentation access survives reconnect; the chat send/outbox owner still authorizes delivery. */
export function isHomePanelAvailable(gateway: ApplicationContext["gateway"] | undefined): boolean {
  if (!gateway) {
    return false;
  }
  const snapshot = gateway.snapshot;
  const gatewayUrl = gateway.connection.gatewayUrl;
  if (snapshot.phase === "connected") {
    const allowed =
      canCallGatewayMethod(snapshot, "chat.history", "operator.read") &&
      canCallGatewayMethod(snapshot, "chat.send", "operator.write");
    homePanelAccess.set(gateway, { gatewayUrl, allowed });
    return allowed;
  }
  const previous = homePanelAccess.get(gateway);
  if (previous?.gatewayUrl !== gatewayUrl || snapshot.phase === "reload-required") {
    homePanelAccess.delete(gateway);
    return false;
  }
  return previous.allowed;
}
