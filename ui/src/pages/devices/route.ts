import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorPairingAccess } from "../../app/operator-access.ts";
import {
  createInitialDevicesState,
  loadDevices,
  loadExecApprovals,
  loadNodes,
} from "../../lib/nodes/index.ts";
import type { DevicesRouteData } from "./devices-page.ts";

async function loadDevicesRouteData(context: ApplicationContext): Promise<DevicesRouteData> {
  const gateway = context.gateway;
  const gatewaySnapshot = gateway.snapshot;
  const devices = createInitialDevicesState({
    client: gatewaySnapshot.client,
    connected: gatewaySnapshot.phase === "connected",
  });
  if (gatewaySnapshot.phase !== "connected" || !gatewaySnapshot.client) {
    return { gateway, gatewaySnapshot, devices };
  }
  const auth = gatewaySnapshot.hello?.auth ?? null;
  const canPair = !auth || hasOperatorPairingAccess(auth);
  const canAdmin = hasOperatorAdminAccess(auth);
  await Promise.all([
    loadNodes(devices),
    Promise.allSettled([
      ...(canPair ? [loadDevices(devices)] : []),
      context.runtimeConfig.refresh(),
      ...(canAdmin ? [loadExecApprovals(devices)] : []),
    ]),
  ]);
  return { gateway, gatewaySnapshot, devices };
}

export const page = definePage({
  ...routePageSpec("devices"),
  loader: loadDevicesRouteData,
  component: () =>
    import("./devices-page.ts").then(() => ({
      header: true,
      render: (data: DevicesRouteData | undefined) =>
        html`<openclaw-devices-page .routeData=${data}></openclaw-devices-page>`,
    })),
});
