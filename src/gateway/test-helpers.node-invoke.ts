// Node invoke test helpers acknowledge forwarded node requests and discover the
// connected node id through gateway RPCs.
import { expect } from "vitest";
import type { WebSocket } from "ws";
import type { GatewayClient } from "./client.js";
import { rpcReq } from "./test-helpers.js";

/**
 * Node invoke acknowledgement helper for gateway tests.
 */
export function acknowledgeNodeInvokeRequestForTest(params: {
  client: GatewayClient;
  event: { event?: string; payload?: unknown };
  onInvoke: (payload: unknown) => void;
}): void {
  if (params.event.event !== "node.invoke.request") {
    return;
  }
  params.onInvoke(params.event.payload);
  const payload = params.event.payload as { id?: unknown; nodeId?: unknown };
  const id = typeof payload.id === "string" ? payload.id : "";
  const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : "";
  if (!id || !nodeId) {
    return;
  }
  void params.client.request("node.invoke.result", {
    id,
    nodeId,
    ok: true,
    payloadJSON: JSON.stringify({ ok: true }),
  });
}

export async function getConnectedNodeIdForTest(ws: WebSocket): Promise<string> {
  const nodes = await rpcReq<{ nodes?: Array<{ nodeId?: string; connected?: boolean }> }>(
    ws,
    "node.list",
    {},
  );
  expect(nodes.ok).toBe(true);
  const nodeId = nodes.payload?.nodes?.find((node) => node.connected)?.nodeId;
  if (!nodeId) {
    throw new Error("expected connected node id");
  }
  return nodeId;
}
