import { randomUUID } from "node:crypto";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import {
  isPrivateNodeInvokeCommand,
  NODE_WORKER_PRIVATE_COMMANDS,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
} from "../infra/node-commands.js";
import {
  NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  NODE_WORKER_SUPERVISOR_BUILD_PROTOCOL_FEATURE,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  NODE_WORKER_SUPERVISOR_LEGACY_PROTOCOL_FEATURE,
  type NodeRunnerInventoryIssue,
  type NodeRunnerInventoryDeclaration,
  type NodeWorkerHostDeclaration,
} from "../infra/node-runner-inventory.js";
import { sameWorkerProtocolFeatures } from "../worker/worker-build-identity.js";
import { NODE_INVOKE_PAIRING_CHANGED_ABORT } from "./node-registry-private-token.js";
import type {
  NodeInvokeStreamController,
  PendingInvoke,
  PendingSystemRunEvent,
} from "./node-registry.invoke-stream.js";
import { normalizeSystemRunTimeoutMs } from "./node-registry.system-run.js";

type NodeRegistryPrivateSession = {
  nodeId: string;
  connId: string;
  pairingIdentity?: string;
  pairingGeneration?: string;
  client: { invalidated?: boolean };
  clientId?: string;
  clientMode?: string;
  commands: string[];
};

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

export type NodeWorkerSupervisorNodeProof = {
  nodeId: string;
  connId: string;
  pairingIdentity: string;
  pairingGeneration: string;
  clientId: typeof GATEWAY_CLIENT_IDS.NODE_HOST;
  clientMode: "node";
  protocolFeature: typeof NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE;
  workerHost: Extract<NodeWorkerHostDeclaration, { enabled: true }>;
  commands: readonly string[];
};

