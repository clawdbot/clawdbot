import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import { bindDeviceWorkerAvailability } from "../worker-environments/device-provider.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import type { GatewayRequestContext, RespondFn, SessionMutationAuthorization } from "./types.js";

const dispatchTestMocks = vi.hoisted(() => ({
  findLiveByOwner: vi.fn(),
  runCommandWithTimeout: vi.fn(),
  resolveTarget: vi.fn(),
}));

export function getDispatchTestMocks() {
  return dispatchTestMocks;
}

vi.mock("../../agents/worktrees/service.js", () => ({
  managedWorktrees: {
    findLiveByOwner: dispatchTestMocks.findLiveByOwner,
  },
}));

vi.mock("../../process/exec.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../process/exec.js")>("../../process/exec.js");
  return {
    ...actual,
    runCommandWithTimeout: dispatchTestMocks.runCommandWithTimeout,
  };
});

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    resolveGatewaySessionStoreTargetWithStore: dispatchTestMocks.resolveTarget,
  };
});

import { sessionDispatchHandlers } from "./sessions-dispatch.js";

export function getSessionDispatchHandler() {
  return expectDefined(
    sessionDispatchHandlers["sessions.dispatch"],
    'sessionDispatchHandlers["sessions.dispatch"] test invariant',
  );
}

export const dispatchTestSessionKey = "agent:main:cloud-test";
export const dispatchTestSessionId = "session-cloud-test";

export function makeReclaimedPlacement(): Extract<
  WorkerSessionPlacementRecord,
  { state: "reclaimed" }
> {
  return {
    sessionId: dispatchTestSessionId,
    agentId: "main",
    sessionKey: dispatchTestSessionKey,
    executionMode: "worker-turn",
    state: "reclaimed",
    environmentId: "environment-previous",
    generation: 4,
    activeOwnerEpoch: 1,
    workspaceBaseManifestRef: "manifest-previous",
    remoteWorkspaceDir: "/worker/session-cloud-test",
    workerBundleHash: "c".repeat(64),
    lastTranscriptAckCursor: 3,
    lastLiveEventAckCursor: 2,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
    turnClaim: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
  };
}

export function makeFailedPlacement(): Extract<WorkerSessionPlacementRecord, { state: "failed" }> {
  return {
    ...makeReclaimedPlacement(),
    state: "failed",
    recoveryError: "gateway restarted during worker dispatch",
    turnClaim: null,
  };
}

type DispatchSessionEntry = Pick<
  SessionEntry,
  | "sessionId"
  | "worktree"
  | "agentHarnessId"
  | "agentRuntimeOverride"
  | "archivedAt"
  | "modelSelectionLocked"
  | "providerOverride"
  | "modelOverride"
  | "permissionMode"
  | "sessionRoot"
>;

export function makeSessionTarget(entry?: DispatchSessionEntry) {
  // Pin an anthropic model by default: the effective-runtime fallback consults
  // the process-global harness registry, so the default openai model resolves
  // to "codex" whenever a sibling test in the shard registered that harness.
  const pinnedEntry = entry
    ? { providerOverride: "anthropic", modelOverride: "claude-test", ...entry }
    : undefined;
  return {
    agentId: "main",
    storePath: "/tmp/openclaw-agent.sqlite",
    canonicalKey: dispatchTestSessionKey,
    storeKeys: [dispatchTestSessionKey],
    store: pinnedEntry ? { [dispatchTestSessionKey]: pinnedEntry } : {},
  };
}

