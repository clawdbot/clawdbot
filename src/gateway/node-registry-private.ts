import { randomUUID } from "node:crypto";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isPrivateNodeInvokeCommand,
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_PRIVATE_COMMANDS,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
} from "../infra/node-commands.js";
import {
  NODE_WORKER_BUNDLE_RETENTION_VERSION,
  NODE_WORKER_BUNDLE_STATUS_VERSION,
  NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
  type NodeRunnerInventoryIssue,
  type NodeRunnerInventoryDeclaration,
  type NodeWorkerCapacitySnapshot,
} from "../infra/node-runner-inventory.js";
import type { NodeWorkerBundleStatus } from "../shared/node-list-types.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../utils/absolute-deadline.js";
import { sameWorkerProtocolFeatures } from "../worker/worker-build-identity.js";
import { NODE_INVOKE_PAIRING_CHANGED_ABORT } from "./node-registry-private-token.js";
import type { NodeInvokeStreamController, PendingInvoke } from "./node-registry.invoke-stream.js";
import {
  normalizeSystemRunInvokeParams,
  resolvePendingSystemRunEvent,
} from "./node-registry.system-run.js";
import {
  createNodeRunnerStatePublisher,
  isNodeWorkerHostClientId,
  resolveNodeRunnerInventoryIssue,
  resolveNodeWorkerSupervisorProof,
  sameBundleStatusObservation,
  sameNodeWorkerHostDeclaration,
  type NodeRunnerInventoryRecord,
  type NodeRunnerRegistrySession,
  type NodeRunnerStateChange,
  type NodeRunnerStatePublisher,
  type NodeWorkerBundleStatusObservation,
  type NodeWorkerSupervisorNodeProof,
} from "./node-runner-inventory-runtime.js";

export type {
  NodeRunnerStateChange,
  NodeWorkerSupervisorNodeProof,
} from "./node-runner-inventory-runtime.js";

type NodeRegistryPrivateSession = NodeRunnerRegistrySession;

type NodeInvokeResult = {
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string | null;
  error?: { code?: string; message?: string } | null;
};

type PairingBoundNodeSession = NodeRegistryPrivateSession & { pairingIdentity: string };
type PairingLeaseResolution =
  | { status: "current"; session: PairingBoundNodeSession }
  | { status: "stale"; presenceInvalidated: boolean }
  | { status: "unavailable" };

type NodeInvokeParams = {
  nodeId: string;
  expectedConnId?: string;
  expectedPairingGeneration?: string;
  command: string;
  params?: unknown;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  onProgress?: (chunk: string) => void;
  signal?: AbortSignal;
  idempotencyKey?: string;
  sessionKey?: string;
  onDispatchReady?: (invokeId: string) => void;
  isDispatchAuthorized?: () => boolean;
};

type NodeWorkerPrivateCommand = (typeof NODE_WORKER_PRIVATE_COMMANDS)[number];

export type NodeWorkerSupervisorTransport = {
  listCurrentNodes(): Promise<readonly NodeWorkerSupervisorNodeProof[]>;
  hasCurrentRunner(nodeId: string): boolean;
  /** Diagnostic connection presence, independent of session-host eligibility. */
  isConnected?(nodeId: string): boolean;
  getIssue?(nodeId: string): NodeRunnerInventoryIssue | undefined;
  getBundleStatus?(nodeId: string): NodeWorkerBundleStatusObservation | undefined;
  acceptBundleStatus?(
    node: NodeWorkerSupervisorNodeProof,
    observation: NodeWorkerBundleStatusObservation | undefined,
  ): boolean;
  isCurrent(
    node: NodeWorkerSupervisorNodeProof,
    requireLaunchEligibility?: boolean,
    requiredCommands?: readonly string[],
  ): boolean;
  invoke(params: {
    node: NodeWorkerSupervisorNodeProof;
    command: NodeWorkerPrivateCommand;
    params?: unknown;
    timeoutMs?: number;
    signal?: AbortSignal;
    idempotencyKey?: string;
    isDispatchAuthorized: () => boolean;
    onDispatchReady?: (invokeId: string) => void;
  }): Promise<NodeInvokeResult>;
};

