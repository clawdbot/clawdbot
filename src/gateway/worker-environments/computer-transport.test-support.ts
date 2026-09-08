import { Value } from "typebox/value";
import { vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { claimAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import type { ComputerUseCapabilityDescriptor } from "../../plugins/computer-use-contract.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { OpenClawPluginNodeInvokePolicyContext } from "../../plugins/types.js";
import {
  NodeWorkerComputerCloseParamsSchema,
  parseNodeWorkerComputerInput,
} from "../../worker/node-computer-protocol.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-identity-token.js";
import { createContext, createNodeSession } from "../node-invoke-plugin-policy.test-helpers.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import type { NodeRegistry, NodeSession } from "../node-registry.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { createWorkerComputerTransportOwner } from "./computer-transport.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import {
  isCurrentPlacementTurnClaim,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import type { WorkerEnvironmentRecord } from "./store.js";

export const COMPUTER_USE: ComputerUseCapabilityDescriptor = {
  contractVersion: 2,
  provider: { id: "fixture-computer", label: "Fixture computer", generation: "provider-1" },
  actions: ["screenshot", "type"],
  targets: ["screen"],
  deliveryModes: ["foreground"],
  observations: ["image"],
  features: { recording: false, agentCursor: false, multiDisplay: false },
};
export const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
export const NEXT_EXECUTION_ID = "00000000-0000-4000-8000-000000000002";

export function createHarness(sharedHost = false, withPolicy = true) {
  const claim: WorkerSessionTurnClaim = {
    sessionId: "session-1",
    claimId: "claim-1",
    runId: "run-1",
    placementGeneration: 3,
    owner: { kind: "worker", environmentId: "environment-1", ownerEpoch: 7 },
  };
  const placement: WorkerSessionPlacementRecord = {
    state: "active",
    executionMode: "worker-turn",
    sessionId: claim.sessionId,
    sessionKey: "agent:main:session-1",
    agentId: "main",
    generation: claim.placementGeneration,
    turnClaim: {
      owner: "worker",
      claimId: claim.claimId,
      runId: claim.runId,
      generation: claim.placementGeneration,
      ownerEpoch: 7,
    },
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    environmentId: "environment-1",
    activeOwnerEpoch: 7,
    workspaceBaseManifestRef: "sha256:fixture",
    remoteWorkspaceDir: "/worker/workspace",
    workerBundleHash: "a".repeat(64),
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
  };
  const environment: WorkerEnvironmentRecord = {
    environmentId: "environment-1",
    providerId: sharedHost ? "device" : "fixture-cloud",
    profileId: "desktop",
    profileSnapshot: { settings: {} },
    provisionOperationId: "provision-1",
    nodeSetupId: null,
    nodeDeviceId: "desktop-node",
    sharedHost,
    desktop: sharedHost ? null : { protocol: "rfb", port: 5900, passwordFilePath: "/vnc.password" },
    bootstrapReceipt: null,
    ownerEpoch: 7,
    teardownTerminalState: null,
    attachedSessionIds: [claim.sessionId],
    lastError: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    idleSinceAtMs: null,
    destroyRequestedAtMs: null,
    state: "attached",
    leaseId: "lease-1",
    sshEndpoint: null,
  };
  const node: NodeSession = {
    ...createNodeSession(),
    nodeId: "desktop-node",
    connId: "desktop-connection",
    pairingGeneration: "pairing-1",
    platform: "linux",
    deviceFamily: "Linux",
    commands: sharedHost ? ["screen.snapshot", "computer.act"] : [],
    computerUse: sharedHost ? COMPUTER_USE : undefined,
  };
  const proof: NodeWorkerSupervisorNodeProof = {
    nodeId: node.nodeId,
    connId: node.connId,
    pairingIdentity: "pairing-identity",
    pairingGeneration: "pairing-1",
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: "node",
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: { enabled: true, capacity: { total: 1, available: 0 } },
    commands: [],
  };
  const state: {
    placement: WorkerSessionPlacementRecord;
    environment: Extract<WorkerEnvironmentRecord, { leaseId: string }>;
    node: NodeSession;
    privateCurrent: boolean;
    context?: GatewayRequestContext;
    nodeTransport?: NodeWorkerSupervisorTransport;
    config: OpenClawConfig;
    beforePolicy?: () => Promise<void>;
    beforeDispatch?: () => Promise<void>;
    afterDispatch?: () => Promise<void>;
  } = {
    placement,
    environment,
    node,
    privateCurrent: true,
    config: {},
  };
  const { context } = createContext({
    nodeSession: node,
    getRuntimeConfig: () => state.config,
    validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator({
      validateTurnClaim: (candidate) => isCurrentPlacementTurnClaim(state.placement, candidate),
    }),
  });
  const nativeExecutionIds: string[] = [];
  const publicInvoke = vi.fn<NodeRegistry["invoke"]>(async (invocation) => {
    await state.beforeDispatch?.();
    if (invocation.isDispatchAuthorized?.() === false) {
      return { ok: false, error: { message: "dispatch authority closed" } };
    }
    const input = parseNodeWorkerComputerInput(
      JSON.stringify(
        Value.Check(NodeWorkerComputerCloseParamsSchema, invocation.params)
          ? {
              operation: "close",
              executionId: invocation.params.executionId,
              reason: invocation.params.reason,
            }
          : {
              operation: invocation.command === "screen.snapshot" ? "snapshot" : "act",
              providerGeneration: COMPUTER_USE.provider.generation,
              params: invocation.params,
            },
      ),
    );
    if (input.operation !== "capabilities") {
      nativeExecutionIds.push(
        input.operation === "close" ? input.executionId : input.params.executionId,
      );
    }
    invocation.onDispatchReady?.("public-invoke");
    return { ok: true, payload: { ok: true } };
  });
  context.nodeRegistry.invoke = publicInvoke;
  context.nodeRegistry.invokeLifecycle = publicInvoke;
  vi.spyOn(context.nodeRegistry, "get").mockImplementation((id) =>
    id === state.node.nodeId ? state.node : undefined,
  );
  vi.spyOn(context.nodeRegistry, "getForPairingGeneration").mockImplementation((id, generation) =>
    id === state.node.nodeId && generation === state.node.pairingGeneration
      ? state.node
      : undefined,
  );
  state.context = context;
  const privateInvoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (invocation) => {
    await state.beforeDispatch?.();
    if (!invocation.isDispatchAuthorized()) {
      return { ok: false, error: { message: "dispatch authority closed" } };
    }
    invocation.onDispatchReady?.("private-invoke");
    const input = parseNodeWorkerComputerInput(JSON.stringify(invocation.params));
    if (input.operation === "capabilities") {
      return { ok: true, payload: COMPUTER_USE };
    }
    nativeExecutionIds.push(
      input.operation === "close" ? input.executionId : input.params.executionId,
    );
    await state.afterDispatch?.();
    return { ok: true, payload: { ok: true } };
  });
  const nodeTransport = {
    listCurrentNodes: vi.fn(async () => [proof]),
    hasCurrentRunner: (id) => id === proof.nodeId && state.privateCurrent,
    isCurrent: (candidate) => candidate === proof && state.privateCurrent,
    invoke: privateInvoke,
  } satisfies NodeWorkerSupervisorTransport;
  state.nodeTransport = nodeTransport;
  const policyHandle = vi.fn(async (policy: OpenClawPluginNodeInvokePolicyContext) => {
    await state.beforePolicy?.();
    return await policy.invokeNode();
  });
  const classifyRisk = vi.fn(() => ({ level: "ordinary" as const, family: "fixture_input" }));
  const registry = createEmptyPluginRegistry();
  if (withPolicy) {
    registry.plugins.push(
      createPluginRecord({
        id: "fixture-computer",
        source: "test",
        origin: "bundled",
        enabled: true,
        configSchema: true,
      }),
    );
    registry.nodeHostCommands.push({
      pluginId: "fixture-computer",
      source: "test",
      command: { command: "computer.act", dangerous: true, handle: async () => "{}" },
    });
    registry.nodeInvokePolicies.push({
      pluginId: "fixture-computer",
      source: "test",
      pluginConfig: {},
      policy: { commands: ["computer.act"], dangerous: true, classifyRisk, handle: policyHandle },
    });
  }
  setActivePluginRegistry(registry);
  const closedHandlers = new Set<(closed: WorkerSessionTurnClaim) => void>();
  const options = {
    store: { get: () => state.environment },
    placements: {
      get: () => state.placement,
      validateTurnClaim: (candidate: WorkerSessionTurnClaim) =>
        isCurrentPlacementTurnClaim(state.placement, candidate),
      registerTurnClaimClosedHandler(handler: (closed: WorkerSessionTurnClaim) => void) {
        closedHandlers.add(handler);
        return () => {
          closedHandlers.delete(handler);
        };
      },
    },
    resolveGatewayContext: () => state.context,
    getNodeTransport: () => state.nodeTransport,
    warn: vi.fn(),
  };
  const run = createOperationalRunInstanceRef(claim.runId);
  const authority = claimAgentRunDelegatedAuthority(run);
  return {
    claim,
    options,
    state,
    run,
    authority,
    privateInvoke,
    publicInvoke,
    nodeTransport,
    policyHandle,
    classifyRisk,
    registry,
    nativeExecutionIds,
    releaseClaim() {
      state.placement = { ...state.placement, turnClaim: null };
      for (const handler of closedHandlers) {
        handler(claim);
      }
    },
    async prepare() {
      const prepared = await createWorkerComputerTransportOwner(options)(claim);
      if (!prepared) {
        throw new Error("Expected a prepared session desktop");
      }
      return { prepared, transport: prepared.bind(run) };
    },
  };
}

export type Harness = ReturnType<typeof createHarness>;

export function connectionIdentity(h: Harness): WorkerConnectionIdentity {
  return {
    environmentId: h.state.environment.environmentId,
    credentialHash: "credential-hash",
    bundleHash: "bundle-hash",
    sessionId: h.claim.sessionId,
    runId: h.claim.runId,
    turnClaim: h.claim,
    ownerEpoch: h.state.environment.ownerEpoch,
    rpcSetVersion: 1,
    protocolFeatures: [],
    credentialExpiresAtMs: Number.MAX_SAFE_INTEGER,
  };
}