export function makeDispatchTestContext(
  overrides: Partial<GatewayRequestContext> = {},
): GatewayRequestContext {
  const workerEnvironmentService = overrides.workerEnvironmentService ?? {
    get: () => undefined,
    inventoryVersion: () => 0,
    supportsExecutionMode: () => true,
  };
  if (!overrides.workerEnvironmentService) {
    bindDeviceWorkerAvailability(workerEnvironmentService, async (deviceId) => {
      const observed = overrides.nodeRegistry?.get?.(deviceId);
      const node: NodeWorkerSupervisorNodeProof = {
        nodeId: deviceId,
        connId: observed?.connId ?? `conn-${deviceId}`,
        pairingIdentity: observed?.pairingIdentity ?? `identity-${deviceId}`,
        pairingGeneration: observed?.pairingGeneration ?? `generation-${deviceId}`,
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
        protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
        workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
        commands: observed?.commands ?? ["system.run", "codex.exec-server.stdio.v1"],
      };
      return { available: true, node };
    });
  }
  return {
    getSessionEventSubscriberConnIds: () => new Set(),
    getRuntimeConfig: () => ({
      cloudWorkers: {
        profiles: {
          test: { provider: "fake", region: "test", size: "small" },
        },
      },
    }),
    // Dispatch replies project runner state through the canonical fenced
    // reader; the default stub mirrors the placement's bound device as live.
    workerPlacementRunnerAvailabilityReader: {
      read: (placement: { state?: string; environmentId?: string | null }) => {
        if (placement.state !== "active" && placement.state !== "draining") {
          return undefined;
        }
        const environmentId =
          typeof placement.environmentId === "string" ? placement.environmentId : "";
        const service = workerEnvironmentService as {
          get?: (environmentId: string) => { nodeDeviceId?: string } | undefined;
        };
        const deviceId =
          service.get?.(environmentId)?.nodeDeviceId ??
          (environmentId.startsWith("device-environment-")
            ? environmentId.slice("device-environment-".length)
            : undefined);
        return {
          kind: "device",
          status: "available",
          ...(deviceId ? { deviceId } : {}),
        };
      },
    },
    ...overrides,
    workerEnvironmentService: workerEnvironmentService as never,
  } as unknown as GatewayRequestContext;
}

export async function invokeSessionDispatch(
  context: GatewayRequestContext,
  target: { profileId?: string; machineClass?: string; deviceId?: string; autoDevice?: true } = {
    profileId: "test",
  },
  sessionMutationAuthorization?: SessionMutationAuthorization,
) {
  const respond = vi.fn() as unknown as RespondFn;
  await getSessionDispatchHandler()({
    req: { id: "dispatch-request" } as never,
    params: { key: dispatchTestSessionKey, ...target },
    respond,
    context,
    client: null,
    isWebchatConnect: () => false,
    sessionMutationAuthorization,
  });
  return respond;
}

export async function invokeSessionMove(
  context: GatewayRequestContext,
  params: {
    expected: { generation: number; environmentId: string; ownerEpoch: number };
    abandonSource?: true;
    target:
      | { kind: "gateway" }
      | { kind: "profile"; profileId: string; machineClass?: string }
      | { kind: "device"; deviceId: string };
  },
  sessionMutationAuthorization?: SessionMutationAuthorization,
) {
  const respond = vi.fn() as unknown as RespondFn;
  await expectDefined(
    sessionDispatchHandlers["sessions.move"],
    'sessionDispatchHandlers["sessions.move"] test invariant',
  )({
    req: { id: "move-request" } as never,
    params: { key: dispatchTestSessionKey, ...params },
    respond,
    context,
    client: null,
    isWebchatConnect: () => false,
    sessionMutationAuthorization,
  });
  return respond;
}

export async function invokeSessionReclaim(
  context: GatewayRequestContext,
  sessionMutationAuthorization?: SessionMutationAuthorization,
) {
  const respond = vi.fn() as unknown as RespondFn;
  await expectDefined(
    sessionDispatchHandlers["sessions.reclaim"],
    'sessionDispatchHandlers["sessions.reclaim"] test invariant',
  )({
    req: { id: "reclaim-request" } as never,
    params: { key: dispatchTestSessionKey },
    respond,
    context,
    client: null,
    isWebchatConnect: () => false,
    sessionMutationAuthorization,
  });
  return respond;
}
