import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import {
  DESKTOP_PANEL_TOGGLE_EVENT,
  type DesktopPanelToggleDetail,
} from "../panel-toggle-contract.ts";

export function isDesktopPanelAvailable(
  snapshot: Pick<ApplicationGatewaySnapshot, "hello" | "phase">,
): boolean {
  return (
    snapshot.phase === "connected" &&
    hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
    isGatewayMethodAdvertised(snapshot, "worker.desktop.observe") === true
  );
}

export function openDesktopPanel(): void {
  window.dispatchEvent(
    new CustomEvent<DesktopPanelToggleDetail>(DESKTOP_PANEL_TOGGLE_EVENT, {
      detail: { open: true },
    }),
  );
}