type NodeRegistryPrivateContext = {
  getNode: (nodeId: string) => PairingBoundNodeSession | undefined;
  listCurrentConnected: () => Promise<NodeRegistryPrivateSession[]>;
  hasCurrentPairingStateResolver: boolean;
  resolvePairingLease: (node: PairingBoundNodeSession) => Promise<PairingLeaseResolution>;
  pendingInvokes: Map<string, PendingInvoke>;
  invokeStreams: NodeInvokeStreamController;
  sendEventToSession: (
    node: NodeRegistryPrivateSession,
    event: string,
    payload: unknown,
  ) => boolean;
  rememberAuthorizedSystemRunEvent: (event: {
    nodeId: string;
    connId: string;
    runId: string;
    sessionKey?: string;
    timeoutMs?: number | null;
  }) => void;
  publishActiveNodeContext: () => void;
};

type GenerationBoundPendingInvoke = {
  expectedGeneration: string;
  controller: AbortController;
};

type NodeRunnerInventoryUpdateResult = {
  changed: boolean;
};

type NodeRegistryPrivateState = {
  context: NodeRegistryPrivateContext;
  runnerInventoryByConn: Map<string, NodeRunnerInventoryRecord>;
  bundleStatusByConn: Map<string, NodeWorkerBundleStatusObservation>;
  runnerState: NodeRunnerStatePublisher;
  generationBoundInvokes: WeakMap<PendingInvoke, GenerationBoundPendingInvoke>;
  invokeCore: (params: NodeInvokeParams, allowPrivateCommand: boolean) => Promise<NodeInvokeResult>;
  updateRunnerInventory: (params: {
    nodeId: string;
    connId: string | undefined;
    declaration: NodeRunnerInventoryDeclaration;
  }) => NodeRunnerInventoryUpdateResult | null;
  workerSupervisorTransport: NodeWorkerSupervisorTransport;
};

const NODE_REGISTRY_PRIVATE_STATES = new WeakMap<object, NodeRegistryPrivateState>();

function isWorkerSupervisorProofCurrent(
  state: NodeRegistryPrivateState,
  proof: NodeWorkerSupervisorNodeProof,
  requireLaunchEligibility: boolean,
  requiredCommands: readonly string[] = [],
  requireEnvironmentSession = false,
): boolean {
  const node = state.context.getNode(proof.nodeId);
  if (!node || node.client.invalidated === true || node.connId !== proof.connId) {
    return false;
  }
  const current = resolveNodeWorkerSupervisorProof(node, state.runnerInventoryByConn);
  return (
    current?.pairingIdentity === proof.pairingIdentity &&
    current.pairingGeneration === proof.pairingGeneration &&
    current.clientId === proof.clientId &&
    current.clientMode === proof.clientMode &&
    current.protocolFeature === proof.protocolFeature &&
    (!requireLaunchEligibility || current.workerHost.capacity.available > 0) &&
    (!requireEnvironmentSession ||
      current.workerHost.environmentSession === NODE_WORKER_ENVIRONMENT_SESSION_VERSION) &&
    requiredCommands.every((command) => current.commands.includes(command))
  );
}

function updateWorkerRunnerInventory(
  state: NodeRegistryPrivateState,
  params: {
    nodeId: string;
    connId: string | undefined;
    declaration: NodeRunnerInventoryDeclaration;
  },
): NodeRunnerInventoryUpdateResult | null {
  const node = state.context.getNode(params.nodeId);
  const publishesRunnerDialect = params.declaration.protocolFeatures.length === 1;
  if (
    !node ||
    node.client.invalidated === true ||
    node.connId !== params.connId ||
    !isNodeWorkerHostClientId(node.clientId) ||
    node.clientMode !== "node"
  ) {
    return null;
  }
  const previous = state.runnerInventoryByConn.get(node.connId);
  if (!publishesRunnerDialect) {
    const inventoryChanged = state.runnerInventoryByConn.delete(node.connId);
    const statusChanged = state.bundleStatusByConn.delete(node.connId);
    const changed = inventoryChanged || statusChanged;
    if (changed) {
      state.context.publishActiveNodeContext();
      state.runnerState.reconcile(node.nodeId, true);
    }
    return { changed };
  }
  const workerHost = "workerHost" in params.declaration ? params.declaration.workerHost : undefined;
  const next: NodeRunnerInventoryRecord = {
    nodeId: node.nodeId,
    connId: node.connId,
    pairingIdentity: node.pairingIdentity,
    ...(node.pairingGeneration ? { pairingGeneration: node.pairingGeneration } : {}),
    clientId: node.clientId,
    clientMode: "node",
    protocolFeatures: [...params.declaration.protocolFeatures],
    ...(workerHost
      ? {
          workerHost: workerHost.enabled
            ? { ...workerHost, capacity: { ...workerHost.capacity } }
            : { enabled: false },
        }
      : {}),
  };
  const statusCleared =
    next.workerHost?.enabled !== true ||
    next.workerHost.bundleRetention === undefined ||
    next.workerHost.bundleStatus === undefined
      ? state.bundleStatusByConn.delete(node.connId)
      : false;
  const changed =
    !previous ||
    previous.pairingGeneration !== next.pairingGeneration ||
    !sameWorkerProtocolFeatures(previous.protocolFeatures, next.protocolFeatures) ||
    !sameNodeWorkerHostDeclaration(previous.workerHost, next.workerHost) ||
    statusCleared;
  if (changed) {
    state.runnerInventoryByConn.set(node.connId, next);
    state.context.publishActiveNodeContext();
    state.runnerState.reconcile(node.nodeId, true);
  }
  return { changed };
}

