import { NODE_WORKER_WORKSPACE_EXEC_COMMAND } from "../../infra/node-commands.js";
import {
  NODE_WORKSPACE_DRAIN_COMMAND,
  parseNodeWorkerWorkspaceExecResult,
} from "../../worker/node-workspace-protocol.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { WorkerTunnelOwnerDisconnectedError } from "./tunnel-contract.js";

/** Cancellation is only a request. This acknowledgement joins the node's physical workspace queue. */
export async function drainNodeWorkerWorkspace(params: {
  gatewayNamespace: string;
  environmentId: string;
  sessionId: string;
  ownerEpoch: number;
  timeoutMs: number;
  findNode: (signal: AbortSignal) => Promise<{
    transport: NodeWorkerSupervisorTransport;
    node: NodeWorkerSupervisorNodeProof;
  }>;
  isAuthorized: () => boolean;
}): Promise<void> {
  const signal = AbortSignal.timeout(params.timeoutMs);
  const { transport, node } = await params.findNode(signal);
  const result = await transport.invoke({
    node,
    command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
    params: {
      gatewayNamespace: params.gatewayNamespace,
      environmentId: params.environmentId,
      sessionId: params.sessionId,
      generation: params.ownerEpoch,
      argv: [NODE_WORKSPACE_DRAIN_COMMAND],
    },
    timeoutMs: params.timeoutMs,
    signal,
    isDispatchAuthorized: params.isAuthorized,
  });
  if (!result.ok) {
    throw new WorkerTunnelOwnerDisconnectedError(
      `Node workspace operations have not drained (${result.error?.code ?? "UNAVAILABLE"}); reconnect the session runner before retrying`,
    );
  }
  if (!params.isAuthorized()) {
    throw new Error("Node workspace drain authority closed");
  }
  const parsed = parseNodeWorkerWorkspaceExecResult(JSON.parse(result.payloadJSON ?? "null"));
  if (parsed?.termination !== "exit" || parsed.code !== 0 || parsed.stdout.trim() !== "drained") {
    throw new Error("Node workspace drain acknowledgement is invalid");
  }
}
