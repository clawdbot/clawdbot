import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { bindDeviceWorkerAvailability } from "../worker-environments/device-provider.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import type {
  WorkerEnvironmentServiceContract,
  WorkerPlacementDispatchRequest,
} from "../worker-environments/service-contract.js";
import { readSessionsMutationVersion } from "./session-change-event.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({
  findLiveByOwner: vi.fn(),
  resolveTarget: vi.fn(),
}));

vi.mock("../../agents/worktrees/service.js", () => ({
  managedWorktrees: {
    findLiveByOwner: mocks.findLiveByOwner,
  },
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    resolveGatewaySessionStoreTargetWithStore: mocks.resolveTarget,
  };
});

import { sessionDispatchHandlers } from "./sessions-dispatch.js";

const sessionKey = "agent:main:cloud-test";
const sessionId = "session-cloud-test";

function reclaimedPlacementRecord(): WorkerSessionPlacementRecord {
  return {
    sessionId,
    agentId: "main",
    sessionKey,
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

function failedPlacementRecord(): WorkerSessionPlacementRecord {
  return {
    ...reclaimedPlacementRecord(),
    state: "failed",
    recoveryError: "gateway restarted during worker dispatch",
    turnClaim: null,
  };
}

function targetWithEntry(entry?: {
  sessionId: string;
  worktree?: { id: string; branch: string; repoRoot: string };
  agentHarnessId?: string;
  agentRuntimeOverride?: string;
  archivedAt?: number;
  modelSelectionLocked?: boolean;
  providerOverride?: string;
  modelOverride?: string;
}) {
  // Pin an anthropic model by default: the effective-runtime fallback consults
  // the process-global harness registry, so the default openai model resolves
  // to "codex" whenever a sibling test in the shard registered that harness.
  const pinnedEntry = entry
    ? { providerOverride: "anthropic", modelOverride: "claude-test", ...entry }
    : undefined;
  return {
    agentId: "main",
    storePath: "/tmp/openclaw-agent.sqlite",
    canonicalKey: sessionKey,
    storeKeys: [sessionKey],
    store: pinnedEntry ? { [sessionKey]: pinnedEntry } : {},
  };
}

function makeContext(overrides: Partial<GatewayRequestContext> = {}): GatewayRequestContext {
  return {
    getRuntimeConfig: () => ({
      cloudWorkers: {
        profiles: {
          test: { provider: "fake", region: "test", size: "small" },
        },
      },
    }),
    ...overrides,
  } as unknown as GatewayRequestContext;
}

async function invoke(
  context: GatewayRequestContext,
  target: { profileId: string } | { deviceId: string } = { profileId: "test" },
) {
  const respond = vi.fn() as unknown as RespondFn;
  await expectDefined(
    sessionDispatchHandlers["sessions.dispatch"],
    'sessionDispatchHandlers["sessions.dispatch"] test invariant',
  )({
    req: { id: "dispatch-request" } as never,
    params: { key: sessionKey, ...target },
    respond,
    context,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

async function invokeReclaim(context: GatewayRequestContext) {
  const respond = vi.fn() as unknown as RespondFn;
  await expectDefined(
    sessionDispatchHandlers["sessions.reclaim"],
    'sessionDispatchHandlers["sessions.reclaim"] test invariant',
  )({
    req: { id: "reclaim-request" } as never,
    params: { key: sessionKey },
    respond,
    context,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("sessions.dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTarget.mockReturnValue(targetWithEntry());
  });

  it("stays unavailable without a configured placement dispatcher", async () => {
    const respond = await invoke(makeContext());

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: ErrorCodes.INVALID_REQUEST }),
    );
  });

  it("synthesizes the core device-provider target for a connected session-capable node", async () => {
    mocks.resolveTarget.mockReturnValue(
      targetWithEntry({
        sessionId,
        worktree: { id: "worktree-1", branch: "openclaw/device-test", repoRoot: "/repo" },
      }),
    );
    mocks.findLiveByOwner.mockReturnValue({
      id: "worktree-1",
      ownerKind: "session",
      ownerId: sessionKey,
    });
    const dispatch = vi.fn().mockRejectedValue(
      Object.assign(new Error("device-runner-transport-unimplemented: launch is pending"), {
        code: "device-runner-transport-unimplemented",
      }),
    );
    const workerEnvironmentService = {} as WorkerEnvironmentServiceContract;
    bindDeviceWorkerAvailability(workerEnvironmentService, async () => true);
    const respond = await invoke(
      makeContext({
        workerEnvironmentService,
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
      { deviceId: "device-1" },
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "device:device-1",
        deviceId: "device-1",
        inheritedProfile: {
          providerId: "device",
          profileSnapshot: { install: "bundle", settings: { device: "device-1" } },
        },
      }),
      expect.any(Function),
    );
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
        message: expect.stringContaining("device-runner-transport-unimplemented"),
      }),
    );
  });

  it("rejects a device target without a connected session-capable pairing", async () => {
    const dispatch = vi.fn();
    const workerEnvironmentService = {} as WorkerEnvironmentServiceContract;
    bindDeviceWorkerAvailability(workerEnvironmentService, async () => false);
    const respond = await invoke(
      makeContext({
        workerEnvironmentService,
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
      { deviceId: "device-1" },
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
        message: expect.stringContaining("reconnect or reprovision"),
      }),
    );
  });

  it("rejects a missing session before dispatch", async () => {
    const dispatch = vi.fn();
    const respond = await invoke(
      makeContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: ErrorCodes.INVALID_REQUEST }),
    );
  });

  it("rejects sessions without their bound managed worktree", async () => {
    mocks.resolveTarget.mockReturnValue(targetWithEntry({ sessionId }));
    const dispatch = vi.fn();
    const respond = await invoke(
      makeContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("session-owned managed worktree"),
      }),
    );
  });

  it("delegates a provisioning placement so the dispatcher can join an identical retry", async () => {
    mocks.resolveTarget.mockReturnValue(
      targetWithEntry({
        sessionId,
        worktree: { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: "/repo" },
      }),
    );
    mocks.findLiveByOwner.mockReturnValue({
      id: "worktree-1",
      ownerKind: "session",
      ownerId: sessionKey,
    });
    const dispatch = vi.fn().mockRejectedValue(new Error("dispatch retry is not in flight"));
    const respond = await invoke(
      makeContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: {
          getMany: () => new Map([[sessionId, { state: "provisioning" } as never]]),
        },
      }),
    );

    expect(dispatch).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
        message: "dispatch retry is not in flight",
      }),
    );
  });

  it("rejects sessions owned by an unsupported runtime", async () => {
    mocks.resolveTarget.mockReturnValue(
      targetWithEntry({
        sessionId,
        agentRuntimeOverride: "codex",
        worktree: { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: "/repo" },
      }),
    );
    const dispatch = vi.fn();
    const respond = await invoke(
      makeContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("OpenClaw runtime"),
      }),
    );
  });

  it("rejects an archived session before dispatch", async () => {
    mocks.resolveTarget.mockReturnValue(
      targetWithEntry({
        sessionId,
        archivedAt: 2,
        worktree: { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: "/repo" },
      }),
    );
    const dispatch = vi.fn();
    const respond = await invoke(
      makeContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("archived"),
      }),
    );
  });

  it("allows an explicitly reclaimed session to dispatch again", async () => {
    mocks.resolveTarget.mockReturnValue(
      targetWithEntry({
        sessionId,
        worktree: { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: "/repo" },
      }),
    );
    mocks.findLiveByOwner.mockReturnValue({
      id: "worktree-1",
      ownerKind: "session",
      ownerId: sessionKey,
    });
    const dispatchedPlacement: WorkerSessionPlacementRecord = {
      sessionId,
      agentId: "main",
      sessionKey,
      state: "active",
      environmentId: "environment-2",
      generation: 5,
      activeOwnerEpoch: 2,
      workspaceBaseManifestRef: "manifest-2",
      remoteWorkspaceDir: "/worker/session-cloud-test",
      workerBundleHash: "d".repeat(64),
      lastTranscriptAckCursor: null,
      lastLiveEventAckCursor: null,
      recoveryError: null,
      terminalReason: null,
      terminalAtMs: null,
      turnClaim: null,
      createdAtMs: 1,
      updatedAtMs: 3,
      stateChangedAtMs: 3,
    };
    const dispatch = vi.fn().mockResolvedValue(dispatchedPlacement);
    const respond = await invoke(
      makeContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: {
          getMany: () => new Map([[sessionId, reclaimedPlacementRecord()]]),
        },
      }),
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        sessionKey,
        agentId: "main",
        profileId: "test",
      }),
      expect.any(Function),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        placement: expect.objectContaining({
          state: "active",
          environmentId: "environment-2",
          generation: 5,
        }),
      }),
      undefined,
    );
  });

  it("allows a failed placement to redispatch after its environment is proven gone", async () => {
    mocks.resolveTarget.mockReturnValue(
      targetWithEntry({
        sessionId,
        worktree: { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: "/repo" },
      }),
    );
    mocks.findLiveByOwner.mockReturnValue({
      id: "worktree-1",
      ownerKind: "session",
      ownerId: sessionKey,
    });
    const dispatch = vi.fn().mockResolvedValue({
      ...reclaimedPlacementRecord(),
      state: "active",
      environmentId: "environment-next",
      generation: 6,
      activeOwnerEpoch: 2,
      recoveryError: null,
    });
    const getEnvironment = vi.fn(() => undefined);

    const respond = await invoke(
      makeContext({
        workerEnvironmentService: { get: getEnvironment } as never,
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: {
          getMany: () => new Map([[sessionId, failedPlacementRecord()]]),
        },
      }),
    );

    expect(getEnvironment).toHaveBeenCalledWith("environment-previous");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ placement: expect.objectContaining({ state: "active" }) }),
      undefined,
    );
  });

  it("rejects failed-placement redispatch while its environment remains live", async () => {
    mocks.resolveTarget.mockReturnValue(targetWithEntry({ sessionId }));
    const dispatch = vi.fn();

    const respond = await invoke(
      makeContext({
        workerEnvironmentService: {
          get: vi.fn(() => ({ state: "failed", leaseId: "lease-previous" })),
        } as never,
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: {
          getMany: () => new Map([[sessionId, failedPlacementRecord()]]),
        },
      }),
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message:
          "cloud worker environment must be stopped before redispatch; use Stop cloud worker",
      }),
    );
  });

  it("rejects failed-placement redispatch when environment proof is unavailable", async () => {
    mocks.resolveTarget.mockReturnValue(targetWithEntry({ sessionId }));
    const dispatch = vi.fn();

    const respond = await invoke(
      makeContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: {
          getMany: () => new Map([[sessionId, failedPlacementRecord()]]),
        },
      }),
    );

    expect(failedPlacementRecord().environmentId).not.toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message:
          "cloud worker environment must be stopped before redispatch; use Stop cloud worker",
      }),
    );
  });

  it.each([
    ["CLI", "claude-cli"],
    ["plugin", "test-harness"],
  ])("rejects sessions assigned to a configured %s runtime", async (_kind, runtimeId) => {
    const modelRef = "anthropic/claude-test";
    mocks.resolveTarget.mockReturnValue(
      targetWithEntry({
        sessionId,
        providerOverride: "anthropic",
        modelOverride: "claude-test",
        worktree: { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: "/repo" },
      }),
    );
    const dispatch = vi.fn();
    const respond = await invoke(
      makeContext({
        getRuntimeConfig: () => ({
          cloudWorkers: {
            profiles: {
              test: { provider: "fake", region: "test", size: "small" },
            },
          },
          agents: {
            defaults: {
              models: {
                [modelRef]: { agentRuntime: { id: runtimeId } },
              },
            },
          },
        }),
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining(runtimeId),
      }),
    );
  });

  it("classifies workspace preflight rejection as an invalid request", async () => {
    mocks.resolveTarget.mockReturnValue(
      targetWithEntry({
        sessionId,
        worktree: { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: "/repo" },
      }),
    );
    mocks.findLiveByOwner.mockReturnValue({
      id: "worktree-1",
      ownerKind: "session",
      ownerId: sessionKey,
    });
    const dispatch = vi.fn().mockRejectedValue(
      Object.assign(new Error("Cloud workspace inventory exceeds its entry limit"), {
        code: "invalid_state",
      }),
    );

    const respond = await invoke(
      makeContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: "Cloud workspace inventory exceeds its entry limit",
      }),
    );
  });

  it("classifies workspace preflight operational failures as unavailable", async () => {
    mocks.resolveTarget.mockReturnValue(
      targetWithEntry({
        sessionId,
        worktree: { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: "/repo" },
      }),
    );
    mocks.findLiveByOwner.mockReturnValue({
      id: "worktree-1",
      ownerKind: "session",
      ownerId: sessionKey,
    });
    const dispatch = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("spawn failed"), { code: "ENOENT" }));

    const respond = await invoke(
      makeContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
    );

    const error = vi.mocked(respond).mock.calls[0]?.[2];
    expect(error).toMatchObject({ code: ErrorCodes.UNAVAILABLE, message: "spawn failed" });
  });

  it("dispatches an existing managed-worktree session and projects placement", async () => {
    mocks.resolveTarget.mockReturnValue(
      targetWithEntry({
        sessionId,
        worktree: { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: "/repo" },
      }),
    );
    mocks.findLiveByOwner.mockReturnValue({
      id: "worktree-1",
      ownerKind: "session",
      ownerId: sessionKey,
    });
    const dispatchedPlacement: WorkerSessionPlacementRecord = {
      sessionId,
      agentId: "main",
      sessionKey,
      state: "active",
      environmentId: "environment-1",
      generation: 5,
      activeOwnerEpoch: 2,
      workspaceBaseManifestRef: "manifest-1",
      remoteWorkspaceDir: "/worker/session-cloud-test",
      workerBundleHash: "b".repeat(64),
      lastTranscriptAckCursor: null,
      lastLiveEventAckCursor: null,
      recoveryError: null,
      terminalReason: null,
      terminalAtMs: null,
      turnClaim: null,
      createdAtMs: 1,
      updatedAtMs: 2,
      stateChangedAtMs: 2,
    };
    const dispatch = vi.fn(
      async (
        _request: WorkerPlacementDispatchRequest,
        onTransition?: (placement: WorkerSessionPlacementRecord) => void,
      ) => {
        for (const state of [
          "requested",
          "provisioning",
          "syncing",
          "starting",
          "active",
        ] as const) {
          onTransition?.({ ...dispatchedPlacement, state } as WorkerSessionPlacementRecord);
        }
        return dispatchedPlacement;
      },
    );
    const context = makeContext({
      getSessionEventSubscriberConnIds: () => new Set(),
      workerPlacementDispatchService: { dispatch },
      workerSessionPlacementService: { getMany: () => new Map() },
    });
    const priorMutationVersion = readSessionsMutationVersion(context);
    const respond = await invoke(context);

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        sessionKey,
        agentId: "main",
        profileId: "test",
      }),
      expect.any(Function),
    );
    expect(readSessionsMutationVersion(context)).toBe(priorMutationVersion + 5);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        key: sessionKey,
        sessionId,
        placement: expect.objectContaining({
          state: "active",
          environmentId: "environment-1",
          activeOwnerEpoch: 2,
        }),
      }),
      undefined,
    );
  });
});

