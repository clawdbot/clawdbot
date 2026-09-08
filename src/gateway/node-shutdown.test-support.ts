import {
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
  NODE_WORKER_WORKSPACE_RETAIN_COMMAND,
} from "../infra/node-commands.js";
import {
  NODE_WORKSPACE_DRAIN_COMMAND,
  parseNodeWorkerWorkspaceExecInput,
  projectNodeWorkerWorkspaceExecResult,
} from "../worker/node-workspace-protocol.js";
import type { GatewayClient } from "./client.js";

export function respondToNodeShutdown(
  node: GatewayClient,
  frame: { id: string; nodeId: string; command: string; paramsJSON: string },
): Promise<unknown> | undefined {
  const isStop = frame.command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND;
  const isDrain =
    frame.command === NODE_WORKER_WORKSPACE_EXEC_COMMAND &&
    parseNodeWorkerWorkspaceExecInput(frame.paramsJSON).argv[0] === NODE_WORKSPACE_DRAIN_COMMAND;
  if (!isStop && !isDrain && frame.command !== NODE_WORKER_WORKSPACE_RETAIN_COMMAND) {
    return undefined;
  }
  return node.request(
    "node.invoke.result",
    {
      id: frame.id,
      nodeId: frame.nodeId,
      ok: true,
      payloadJSON: JSON.stringify(
        isDrain
          ? projectNodeWorkerWorkspaceExecResult("/node/workspace", {
              stdout: "drained\n",
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
              termination: "exit",
            })
          : isStop
            ? null
            : { applied: true, deleted: 0, hasMore: false },
      ),
    },
    { timeoutMs: 5_000 },
  );
}
