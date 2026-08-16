import { sleepWithAbort } from "../../infra/backoff.js";
import {
  NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE,
  NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
} from "../../infra/node-commands.js";
import {
  nodeWorkerPlanHash,
  parseNodeWorkerLaunchInput,
  parseNodeWorkerSupervisorReceipt,
  type NodeWorkerLaunchInput,
  type NodeWorkerSupervisorIdentity,
  type NodeWorkerSupervisorReceipt,
} from "../../worker/node-supervisor-protocol.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { WorkerRunnerUnavailableError } from "./tunnel-contract.js";

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_RETRY_DELAY_MS = 2_000;
const DEFAULT_CANCELLATION_TIMEOUT_MS = 30_000;
const DEFAULT_AVAILABILITY_TIMEOUT_MS = 10_000;

const RETRYABLE_TRANSPORT_CODES = new Set([
  "DISCONNECTED",
  "NOT_CONNECTED",
  "PAIRING_CHANGED",
  "PRIVATE_DIALECT_UNAVAILABLE",
  "ROUTE_CHANGED",
  "TIMEOUT",
  "UNAVAILABLE",
]);

type TerminalNodeWorkerSupervisorReceipt = Extract<
  NodeWorkerSupervisorReceipt,
  { state: "completed" | "failed" | "interrupted" | "cancelled" }
>;

type DeviceWorkerLaunchRequest = {
  deviceId: string;
  input: NodeWorkerLaunchInput;
  isDispatchAuthorized: () => boolean;
  isCancellationAuthorized: () => boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  onDispatchReady?: () => void;
};

type NodeWorkerLaunchAdapterOptions = {
  getTransport: () => NodeWorkerSupervisorTransport | undefined;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  rpcTimeoutMs?: number;
  pollIntervalMs?: number;
  cancellationTimeoutMs?: number;
};

type OperationDeadline = {
  expiresAtMs: number;
  signal: AbortSignal;
  remainingMs: () => number;
  dispose: () => void;
};

class NodeWorkerLaunchTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function isTerminalReceipt(
  receipt: NodeWorkerSupervisorReceipt,
): receipt is TerminalNodeWorkerSupervisorReceipt {
  return (
    receipt.state === "completed" ||
    receipt.state === "failed" ||
    receipt.state === "interrupted" ||
    receipt.state === "cancelled"
  );
}

function snapshotLaunchInput(input: NodeWorkerLaunchInput): NodeWorkerLaunchInput {
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    throw new Error("node worker launch input is not serializable");
  }
  return parseNodeWorkerLaunchInput(encoded);
}

function expectedIdentity(input: NodeWorkerLaunchInput): NodeWorkerSupervisorIdentity {
  if (input.launchId !== input.descriptor.assignment.turnId) {
    throw new Error("node worker launch ID must match the durable turn ID");
  }
  return {
    launchId: input.launchId,
    planHash: nodeWorkerPlanHash(input),
    environmentId: input.descriptor.admission.environmentId,
    sessionId: input.descriptor.admission.sessionId,
    ownerEpoch: input.descriptor.admission.ownerEpoch,
    placementGeneration: input.placementGeneration,
    runId: input.descriptor.assignment.runId,
  };
}

function receiptMatchesIdentity(
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

function parseInvokeReceipt(
  payloadJSON: string | null | undefined,
): NodeWorkerSupervisorReceipt | null {
  if (!payloadJSON) {
    throw new Error("node worker supervisor response omitted payload JSON");
  }
  let value: unknown;
  try {
    value = JSON.parse(payloadJSON) as unknown;
  } catch {
    throw new Error("node worker supervisor response contained malformed JSON");
  }
  if (value === null) {
    return null;
  }
  const receipt = parseNodeWorkerSupervisorReceipt(value);
  if (!receipt) {
    throw new Error("node worker supervisor response violated the private receipt contract");
  }
  return receipt;
}

function signalError(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signalError(signal, "node worker operation aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signalError(signal, "node worker operation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("node worker operation failed"));
      },
    );
  });
}

