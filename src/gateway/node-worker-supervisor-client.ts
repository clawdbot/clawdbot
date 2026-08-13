import {
  NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
} from "../infra/node-commands.js";
import {
  nodeWorkerLaunchIdentity,
  parseNodeWorkerLaunchInput,
  parseNodeWorkerSupervisorReceipt,
  type NodeWorkerLaunchInput,
  type NodeWorkerSupervisorIdentity,
  type NodeWorkerSupervisorReceipt,
} from "../node-host/node-worker-supervisor-contract.js";
import type { NodeWorkerSupervisorTransport } from "./node-registry-private.js";
import type { NodeInvokeResult } from "./node-registry.js";

type NodeWorkerSupervisorClientError = {
  code: string;
  message: string;
};

type NodeWorkerSupervisorClientResult =
  | { effect: "not-sent"; error: NodeWorkerSupervisorClientError }
  | { effect: "verified-receipt"; receipt: NodeWorkerSupervisorReceipt | null }
  | { effect: "sent-outcome-unknown"; error: NodeWorkerSupervisorClientError };

type NodeWorkerSupervisorCancelResult =
  | Exclude<NodeWorkerSupervisorClientResult, { effect: "verified-receipt" }>
  | {
      effect: "verified-receipt";
      receipt: NodeWorkerSupervisorReceipt | null;
      cancellation: "cancelled" | "not-cancelled";
    };

type NodeWorkerSupervisorCallBase = {
  nodeId: string;
  isDispatchAuthorized: () => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
};

function failure(params: {
  code: string;
  dispatched: boolean;
  message: string;
}): NodeWorkerSupervisorClientResult {
  return {
    effect: params.dispatched ? "sent-outcome-unknown" : "not-sent",
    error: { code: params.code, message: params.message },
  };
}

function identitiesMatch(
  receipt: NodeWorkerSupervisorReceipt,
  expected: NodeWorkerSupervisorIdentity,
): boolean {
  return (
    receipt.launchId === expected.launchId &&
    receipt.planHash === expected.planHash &&
    receipt.environmentId === expected.environmentId &&
    receipt.sessionId === expected.sessionId &&
    receipt.ownerEpoch === expected.ownerEpoch &&
    receipt.placementGeneration === expected.placementGeneration &&
    receipt.runId === expected.runId
  );
}

function transportFailure(result: NodeInvokeResult, dispatched: boolean) {
  const code =
    typeof result.error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(result.error.code)
      ? result.error.code
      : "UNAVAILABLE";
  return failure({
    code,
    dispatched,
    message: dispatched
      ? "node worker supervisor outcome is unknown after dispatch"
      : "node worker supervisor command was not dispatched",
  });
}

class NodeWorkerSupervisorClient {
  constructor(private readonly transport: NodeWorkerSupervisorTransport) {}

  async launch(
    params: NodeWorkerSupervisorCallBase & { input: NodeWorkerLaunchInput },
  ): Promise<NodeWorkerSupervisorClientResult> {
    let input: NodeWorkerLaunchInput;
    let expected: NodeWorkerSupervisorIdentity;
    try {
      input = parseNodeWorkerLaunchInput(JSON.stringify(params.input));
      expected = nodeWorkerLaunchIdentity(input);
    } catch {
      return failure({
        code: "INVALID_REQUEST",
        dispatched: false,
        message: "invalid node worker launch request",
      });
    }
    return await this.invoke({
      ...params,
      command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
      request: input,
      expected,
      allowMissing: false,
    });
  }

  async status(
    params: NodeWorkerSupervisorCallBase & { expected: NodeWorkerSupervisorIdentity },
  ): Promise<NodeWorkerSupervisorClientResult> {
    return await this.invoke({
      ...params,
      command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
      request: { launchId: params.expected.launchId },
      expected: params.expected,
      allowMissing: true,
    });
  }