describe("sessions.reclaim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTarget.mockReturnValue(
      targetWithEntry({
        sessionId,
        worktree: { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: "/repo" },
      }),
    );
    mocks.findLiveByOwner.mockReturnValue({
      id: "worktree-1",
      ownerKind: "session",
      ownerId: sessionKey,
    });
  });

  it("reconciles and reclaims an active placement", async () => {
    const reclaim = vi.fn().mockResolvedValue(reclaimedPlacementRecord());
    const respond = await invokeReclaim(
      makeContext({
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
        workerSessionPlacementService: {
          getMany: () =>
            new Map([
              [
                sessionId,
                {
                  ...reclaimedPlacementRecord(),
                  state: "active",
                  generation: 3,
                  recoveryError: null,
                } as WorkerSessionPlacementRecord,
              ],
            ]),
        },
      }),
    );

    expect(reclaim).toHaveBeenCalledWith({ sessionId, sessionKey, agentId: "main" });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        placement: expect.objectContaining({ state: "reclaimed" }),
      }),
      undefined,
    );
  });

  it("returns an already reclaimed placement as idempotent success", async () => {
    const reclaim = vi.fn();
    const respond = await invokeReclaim(
      makeContext({
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
        workerSessionPlacementService: {
          getMany: () => new Map([[sessionId, reclaimedPlacementRecord()]]),
        },
      }),
    );

    expect(reclaim).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        placement: expect.objectContaining({ state: "reclaimed" }),
      }),
      undefined,
    );
  });

  it("rejects a missing placement", async () => {
    const reclaim = vi.fn();
    const respond = await invokeReclaim(
      makeContext({
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
        workerSessionPlacementService: {
          getMany: () => new Map(),
        },
      }),
    );

    expect(reclaim).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: ErrorCodes.INVALID_REQUEST }),
    );
  });
});