async function invokeNodeRegistryCore(
  state: NodeRegistryPrivateState,
  params: NodeInvokeParams,
  allowPrivateCommand: boolean,
): Promise<NodeInvokeResult> {
  let timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 30_000, 0);
  // Explicit budgets include pairing and serialization; omitted budgets retain
  // the post-dispatch default, and zero keeps long-lived invokes unbounded.
  const deadlineAtMs =
    Number.isFinite(params.timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
  if (isPrivateNodeInvokeCommand(params.command) && !allowPrivateCommand) {
    return {
      ok: false,
      error: { code: "INVALID_REQUEST", message: "private node command is not invocable" },
    };
  }
  if (params.signal?.aborted) {
    return { ok: false, error: { code: "ABORTED", message: "node invoke cancelled" } };
  }
  let node = state.context.getNode(params.nodeId);
  if (!node) {
    return { ok: false, error: { code: "NOT_CONNECTED", message: "node not connected" } };
  }
  if (node.client.invalidated === true) {
    return {
      ok: false,
      error: { code: "PAIRING_CHANGED", message: "node pairing changed before dispatch" },
    };
  }
  const expectedPairingGeneration = params.expectedPairingGeneration ?? node.pairingGeneration;
  if (state.context.hasCurrentPairingStateResolver && !expectedPairingGeneration) {
    return {
      ok: false,
      error: { code: "PAIRING_CHANGED", message: "node pairing generation unavailable" },
    };
  }
  if (expectedPairingGeneration && node.pairingGeneration !== expectedPairingGeneration) {
    return {
      ok: false,
      error: { code: "PAIRING_CHANGED", message: "node pairing changed before dispatch" },
    };
  }
  if (params.expectedConnId && node.connId !== params.expectedConnId) {
    return {
      ok: false,
      error: { code: "ROUTE_CHANGED", message: "node connection changed before dispatch" },
    };
  }
  if (expectedPairingGeneration && state.context.hasCurrentPairingStateResolver) {
    const pairingNode = node;
    const resolution = await awaitWithinDeadline(
      () => state.context.resolvePairingLease(pairingNode),
      deadlineAtMs,
    );
    if (resolution === ABSOLUTE_DEADLINE_EXPIRED) {
      return { ok: false, error: { code: "TIMEOUT", message: "node invoke timed out" } };
    }
    if (resolution.status === "unavailable") {
      return {
        ok: false,
        error: { code: "UNAVAILABLE", message: "node pairing state unavailable before dispatch" },
      };
    }
    if (resolution.status !== "current") {
      return {
        ok: false,
        error: { code: "PAIRING_CHANGED", message: "node pairing changed before dispatch" },
      };
    }
    node = resolution.session;
    if (params.expectedConnId && node.connId !== params.expectedConnId) {
      return {
        ok: false,
        error: { code: "ROUTE_CHANGED", message: "node connection changed before dispatch" },
      };
    }
  }
  const requestId = randomUUID();
  const invokeParams = normalizeSystemRunInvokeParams({
    command: params.command,
    params: params.params,
  });
  const payload = {
    id: requestId,
    nodeId: params.nodeId,
    command: params.command,
    paramsJSON:
      "params" in params && invokeParams !== undefined ? JSON.stringify(invokeParams) : null,
    timeoutMs,
    idempotencyKey: params.idempotencyKey,
    sessionKey: normalizeOptionalString(params.sessionKey),
    pairingGeneration: params.expectedPairingGeneration || node.pairingGeneration,
  };
  const systemRunEvent = resolvePendingSystemRunEvent({
    command: params.command,
    params: invokeParams,
  });
  // Serialization can consume the budget or close caller-owned authority.
  // Revalidate both before arming pending state and handing off to transport.
  if (params.signal?.aborted) {
    return { ok: false, error: { code: "ABORTED", message: "node invoke cancelled" } };
  }
  if (params.isDispatchAuthorized?.() === false) {
    return {
      ok: false,
      error: {
        code: "APPROVAL_AUTHORITY_CLOSED",
        message: "runtime authority closed before node dispatch",
      },
    };
  }
  if (deadlineAtMs !== undefined) {
    timeoutMs = Math.max(0, deadlineAtMs - Date.now());
    if (timeoutMs === 0) {
      return { ok: false, error: { code: "TIMEOUT", message: "node invoke timed out" } };
    }
    payload.timeoutMs = timeoutMs;
  }
  const result = new Promise<NodeInvokeResult>((resolve, reject) => {
    const pending: PendingInvoke = {
      nodeId: params.nodeId,
      connId: node.connId,
      command: params.command,
      systemRunEvent,
      resolve,
      reject,
      nextProgressSeq: 0,
      progressChunks: new Map(),
      nextInputSeq: 0,
      ...(params.onProgress ? { onProgress: params.onProgress } : {}),
    };
    const generationController = params.expectedPairingGeneration
      ? new AbortController()
      : undefined;
    if (params.expectedPairingGeneration && generationController) {
      state.generationBoundInvokes.set(pending, {
        expectedGeneration: params.expectedPairingGeneration,
        controller: generationController,
      });
    }
    const signal = generationController
      ? params.signal
        ? AbortSignal.any([params.signal, generationController.signal])
        : generationController.signal
      : params.signal;
    const idleTimeoutMs = resolveTimerTimeoutMs(params.idleTimeoutMs, 0, 0);
    state.context.invokeStreams.armPending({
      requestId,
      pending,
      timeoutMs,
      idleTimeoutMs,
      ...(signal ? { signal } : {}),
    });
  });
  if (!state.context.pendingInvokes.has(requestId)) {
    return await result;
  }
  const ok = state.context.sendEventToSession(node, "node.invoke.request", payload);
  if (!ok) {
    const pending = state.context.pendingInvokes.get(requestId);
    if (pending) {
      state.context.invokeStreams.clearTimers(pending);
      state.context.pendingInvokes.delete(requestId);
      pending.resolve({
        ok: false,
        error: { code: "UNAVAILABLE", message: "failed to send invoke to node" },
      });
    }
    return await result;
  }
  if (systemRunEvent) {
    state.context.rememberAuthorizedSystemRunEvent({
      nodeId: params.nodeId,
      connId: node.connId,
      ...systemRunEvent,
    });
  }
  params.onDispatchReady?.(requestId);
  return await result;
}