function createDeadline(params: {
  now: () => number;
  timeoutMs: number;
  signal?: AbortSignal;
  label: string;
}): OperationDeadline {
  if (!Number.isFinite(params.timeoutMs) || params.timeoutMs <= 0) {
    throw new Error(`${params.label} timeout must be a positive finite number`);
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`${params.label} timed out`)),
    params.timeoutMs,
  );
  timer.unref?.();
  const signal = params.signal
    ? AbortSignal.any([params.signal, controller.signal])
    : controller.signal;
  const expiresAtMs = params.now() + params.timeoutMs;
  return {
    expiresAtMs,
    signal,
    remainingMs: () => Math.max(0, expiresAtMs - params.now()),
    dispose: () => clearTimeout(timer),
  };
}

export function createNodeWorkerLaunchAdapter(options: NodeWorkerLaunchAdapterOptions) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepWithAbort;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const cancellationTimeoutMs = options.cancellationTimeoutMs ?? DEFAULT_CANCELLATION_TIMEOUT_MS;

  const findNode = async (params: {
    transport: NodeWorkerSupervisorTransport;
    deviceId: string;
    requireLaunchAvailability?: boolean;
    signal: AbortSignal;
  }): Promise<NodeWorkerSupervisorNodeProof> => {
    let nodes: readonly NodeWorkerSupervisorNodeProof[];
    try {
      nodes = await raceWithSignal(params.transport.listCurrentNodes(), params.signal);
    } catch (error) {
      if (params.signal.aborted) {
        throw error;
      }
      throw new NodeWorkerLaunchTransportError(
        "UNAVAILABLE",
        "device worker node discovery is unavailable",
      );
    }
    const node = nodes.find(
      (candidate) =>
        candidate.nodeId === params.deviceId &&
        (!params.requireLaunchAvailability || candidate.workerHost.capacity === "available"),
    );
    if (!node) {
      throw new NodeWorkerLaunchTransportError(
        "NOT_CONNECTED",
        "device worker node is not currently connected",
      );
    }
    return node;
  };

  const invoke = async (params: {
    deviceId: string;
    command:
      | typeof NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND
      | typeof NODE_WORKER_SUPERVISOR_STATUS_COMMAND
      | typeof NODE_WORKER_SUPERVISOR_CANCEL_COMMAND;
    payload: unknown;
    requireLaunchAvailability?: boolean;
    isAuthorized: () => boolean;
    deadline: OperationDeadline;
    onDispatchReady?: () => void;
  }): Promise<NodeWorkerSupervisorReceipt | null> => {
    if (!params.isAuthorized()) {
      throw new NodeWorkerLaunchTransportError(
        "APPROVAL_AUTHORITY_CLOSED",
        "node worker authority closed",
      );
    }
    const remainingMs = params.deadline.remainingMs();
    if (remainingMs <= 0 || params.deadline.signal.aborted) {
      throw params.deadline.signal.reason ?? new Error("node worker operation timed out");
    }
    const transport = options.getTransport();
    if (!transport) {
      throw new NodeWorkerLaunchTransportError(
        "UNAVAILABLE",
        "device worker node transport is unavailable",
      );
    }
    // The deadline is the sole expiry authority unless the per-RPC budget binds first.
    // A second timer armed at the same expiry makes "retryable RPC timeout" versus
    // "terminal deadline" a scheduling race, and the retryable branch then funds another
    // attempt out of a residual budget too small to complete it.
    const rpcBudgetMs = Math.min(rpcTimeoutMs, remainingMs);
    const rpcController = rpcBudgetMs < remainingMs ? new AbortController() : undefined;
    const rpcTimer = rpcController
      ? setTimeout(() => rpcController.abort(new Error("node worker RPC timed out")), rpcBudgetMs)
      : undefined;
    rpcTimer?.unref?.();
    const signal = rpcController
      ? AbortSignal.any([params.deadline.signal, rpcController.signal])
      : params.deadline.signal;
    try {
      const node = await findNode({
        transport,
        deviceId: params.deviceId,
        requireLaunchAvailability: params.requireLaunchAvailability,
        signal,
      });
      const operation = transport.invoke({
        node,
        command: params.command,
        params: params.payload,
        timeoutMs: rpcBudgetMs,
        signal,
        idempotencyKey:
          params.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND &&
          typeof params.payload === "object" &&
          params.payload !== null &&
          "launchId" in params.payload &&
          typeof params.payload.launchId === "string"
            ? params.payload.launchId
            : undefined,
        isDispatchAuthorized: params.isAuthorized,
        ...(params.onDispatchReady ? { onDispatchReady: params.onDispatchReady } : {}),
      });
      const result = await raceWithSignal(operation, signal);
      if (!result.ok) {
        const code = result.error?.code ?? "UNAVAILABLE";
        throw new NodeWorkerLaunchTransportError(
          code,
          code === NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE
            ? "device worker capacity remained full"
            : `node worker supervisor invocation failed (${code})`,
        );
      }
      return parseInvokeReceipt(result.payloadJSON);
    } catch (error) {
      if (rpcController?.signal.aborted && !params.deadline.signal.aborted) {
        throw new NodeWorkerLaunchTransportError("TIMEOUT", "node worker RPC timed out");
      }
      throw error;
    } finally {
      clearTimeout(rpcTimer);
    }
  };

  const validateReceipt = (
    receipt: NodeWorkerSupervisorReceipt,
    expected: NodeWorkerSupervisorIdentity,
  ): NodeWorkerSupervisorReceipt => {
    if (!receiptMatchesIdentity(receipt, expected)) {
      throw new Error("node worker supervisor receipt identity mismatch");
    }
    return receipt;
  };

  const waitBeforeRetry = async (params: {
    delayMs: number;
    deadline: OperationDeadline;
  }): Promise<number> => {
    const remainingMs = params.deadline.remainingMs();
    if (remainingMs <= 0 || params.deadline.signal.aborted) {
      throw params.deadline.signal.reason ?? new Error("node worker operation timed out");
    }
    await raceWithSignal(
      sleep(Math.min(params.delayMs, remainingMs), params.deadline.signal),
      params.deadline.signal,
    );
    return Math.min(params.delayMs * 2, MAX_RETRY_DELAY_MS);
  };

  const cancelUntilTerminal = async (params: {
    request: DeviceWorkerLaunchRequest;
    expected: NodeWorkerSupervisorIdentity;
  }): Promise<TerminalNodeWorkerSupervisorReceipt> => {
    const deadline = createDeadline({
      now,
      timeoutMs: cancellationTimeoutMs,
      label: "node worker cancellation",
    });
    let delayMs = pollIntervalMs;
    try {
      while (!deadline.signal.aborted && deadline.remainingMs() > 0) {
        if (!params.request.isCancellationAuthorized()) {
          throw new Error("node worker cancellation authority closed before terminal settlement");
        }
        try {
          const receipt = await invoke({
            deviceId: params.request.deviceId,
            command: NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
            payload: params.expected,
            isAuthorized: params.request.isCancellationAuthorized,
            deadline,
          });
          if (receipt) {
            const validated = validateReceipt(receipt, params.expected);
            if (isTerminalReceipt(validated)) {
              return validated;
            }
            delayMs = pollIntervalMs;
          }
        } catch (error) {
          if (deadline.signal.aborted) {
            break;
          }
          if (
            !(error instanceof NodeWorkerLaunchTransportError) ||
            !RETRYABLE_TRANSPORT_CODES.has(error.code)
          ) {
            throw error;
          }
        }
        delayMs = await waitBeforeRetry({ delayMs, deadline });
      }
    } finally {
      deadline.dispose();
    }
    throw new Error("node worker cancellation outcome is unknown after transport loss");
  };

  const launch = async (
    request: DeviceWorkerLaunchRequest,
  ): Promise<TerminalNodeWorkerSupervisorReceipt> => {
    const input = snapshotLaunchInput(request.input);
    const stableRequest = { ...request, input };
    const expected = expectedIdentity(input);
    const deadline = createDeadline({
      now,
      timeoutMs: request.timeoutMs,
      ...(request.signal ? { signal: request.signal } : {}),
      label: "node worker launch",
    });
    const availabilityDeadline = createDeadline({
      now,
      timeoutMs: DEFAULT_AVAILABILITY_TIMEOUT_MS,
      signal: deadline.signal,
      label: "node worker availability",
    });
    let mayHaveLaunched = false;
    let dispatchReady = false;
    let pollStatus = false;
    let delayMs = pollIntervalMs;
    const markDispatchReady = () => {
      mayHaveLaunched = true;
      if (!dispatchReady) {
        dispatchReady = true;
        stableRequest.onDispatchReady?.();
      }
    };
    try {
      while (true) {
        if (deadline.signal.aborted) {
          throw signalError(deadline.signal, "node worker launch aborted");
        }
        if (!dispatchReady && availabilityDeadline.signal.aborted) {
          throw new WorkerRunnerUnavailableError();
        }
        if (!stableRequest.isDispatchAuthorized()) {
          throw new Error("node worker launch authority closed");
        }
        try {
          const attemptDeadline = dispatchReady ? deadline : availabilityDeadline;
          const receipt = await invoke({
            deviceId: stableRequest.deviceId,
            command: pollStatus
              ? NODE_WORKER_SUPERVISOR_STATUS_COMMAND
              : NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
            payload: pollStatus ? { launchId: input.launchId } : input,
            ...(!pollStatus ? { requireLaunchAvailability: true } : {}),
            isAuthorized: stableRequest.isDispatchAuthorized,
            deadline: attemptDeadline,
            ...(!pollStatus
              ? {
                  onDispatchReady: markDispatchReady,
                }
              : {}),
          });
          if (!receipt) {
            pollStatus = false;
          } else {
            if (!pollStatus) {
              markDispatchReady();
            }
            const validated = validateReceipt(receipt, expected);
            mayHaveLaunched = true;
            if (isTerminalReceipt(validated)) {
              return validated;
            }
            pollStatus = true;
            delayMs = pollIntervalMs;
          }
        } catch (error) {
          if (deadline.signal.aborted || !stableRequest.isDispatchAuthorized()) {
            throw error;
          }
          if (!dispatchReady && availabilityDeadline.signal.aborted) {
            throw new WorkerRunnerUnavailableError();
          }
          if (
            !(error instanceof NodeWorkerLaunchTransportError) ||
            !RETRYABLE_TRANSPORT_CODES.has(error.code)
          ) {
            throw error;
          }
          pollStatus = false;
        }
        delayMs = await waitBeforeRetry({
          delayMs,
          deadline: dispatchReady ? deadline : availabilityDeadline,
        });
      }
    } catch (error) {
      if (!dispatchReady && availabilityDeadline.signal.aborted && !deadline.signal.aborted) {
        throw new WorkerRunnerUnavailableError();
      }
      // The node authors this result only after its durable claim stayed absent.
      // Transport dispatch is therefore not launch ambiguity and needs no cancel.
      if (
        error instanceof NodeWorkerLaunchTransportError &&
        error.code === NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE
      ) {
        throw error;
      }
      if (!mayHaveLaunched) {
        throw error;
      }
      let terminal: TerminalNodeWorkerSupervisorReceipt;
      try {
        terminal = await cancelUntilTerminal({ request: stableRequest, expected });
      } catch (cancelError) {
        throw Object.assign(
          new Error("node worker launch failed and cancellation could not be confirmed", {
            cause: error instanceof Error ? error : new Error("node worker launch failed"),
          }),
          { cancellationError: cancelError },
        );
      }
      if (deadline.signal.aborted || !stableRequest.isDispatchAuthorized()) {
        return terminal;
      }
      throw error;
    } finally {
      availabilityDeadline.dispose();
      deadline.dispose();
    }
  };

  return { launch };
}
