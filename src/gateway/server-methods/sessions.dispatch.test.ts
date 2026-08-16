import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import type { WorkerPlacementDispatchRequest } from "../worker-environments/service-contract.js";
import { readSessionsMutationVersion } from "./session-change-event.js";
import {
  dispatchTestSessionId as sessionId,
  dispatchTestSessionKey as sessionKey,
  getDispatchTestMocks,
  invokeSessionDispatch as invoke,
  makeDispatchTestContext as makeContext,
  makeFailedPlacement as failedPlacementRecord,
  makeReclaimedPlacement as reclaimedPlacementRecord,
  makeSessionTarget as targetWithEntry,
} from "./sessions-dispatch.test-support.js";

const mocks = getDispatchTestMocks();
const originalPluginRegistry = getActivePluginRegistry();

describe("sessions.dispatch", () => {
  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry(), "sessions-dispatch-test", "default");
    const codexHarness: AgentHarness & { cloudPlacement: { mode: "remote-exec" } } = {
      id: "codex",
      label: "Codex",
      cloudPlacement: { mode: "remote-exec" },
      supports: () => ({ supported: true, priority: 10 }),
      async runAttempt() {
        throw new Error("not used");
      },
    };
    registerAgentHarness(codexHarness);
    vi.clearAllMocks();
    mocks.resolveTarget.mockReturnValue(targetWithEntry());
  });

  afterEach(() => {
    if (originalPluginRegistry) {
      setActivePluginRegistry(originalPluginRegistry, "sessions-dispatch-test-restore", "default");
    } else {
      resetPluginRuntimeStateForTest();
    }
  });

  it("stays unavailable without a configured placement dispatcher", async () => {
    const respond = await invoke(makeContext());

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: ErrorCodes.INVALID_REQUEST }),
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

  it("rejects an unconfigured cloud worker profile before dispatch", async () => {
    const dispatch = vi.fn();
    const respond = await invoke(
      makeContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
      { profileId: "missing" },
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: "cloud worker profile is not configured: missing",
      }),
    );
  });

  it("treats a whitespace-only profile as an omitted dispatch target", async () => {
    mocks.resolveTarget.mockReturnValue(targetWithEntry({ sessionId }));
    const dispatch = vi.fn();
    const respond = await invoke(
      makeContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
      { profileId: " " },
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: "worker dispatch target is missing",
      }),
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

  it("dispatches codex sessions in remote-exec mode", async () => {
    mocks.resolveTarget.mockReturnValue(
      targetWithEntry({
        sessionId,
        agentRuntimeOverride: "codex",
        worktree: { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: "/repo" },
      }),
    );
    mocks.findLiveByOwner.mockReturnValue({
      id: "worktree-1",
      ownerKind: "session",
      ownerId: sessionKey,
    });
    const dispatch = vi.fn().mockRejectedValue(new Error("remote dispatch reached"));
    const respond = await invoke(
      makeContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ executionMode: "remote-exec" }),
      expect.any(Function),
    );
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
        message: "remote dispatch reached",
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
      executionMode: "worker-turn",
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

  it("requires permanent abandonment before redispatching retained workspace recovery", async () => {
    mocks.resolveTarget.mockReturnValue(targetWithEntry({ sessionId }));
    const dispatch = vi.fn();
    const placement = failedPlacementRecord();
    placement.terminalRecovery = {
      action: "force-destroy-environment",
      dataLoss: "unreconciled-workspace-result",
    };

    const respond = await invoke(
      makeContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: {
          getMany: () => new Map([[sessionId, placement]]),
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
          "cloud worker retains unreconciled workspace changes; use Stop cloud worker and confirm permanent abandonment before redispatch",
      }),
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
        agentRuntimeOverride: "openclaw",
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
      executionMode: "worker-turn",
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
        executionMode: "worker-turn",
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