  async cancel(
    params: NodeWorkerSupervisorCallBase & { expected: NodeWorkerSupervisorIdentity },
  ): Promise<NodeWorkerSupervisorCancelResult> {
    const result = await this.invoke({
      ...params,
      command: NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
      request: params.expected,
      expected: params.expected,
      allowMissing: true,
    });
    return result.effect === "verified-receipt"
      ? {
          ...result,
          cancellation: result.receipt?.state === "cancelled" ? "cancelled" : "not-cancelled",
        }
      : result;
  }

  private async invoke(
    params: NodeWorkerSupervisorCallBase & {
      command:
        | typeof NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND
        | typeof NODE_WORKER_SUPERVISOR_STATUS_COMMAND
        | typeof NODE_WORKER_SUPERVISOR_CANCEL_COMMAND;
      request: unknown;
      expected: NodeWorkerSupervisorIdentity;
      allowMissing: boolean;
    },
  ): Promise<NodeWorkerSupervisorClientResult> {
    if (!params.isDispatchAuthorized()) {
      return failure({
        code: "AUTHORITY_CLOSED",
        dispatched: false,
        message: "node worker supervisor authority is closed",
      });
    }
    let node;
    try {
      node = (await this.transport.listCurrentNodes()).find(
        (candidate) => candidate.nodeId === params.nodeId,
      );
    } catch {
      return failure({
        code: "UNAVAILABLE",
        dispatched: false,
        message: "node worker supervisor transport is unavailable",
      });
    }
    if (!node || !params.isDispatchAuthorized()) {
      return failure({
        code: node ? "AUTHORITY_CLOSED" : "INVALID_NODE_HOST",
        dispatched: false,
        message: node
          ? "node worker supervisor authority is closed"
          : "current node session has no worker supervisor dialect",
      });
    }
    let dispatched = false;
    let result: NodeInvokeResult;
    try {
      result = await this.transport.invoke({
        node,
        command: params.command,
        params: params.request,
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        idempotencyKey: params.expected.launchId,
        isDispatchAuthorized: params.isDispatchAuthorized,
        onDispatchReady: () => {
          dispatched = true;
        },
      });
    } catch {
      return failure({
        code: "UNAVAILABLE",
        dispatched,
        message: dispatched
          ? "node worker supervisor outcome is unknown after transport failure"
          : "node worker supervisor transport failed before dispatch",
      });
    }
    if (!result.ok) {
      return transportFailure(result, dispatched);
    }
    if (!dispatched) {
      return failure({
        code: "INVALID_REPLY",
        dispatched: false,
        message: "node worker supervisor returned success without dispatch provenance",
      });
    }
    if (typeof result.payloadJSON !== "string" || result.payload !== undefined) {
      return failure({
        code: "INVALID_REPLY",
        dispatched: true,
        message: "node worker supervisor returned an invalid reply",
      });
    }
    let receipt: NodeWorkerSupervisorReceipt | null;
    try {
      receipt = parseNodeWorkerSupervisorReceipt(result.payloadJSON);
    } catch {
      return failure({
        code: "INVALID_REPLY",
        dispatched: true,
        message: "node worker supervisor returned an invalid reply",
      });
    }
    if (receipt === null) {
      return params.allowMissing
        ? { effect: "verified-receipt", receipt: null }
        : failure({
            code: "INVALID_REPLY",
            dispatched: true,
            message: "node worker supervisor launch receipt was missing",
          });
    }
    if (!identitiesMatch(receipt, params.expected)) {
      return failure({
        code: "IDENTITY_MISMATCH",
        dispatched: true,
        message: "node worker supervisor reply identity did not match the request",
      });
    }
    return { effect: "verified-receipt", receipt };
  }
}

/** Creates the device-runtime-owned client for the closed private supervisor transport. */
export function createNodeWorkerSupervisorClient(transport: NodeWorkerSupervisorTransport) {
  return new NodeWorkerSupervisorClient(transport);
}