export function registerNodeRegistryPrivateRuntime(
  nodeRegistry: object,
  context: NodeRegistryPrivateContext,
): void {
  const state = {} as NodeRegistryPrivateState;
  state.context = context;
  state.runnerInventoryByConn = new Map();
  state.bundleStatusByConn = new Map();
  state.runnerState = createNodeRunnerStatePublisher(context.getNode, state.runnerInventoryByConn);
  state.generationBoundInvokes = new WeakMap();
  state.invokeCore = async (params, allowPrivateCommand) =>
    await invokeNodeRegistryCore(state, params, allowPrivateCommand);
  state.updateRunnerInventory = (params) => updateWorkerRunnerInventory(state, params);
  state.workerSupervisorTransport = {
    listCurrentNodes: async () => {
      const current = await context.listCurrentConnected();
      return current.flatMap((node) => {
        const proof = resolveNodeWorkerSupervisorProof(node, state.runnerInventoryByConn);
        return proof ? [proof] : [];
      });
    },
    hasCurrentRunner: state.runnerState.hasCurrent,
    isConnected: (nodeId) => {
      const node = context.getNode(nodeId);
      return Boolean(node && node.client.invalidated !== true);
    },
    getIssue: (nodeId) => {
      const node = context.getNode(nodeId);
      return node ? resolveNodeRunnerInventoryIssue(node, state.runnerInventoryByConn) : undefined;
    },
    getBundleStatus: (nodeId) => {
      const node = context.getNode(nodeId);
      const observation = node ? state.bundleStatusByConn.get(node.connId) : undefined;
      return observation ? structuredClone(observation) : undefined;
    },
    acceptBundleStatus: (node, observation) => {
      if (!isWorkerSupervisorProofCurrent(state, node, false)) {
        return false;
      }
      const currentNode = state.context.getNode(node.nodeId);
      const currentProof = currentNode
        ? resolveNodeWorkerSupervisorProof(currentNode, state.runnerInventoryByConn)
        : undefined;
      if (
        currentProof?.workerHost.bundleRetention !== NODE_WORKER_BUNDLE_RETENTION_VERSION ||
        currentProof.workerHost.bundleStatus !== NODE_WORKER_BUNDLE_STATUS_VERSION
      ) {
        return false;
      }
      const previous = state.bundleStatusByConn.get(node.connId);
      if (observation) {
        state.bundleStatusByConn.set(node.connId, structuredClone(observation));
      } else {
        state.bundleStatusByConn.delete(node.connId);
      }
      if (!sameBundleStatusObservation(previous, observation)) {
        state.runnerState.reconcile(node.nodeId, true);
      }
      return true;
    },
    isCurrent: (node, requireLaunchEligibility = false, requiredCommands = []) =>
      isWorkerSupervisorProofCurrent(state, node, requireLaunchEligibility, requiredCommands),
    invoke: async (params) => {
      if (!NODE_WORKER_PRIVATE_COMMANDS.includes(params.command)) {
        return {
          ok: false,
          error: { code: "INVALID_REQUEST", message: "private node command is not allowed" },
        };
      }
      const isProofCurrent = () =>
        params.isDispatchAuthorized() &&
        isWorkerSupervisorProofCurrent(
          state,
          params.node,
          false,
          [],
          params.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND ||
            params.command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
        );
      if (!isProofCurrent()) {
        return {
          ok: false,
          error: {
            code: "PRIVATE_DIALECT_UNAVAILABLE",
            message: "node worker supervisor dialect is unavailable",
          },
        };
      }
      return await state.invokeCore(
        {
          nodeId: params.node.nodeId,
          expectedConnId: params.node.connId,
          expectedPairingGeneration: params.node.pairingGeneration,
          command: params.command,
          ...(params.params !== undefined ? { params: params.params } : {}),
          ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
          ...(params.signal ? { signal: params.signal } : {}),
          ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
          isDispatchAuthorized: isProofCurrent,
          ...(params.onDispatchReady ? { onDispatchReady: params.onDispatchReady } : {}),
        },
        true,
      );
    },
  };
  NODE_REGISTRY_PRIVATE_STATES.set(nodeRegistry, state);
}

