import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createInitialNodesState,
  loadDevices,
  loadExecApprovals,
  loadNodes,
} from "../../lib/nodes/index.ts";
import type { NodesRouteData } from "./nodes-page.ts";

async function loadNodesRouteData(context: ApplicationContext): Promise<NodesRouteData> {
  const gateway = context.gateway;
  const gatewaySnapshot = gateway.snapshot;
  const nodes = createInitialNodesState({
    client: gatewaySnapshot.client,
    connected: gatewaySnapshot.phase === "connected",
  });
  if (gatewaySnapshot.phase !== "connected" || !gatewaySnapshot.client) {
    return { gateway, gatewaySnapshot, nodes };
  }
  await Promise.all([
    loadNodes(nodes),
    Promise.allSettled([
      loadDevices(nodes),
      context.runtimeConfig.refresh(),
      loadExecApprovals(nodes),
    ]),
  ]);
  return { gateway, gatewaySnapshot, nodes };
}

export const page = definePage({
  id: "nodes",
  path: "/settings/devices",
  aliases: ["/nodes"],
  loader: loadNodesRouteData,
  component: () =>
    import("./nodes-page.ts").then(() => ({
      header: true,
      render: (data: NodesRouteData | undefined) =>
        html`<openclaw-nodes-page .routeData=${data}></openclaw-nodes-page>`,
    })),
});
