import {
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_WORKSPACE_RETAIN_COMMAND,
} from "../infra/node-commands.js";
import type { GatewayClient } from "./client.js";

export function respondToNodeShutdown(
  node: GatewayClient,
  frame: { id: string; nodeId: string; command: string },
): Promise<unknown> | undefined {
  const isStop = frame.command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND;
  if (!isStop && frame.command !== NODE_WORKER_WORKSPACE_RETAIN_COMMAND) {
    return undefined;
  }
  return node.request(
    "node.invoke.result",
    {
      id: frame.id,
      nodeId: frame.nodeId,
      ok: true,
      payloadJSON: JSON.stringify(isStop ? null : { applied: true, deleted: 0, hasMore: false }),
    },
    { timeoutMs: 5_000 },
  );
}