export function createNodeRegistryRuntime<TRegistry extends object>(
  create: () => TRegistry,
): {
  nodeRegistry: TRegistry;
  nodeWorkerSupervisorTransport: NodeWorkerSupervisorTransport;
} {
  const nodeRegistry = create();
  const state = NODE_REGISTRY_PRIVATE_STATES.get(nodeRegistry);
  if (!state) {
    throw new Error("node registry private runtime was not initialized during creation");
  }
  return {
    nodeRegistry,
    nodeWorkerSupervisorTransport: state.workerSupervisorTransport,
  };
}

export function setNodeRunnerStateChangedListener(
  nodeRegistry: object,
  listener: (nodeId: string, change: NodeRunnerStateChange) => void,
): void {
  const state = NODE_REGISTRY_PRIVATE_STATES.get(nodeRegistry);
  if (!state) {
    throw new Error("node registry private runtime was not initialized");
  }
  state.runnerState.setListener(listener);
}

export function reconcileNodeRunnerAvailability(nodeRegistry: object, nodeId: string): void {
  const state = NODE_REGISTRY_PRIVATE_STATES.get(nodeRegistry);
  if (!state) {
    throw new Error("node registry private runtime was not initialized");
  }
  state.runnerState.reconcile(nodeId, false);
}

export function invokePublicNodeRegistry(
  nodeRegistry: object,
  params: NodeInvokeParams,
): Promise<NodeInvokeResult> {
  const state = NODE_REGISTRY_PRIVATE_STATES.get(nodeRegistry);
  if (!state) {
    throw new Error("node registry private runtime was not initialized");
  }
  return state.invokeCore(params, false);
}