export type NodeWorkerSupervisorTransport = {
  listCurrentNodes(): Promise<readonly NodeWorkerSupervisorNodeProof[]>;
  getIssue?(nodeId: string): NodeRunnerInventoryIssue | undefined;
  isCurrent(node: NodeWorkerSupervisorNodeProof, requireLaunchEligibility?: boolean): boolean;
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

type NodeRunnerInventoryRecord = Omit<
  NodeWorkerSupervisorNodeProof,
  "commands" | "pairingGeneration" | "protocolFeature" | "workerHost"
> & {
  protocolFeatures: readonly string[];
  workerHost?: NodeWorkerHostDeclaration;
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
  generationBoundInvokes: WeakMap<PendingInvoke, GenerationBoundPendingInvoke>;
  publishRunnerInventoryChanged: (nodeId: string) => void;
  invokeCore: (params: NodeInvokeParams, allowPrivateCommand: boolean) => Promise<NodeInvokeResult>;
  updateRunnerInventory: (params: {
    nodeId: string;
    connId: string | undefined;
    declaration: NodeRunnerInventoryDeclaration;
  }) => NodeRunnerInventoryUpdateResult | null;
  workerSupervisorTransport: NodeWorkerSupervisorTransport;
};

const NODE_REGISTRY_PRIVATE_STATES = new WeakMap<object, NodeRegistryPrivateState>();

function resolvePendingSystemRunEvent(params: {
  command: string;
  params?: unknown;
}): PendingSystemRunEvent | undefined {
  if (params.command !== "system.run" || !params.params || typeof params.params !== "object") {
    return undefined;
  }
  const obj = params.params as Record<string, unknown>;
  const runId = normalizeOptionalString(obj.runId) ?? "";
  if (!runId) {
    return undefined;
  }
  const timeoutMs = normalizeSystemRunTimeoutMs(obj.timeoutMs);
  const sessionKey = normalizeOptionalString(obj.sessionKey) ?? "";
  return {
    runId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function normalizeSystemRunInvokeParams(params: { command: string; params?: unknown }): unknown {
  if (
    params.command !== "system.run" ||
    !params.params ||
    typeof params.params !== "object" ||
    Array.isArray(params.params)
  ) {
    return params.params;
  }
  const obj = params.params as Record<string, unknown>;
  const normalized: Record<string, unknown> = {
    ...obj,
    runId: normalizeOptionalString(obj.runId) || randomUUID(),
  };
  const timeoutMs = normalizeSystemRunTimeoutMs(obj.timeoutMs);
  if (timeoutMs === undefined) {
    delete normalized.timeoutMs;
  } else {
    normalized.timeoutMs = timeoutMs;
  }
  return normalized;
}

function sameWorkerHostDeclaration(
  left: NodeWorkerHostDeclaration | undefined,
  right: NodeWorkerHostDeclaration | undefined,
): boolean {
  return (
    left?.enabled === right?.enabled &&
    (left?.enabled !== true ||
      (right?.enabled === true &&
        left.capacity === right.capacity &&
        left.bundlePrewarm === right.bundlePrewarm))
  );
}

function resolveWorkerSupervisorProof(
  node: NodeRegistryPrivateSession,
  runnerInventoryByConn: ReadonlyMap<string, NodeRunnerInventoryRecord>,
): NodeWorkerSupervisorNodeProof | undefined {
  const declaration = runnerInventoryByConn.get(node.connId);
  if (
    !declaration ||
    !node.pairingIdentity ||
    !node.pairingGeneration ||
    node.clientId !== GATEWAY_CLIENT_IDS.NODE_HOST ||
    node.clientMode !== "node" ||
    declaration.nodeId !== node.nodeId ||
    declaration.pairingIdentity !== node.pairingIdentity ||
    declaration.clientId !== node.clientId ||
    declaration.clientMode !== node.clientMode ||
    !declaration.protocolFeatures.includes(NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE) ||
    declaration.workerHost?.enabled !== true
  ) {
    return undefined;
  }
  return {
    nodeId: node.nodeId,
    connId: node.connId,
    pairingIdentity: node.pairingIdentity,
    pairingGeneration: node.pairingGeneration,
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: "node",
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: { ...declaration.workerHost },
    commands: [...node.commands],
  };
}

function resolveNodeRunnerIssue(
  node: NodeRegistryPrivateSession,
  runnerInventoryByConn: ReadonlyMap<string, NodeRunnerInventoryRecord>,
): NodeRunnerInventoryIssue | undefined {
  const declaration = runnerInventoryByConn.get(node.connId);
  return declaration &&
    node.client.invalidated !== true &&
    declaration.nodeId === node.nodeId &&
    declaration.pairingIdentity === node.pairingIdentity &&
    declaration.clientId === GATEWAY_CLIENT_IDS.NODE_HOST &&
    declaration.clientMode === "node" &&
    declaration.protocolFeatures.length === 1 &&
    (declaration.protocolFeatures[0] === NODE_WORKER_SUPERVISOR_LEGACY_PROTOCOL_FEATURE ||
      declaration.protocolFeatures[0] === NODE_WORKER_SUPERVISOR_BUILD_PROTOCOL_FEATURE)
    ? NODE_RUNNER_UPDATE_REQUIRED_ISSUE
    : undefined;
}

function isWorkerSupervisorProofCurrent(
  state: NodeRegistryPrivateState,
  proof: NodeWorkerSupervisorNodeProof,
  requireLaunchEligibility: boolean,
): boolean {
  const node = state.context.getNode(proof.nodeId);
  if (!node || node.client.invalidated === true || node.connId !== proof.connId) {
    return false;
  }
  const current = resolveWorkerSupervisorProof(node, state.runnerInventoryByConn);
  return (
    current?.pairingIdentity === proof.pairingIdentity &&
    current.pairingGeneration === proof.pairingGeneration &&
    current.clientId === proof.clientId &&
    current.clientMode === proof.clientMode &&
    current.protocolFeature === proof.protocolFeature &&
    (!requireLaunchEligibility || current.workerHost.capacity === "available")
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
    node.clientId !== GATEWAY_CLIENT_IDS.NODE_HOST ||
    node.clientMode !== "node"
  ) {
    return null;
  }
  const previous = state.runnerInventoryByConn.get(node.connId);
  if (!publishesRunnerDialect) {
    const changed = state.runnerInventoryByConn.delete(node.connId);
    if (changed) {
      state.context.publishActiveNodeContext();
      state.publishRunnerInventoryChanged(node.nodeId);
    }
    return { changed };
  }
  const workerHost = "workerHost" in params.declaration ? params.declaration.workerHost : undefined;
  const next: NodeRunnerInventoryRecord = {
    nodeId: node.nodeId,
    connId: node.connId,
    pairingIdentity: node.pairingIdentity,
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: "node",
    protocolFeatures: [...params.declaration.protocolFeatures],
    ...(workerHost ? { workerHost: { ...workerHost } } : {}),
  };
  const changed =
    !previous ||
    !sameWorkerProtocolFeatures(previous.protocolFeatures, next.protocolFeatures) ||
    !sameWorkerHostDeclaration(previous.workerHost, next.workerHost);
  if (changed) {
    state.runnerInventoryByConn.set(node.connId, next);
    state.context.publishActiveNodeContext();
    state.publishRunnerInventoryChanged(node.nodeId);
  }
  return { changed };
}

async function invokeNodeRegistryCore(
  state: NodeRegistryPrivateState,
  params: NodeInvokeParams,
  allowPrivateCommand: boolean,
): Promise<NodeInvokeResult> {
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
    const resolution = await state.context.resolvePairingLease(node);
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
  if (params.isDispatchAuthorized?.() === false) {
    return {
      ok: false,
      error: {
        code: "APPROVAL_AUTHORITY_CLOSED",
        message: "runtime authority closed before node dispatch",
      },
    };
  }
  const requestId = randomUUID();
  const invokeParams = normalizeSystemRunInvokeParams({
    command: params.command,
    params: params.params,
  });
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 30_000, 0);
  const payload = {
    id: requestId,
    nodeId: params.nodeId,
    command: params.command,
    paramsJSON:
      "params" in params && invokeParams !== undefined ? JSON.stringify(invokeParams) : null,
    timeoutMs,
    idempotencyKey: params.idempotencyKey,
    sessionKey: normalizeOptionalString(params.sessionKey),
  };
  const systemRunEvent = resolvePendingSystemRunEvent({
    command: params.command,
    params: invokeParams,
  });
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
  state.generationBoundInvokes = new WeakMap();
  state.publishRunnerInventoryChanged = () => {};
  state.invokeCore = async (params, allowPrivateCommand) =>
    await invokeNodeRegistryCore(state, params, allowPrivateCommand);
  state.updateRunnerInventory = (params) => updateWorkerRunnerInventory(state, params);
  state.workerSupervisorTransport = {
    listCurrentNodes: async () => {
      const current = await context.listCurrentConnected();
      return current.flatMap((node) => {
        const proof = resolveWorkerSupervisorProof(node, state.runnerInventoryByConn);
        return proof ? [proof] : [];
      });
    },
    getIssue: (nodeId) => {
      const node = context.getNode(nodeId);
      return node ? resolveNodeRunnerIssue(node, state.runnerInventoryByConn) : undefined;
    },
    isCurrent: (node, requireLaunchEligibility = false) =>
      isWorkerSupervisorProofCurrent(state, node, requireLaunchEligibility),
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
          params.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
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

export function setNodeRunnerInventoryChangedListener(
  nodeRegistry: object,
  listener: (nodeId: string) => void,
): void {
  const state = NODE_REGISTRY_PRIVATE_STATES.get(nodeRegistry);
  if (!state) {
    throw new Error("node registry private runtime was not initialized");
  }
  state.publishRunnerInventoryChanged = listener;
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
  state.publishRunnerInventoryChanged(declaration.nodeId);
}

export function isNodeRunnerSessionHost(params: {
  registry: object;
  nodeId: string;
  connId: string;
  pairingGeneration?: string;
}): boolean {
  const state = NODE_REGISTRY_PRIVATE_STATES.get(params.registry);
  const node = state?.context.getNode(params.nodeId);
  if (!state || !node || node.connId !== params.connId) {
    return false;
  }
  const proof = resolveWorkerSupervisorProof(node, state.runnerInventoryByConn);
  return Boolean(
    proof &&
    proof.pairingGeneration === params.pairingGeneration &&
    proof.workerHost.capacity === "available",
  );
}

function getNodeRunnerInventoryIssue(params: {
  registry: object;
  nodeId: string;
  connId: string;
}): NodeRunnerInventoryIssue | undefined {
  const state = NODE_REGISTRY_PRIVATE_STATES.get(params.registry);
  const node = state?.context.getNode(params.nodeId);
  return state && node?.connId === params.connId
    ? resolveNodeRunnerIssue(node, state.runnerInventoryByConn)
    : undefined;
}

/** Shared node/environments read-projection shape: nodeId -> runner issues. */
export function collectNodeRunnerIssuesByNodeId(
  registry: object,
  connectedNodes: ReadonlyArray<{ nodeId: string; connId: string }>,
): Map<string, NodeRunnerInventoryIssue[]> {
  return new Map(
    connectedNodes.flatMap((node) => {
      const issue = getNodeRunnerInventoryIssue({
        registry,
        nodeId: node.nodeId,
        connId: node.connId,
      });
      return issue ? [[node.nodeId, [issue]] as const] : [];
    }),
  );
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
