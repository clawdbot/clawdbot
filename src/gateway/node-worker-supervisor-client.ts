import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
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
import type { NodeRegistry, NodeInvokeResult } from "./node-registry.js";

/** Symbol-keyed request context slot keeps this client outside the public Gateway handler shape. */
export const NODE_WORKER_SUPERVISOR_CLIENT_CONTEXT = Symbol("openclaw.nodeWorkerSupervisorClient");

type NodeWorkerSupervisorClientError = {
  code: string;
  message: string;
  ambiguous: boolean;
};

type NodeWorkerSupervisorClientResult =
  | { ok: true; dispatch: "sent"; receipt: NodeWorkerSupervisorReceipt | null }
  | {
      ok: false;
      dispatch: "not-sent" | "sent";
      error: NodeWorkerSupervisorClientError;
    };

type NodeWorkerSupervisorCallBase = {
  nodeId: string;
  isDispatchAuthorized: () => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const AMBIGUOUS_TRANSPORT_CODES = new Set([
  "ABORTED",
  "DISCONNECTED",
  "IDLE_TIMEOUT",
  "TIMEOUT",
  "UNAVAILABLE",
]);

function failure(params: {
  code: string;
  dispatched: boolean;
  message: string;
}): NodeWorkerSupervisorClientResult {
  return {
    ok: false,
    dispatch: params.dispatched ? "sent" : "not-sent",
    error: {
      code: params.code,
      message: params.message,
      ambiguous: params.dispatched && AMBIGUOUS_TRANSPORT_CODES.has(params.code),
    },
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
      ? "node worker supervisor command failed after dispatch"
      : "node worker supervisor command was not dispatched",
  });
}

class NodeWorkerSupervisorClient {
  constructor(private readonly registry: NodeRegistry) {}

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
  ): Promise<NodeWorkerSupervisorClientResult> {
    const status = await this.status(params);
    if (!status.ok || status.receipt === null) {
      return status;
    }
    // The durable store binds launchId to one immutable launch identity. Fence the
    // destructive lookup-only cancel with an exact status match; both sends recheck authority.
    return await this.invoke({
      ...params,
      command: NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
      request: { launchId: params.expected.launchId },
      expected: params.expected,
      allowMissing: true,
    });
  }

  private async invoke(
    params: NodeWorkerSupervisorCallBase & {
      command: string;
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
    const session = this.registry.get(params.nodeId);
    if (
      !session ||
      session.clientId !== GATEWAY_CLIENT_IDS.NODE_HOST ||
      session.clientMode !== GATEWAY_CLIENT_MODES.NODE ||
      !session.connId ||
      !session.pairingGeneration
    ) {
      return failure({
        code: "INVALID_NODE_HOST",
        dispatched: false,
        message: "current node session is not an authenticated node host",
      });
    }
    let dispatched = false;
    let result: NodeInvokeResult;
    try {
      result = await this.registry.invoke({
        nodeId: params.nodeId,
        expectedConnId: session.connId,
        expectedPairingGeneration: session.pairingGeneration,
        command: params.command,
        params: params.request,
        timeoutMs: params.timeoutMs,
        signal: params.signal,
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
        message: "node worker supervisor transport failed",
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
        dispatched,
        message: "node worker supervisor returned an invalid reply",
      });
    }
    let receipt: NodeWorkerSupervisorReceipt | null;
    try {
      receipt = parseNodeWorkerSupervisorReceipt(result.payloadJSON);
    } catch {
      return failure({
        code: "INVALID_REPLY",
        dispatched,
        message: "node worker supervisor returned an invalid reply",
      });
    }
    if (receipt === null) {
      return params.allowMissing
        ? { ok: true, dispatch: "sent", receipt: null }
        : failure({
            code: "INVALID_REPLY",
            dispatched,
            message: "node worker supervisor launch receipt was missing",
          });
    }
    if (!identitiesMatch(receipt, params.expected)) {
      return failure({
        code: "IDENTITY_MISMATCH",
        dispatched,
        message: "node worker supervisor reply identity did not match the request",
      });
    }
    return { ok: true, dispatch: "sent", receipt };
  }
}

/** Creates the Gateway-internal client for non-advertised node worker controls. */
export function createNodeWorkerSupervisorClient(registry: NodeRegistry) {
  return new NodeWorkerSupervisorClient(registry);
}