export function updateNodeRunnerInventory(params: {
  registry: object;
  nodeId: string;
  connId: string | undefined;
  declaration: NodeRunnerInventoryDeclaration;
}): NodeRunnerInventoryUpdateResult | null {
  return (
    NODE_REGISTRY_PRIVATE_STATES.get(params.registry)?.updateRunnerInventory({
      nodeId: params.nodeId,
      connId: params.connId,
      declaration: params.declaration,
    }) ?? null
  );
}

export function forgetNodeRunnerInventory(nodeRegistry: object, connId: string): void {
  const state = NODE_REGISTRY_PRIVATE_STATES.get(nodeRegistry);
  const declaration = state?.runnerInventoryByConn.get(connId);
  if (!state || !declaration || !state.runnerInventoryByConn.delete(connId)) {
    return;
  }
  state.bundleStatusByConn.delete(connId);
  state.runnerState.reconcile(declaration.nodeId, true);
}

/** Capture the catalog's live metadata without reloading pairing or mutating registry state. */
export function collectNodeCatalogRuntimeState(
  registry: object,
  connectedNodes: ReadonlyArray<
    Pick<NodeRegistryPrivateSession, "nodeId" | "connId" | "pairingGeneration">
  >,
) {
  const sessionHostNodeIds = new Set<string>();
  const issuesByNodeId = new Map<string, NodeRunnerInventoryIssue[]>();
  const workerSlotsByNodeId = new Map<string, NodeWorkerCapacitySnapshot>();
  const workerBundleByNodeId = new Map<string, NodeWorkerBundleStatus>();
  const state = NODE_REGISTRY_PRIVATE_STATES.get(registry);
  // This synchronous projection reads one current connection per supplied snapshot row;
  // it must not reload pairing, publish presence, or admit worker execution.
  for (const node of connectedNodes) {
    const current = state?.context.getNode(node.nodeId);
    if (!state || !current || current.connId !== node.connId) {
      continue;
    }
    const proof = resolveNodeWorkerSupervisorProof(current, state.runnerInventoryByConn);
    if (proof && proof.pairingGeneration === node.pairingGeneration) {
      sessionHostNodeIds.add(node.nodeId);
    }
    const issue = resolveNodeRunnerInventoryIssue(current, state.runnerInventoryByConn);
    if (issue) {
      issuesByNodeId.set(node.nodeId, [issue]);
    }
    if (proof) {
      workerSlotsByNodeId.set(node.nodeId, { ...proof.workerHost.capacity });
    }
    const observation = state.bundleStatusByConn.get(node.connId);
    if (observation) {
      workerBundleByNodeId.set(node.nodeId, structuredClone(observation.status));
    }
  }
  return {
    sessionHostNodeIds,
    issuesByNodeId,
    workerSlotsByNodeId,
    workerBundleByNodeId,
  };
}

export function isNodeRegistryPendingInvokeConnectionActive(params: {
  registry: object;
  pending: PendingInvoke;
  currentNode: NodeRegistryPrivateSession | undefined;
}): boolean {
  const state = NODE_REGISTRY_PRIVATE_STATES.get(params.registry);
  const binding = state?.generationBoundInvokes.get(params.pending);
  return (
    params.currentNode?.connId === params.pending.connId &&
    (!binding || params.currentNode.pairingGeneration === binding.expectedGeneration)
  );
}

export function settleNodeRegistryPairingGenerationChange(params: {
  registry: object;
  nodeId: string;
  connId: string;
  nextPairingGeneration: string;
}): void {
  const state = NODE_REGISTRY_PRIVATE_STATES.get(params.registry);
  if (!state) {
    return;
  }
  const inventoryChanged = state.runnerInventoryByConn.delete(params.connId);
  const statusChanged = state.bundleStatusByConn.delete(params.connId);
  if (inventoryChanged || statusChanged) {
    state.runnerState.reconcile(params.nodeId, true);
  }
  for (const pending of state.context.pendingInvokes.values()) {
    const binding = state.generationBoundInvokes.get(pending);
    if (
      pending.nodeId !== params.nodeId ||
      pending.connId !== params.connId ||
      !binding ||
      binding.expectedGeneration === params.nextPairingGeneration
    ) {
      continue;
    }
    binding.controller.abort(NODE_INVOKE_PAIRING_CHANGED_ABORT);
  }
}
