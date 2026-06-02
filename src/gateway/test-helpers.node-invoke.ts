import type { GatewayClient } from "./client.js";

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
