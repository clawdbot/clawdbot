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
import { FORCED_WORKER_ABANDONMENT_ERROR } from "../worker-environments/placement-record.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import type { WorkerPlacementDispatchRequest } from "../worker-environments/service-contract.js";
import { readSessionsMutationVersion } from "./session-change-event.js";
import {
  dispatchTestSessionId as sessionId,
  dispatchTestSessionKey as sessionKey,
  getDispatchTestMocks,
  invokeSessionDispatch as invoke,
  invokeSessionMove,
  makeDispatchTestContext as makeContext,
  makeFailedPlacement as failedPlacementRecord,
  makeReclaimedPlacement as reclaimedPlacementRecord,
  makeSessionTarget as targetWithEntry,
} from "./sessions-dispatch.test-support.js";

const mocks = getDispatchTestMocks();
const originalPluginRegistry = getActivePluginRegistry();

function activePlacementRecord(): Extract<WorkerSessionPlacementRecord, { state: "active" }> {
  return {
    ...reclaimedPlacementRecord(),
    state: "active",
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
  };
}

describe("sessions.dispatch", () => {
  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry(), "sessions-dispatch-test", "default");
    const codexHarness: AgentHarness = {
      id: "codex",
      label: "Codex",
      autoSelection: { providerIds: ["codex", "openai"] },
      cloudPlacement: {
        mode: "remote-exec",
        devicePlacement: {
          requiredNodeCommands: ["codex.exec-server.stdio.v1"],
          consumesWorkerSlot: false,
        },
      },
      supports: () => ({ supported: true, priority: 10 }),
      async runAttempt() {
        throw new Error("not used");
      },
    };
    registerAgentHarness(codexHarness);
    vi.clearAllMocks();
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "",
    });
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

  it("prefers an explicit profile over the per-project default", async () => {
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
      path: "/repo/worktree",
    });
    const dispatch = vi.fn().mockRejectedValue(new Error("explicit dispatch reached"));

    await invoke(
      makeContext({
        getRuntimeConfig: () => ({
          cloudWorkers: {
            profiles: {
              mapped: { provider: "fake" },
              test: { provider: "fake" },
            },
            projectProfiles: { "github.com/acme/app": "mapped" },
          },
        }),
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
    );

    expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "test" }),
      expect.any(Function),
      undefined,
    );
  });

  it("uses the per-project default when profileId is absent", async () => {
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
      path: "/repo/worktree",
    });
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: "git@github.com:Acme/App.git\n",
      stderr: "",
    });
    const dispatch = vi.fn().mockRejectedValue(new Error("mapped dispatch reached"));

    await invoke(
      makeContext({
        getRuntimeConfig: () => ({
          cloudWorkers: {
            profiles: { mapped: { provider: "fake" } },
            projectProfiles: { "github.com/acme/app": "mapped" },
          },
        }),
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
      {},
    );

    expect(mocks.runCommandWithTimeout).toHaveBeenCalledWith(
      ["git", "-C", "/repo/worktree", "config", "--get", "remote.origin.url"],
      { timeoutMs: 4_000 },
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "mapped" }),
      expect.any(Function),
      undefined,
    );
  });

  it("rejects a per-project mapping to an unknown profile as invalid", async () => {
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
      path: "/repo/worktree",
    });
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: "https://github.com/acme/app.git\n",
      stderr: "",
    });
    const dispatch = vi.fn();

    const respond = await invoke(
      makeContext({
        getRuntimeConfig: () => ({
          cloudWorkers: {
            profiles: { test: { provider: "fake" } },
            projectProfiles: { "github.com/acme/app": "missing" },
          },
        }),
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
      {},
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message:
          "cloudWorkers.projectProfiles mapping github.com/acme/app references unconfigured profile missing",
      }),
    );
  });

  it.each([
    ["has no matching mapping", { code: 0, stdout: "https://github.com/acme/other.git\n" }],
    ["has no origin remote", { code: 1, stdout: "" }],
  ])("keeps explicit-profile behavior when the worktree %s", async (_label, gitResult) => {
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
      path: "/repo/worktree",
    });
    mocks.runCommandWithTimeout.mockResolvedValue({ ...gitResult, stderr: "" });
    const dispatch = vi.fn();

    const respond = await invoke(
      makeContext({
        getRuntimeConfig: () => ({
          cloudWorkers: {
            profiles: { test: { provider: "fake" } },
            projectProfiles: { "github.com/acme/app": "test" },
          },
        }),
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
      {},
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

  it.each([
    ["openclaw", "anthropic", "worker-turn"],
    ["codex", "openai", "remote-exec"],
  ] as const)(
    "rejects %s before allocation when its profile does not support the selected mode",
    async (runtime, provider, executionMode) => {
      mocks.resolveTarget.mockReturnValue(
        targetWithEntry({
          sessionId,
          agentRuntimeOverride: runtime,
          providerOverride: provider,
          modelOverride: "model-test",
          worktree: { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: "/repo" },
        }),
      );
      const dispatch = vi.fn();
      const respond = await invoke(
        makeContext({
          workerEnvironmentService: {
            supportsExecutionMode: (_profileId: string, mode: "worker-turn" | "remote-exec") =>
              mode !== executionMode,
          } as never,
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
          message: `runtime ${runtime} requires a cloud worker provider that supports ${executionMode}; choose a compatible provider, or select an agent/model route with agentRuntime.id "openclaw"`,
        }),
      );
    },
  );

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

  it("rejects sessions without a bound worktree or repository workspace", async () => {
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
        message: "sessions.dispatch requires a session-owned worktree or repository workspace",
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

  it("dispatches codex sessions through SSH without requiring node command allowlisting", async () => {
    mocks.resolveTarget.mockReturnValue(
      targetWithEntry({
        sessionId,
        agentRuntimeOverride: "codex",
        providerOverride: "openai",
        modelOverride: "gpt-test",
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
        workerEnvironmentService: {
          supportsExecutionMode: (_profileId: string, mode: "worker-turn" | "remote-exec") =>
            mode === "remote-exec",
        } as never,
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: "remote-exec",
        devicePlacement: {
          requiredNodeCommands: ["codex.exec-server.stdio.v1"],
          consumesWorkerSlot: false,
        },
      }),
      expect.any(Function),
      undefined,
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

  it("passes a per-dispatch machine class to placement", async () => {
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
    const dispatch = vi.fn().mockRejectedValue(new Error("machine dispatch reached"));
    await invoke(
      makeContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
      { profileId: "test", machineClass: "large" },
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "test", machineClass: "large" }),
      expect.any(Function),
      undefined,
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

  it("dispatches explicit permission modes through the worker capability gate", async () => {
    mocks.resolveTarget.mockReturnValue(
      targetWithEntry({
        sessionId,
        permissionMode: "workspace",
        sessionRoot: "/repo/worktree",
        worktree: { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: "/repo" },
      }),
    );
    mocks.findLiveByOwner.mockReturnValue({
      id: "worktree-1",
      ownerKind: "session",
      ownerId: sessionKey,
    });
    const dispatch = vi.fn().mockResolvedValue(activePlacementRecord());
    const respond = await invoke(
      makeContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
    );

    expect(dispatch).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        placement: expect.objectContaining({ state: "active" }),
      }),
      undefined,
    );
  });

  it.each(["active", "abandoned"] as const)(
    "moves an %s session back to the Gateway with exact-source CAS",
    async (sourceState) => {
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
      const move = vi.fn().mockResolvedValue({ state: "local", generation: 7 });
      const source = { generation: 4, environmentId: "environment-previous", ownerEpoch: 1 };
      const placement =
        sourceState === "active"
          ? activePlacementRecord()
          : {
              ...failedPlacementRecord(),
              recoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
            };

      const respond = await invokeSessionMove(
        makeContext({
          workerPlacementDispatchService: { dispatch: vi.fn(), move } as never,
          workerSessionPlacementService: {
            getMany: () => new Map([[sessionId, placement]]),
          },
        }),
        {
          expected: source,
          target: { kind: "gateway" },
          ...(sourceState === "abandoned" ? { abandonSource: true } : {}),
        },
      );

      expect(move).toHaveBeenCalledWith(
        {
          sessionId,
          sessionKey,
          agentId: "main",
          source,
          target: { kind: "gateway" },
          ...(sourceState === "abandoned" ? { abandonSource: true } : {}),
        },
        expect.any(Function),
        undefined,
      );
      expect(respond).toHaveBeenCalledWith(
        true,
        {
          ok: true,
          key: sessionKey,
          sessionId,
          placement: { state: "local", generation: 7 },
        },
        undefined,
      );
    },
  );

  it("resolves a worker move through the canonical destination owner", async () => {
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
    const move = vi.fn().mockResolvedValue({ state: "active", generation: 12 });

    await invokeSessionMove(
      makeContext({
        workerPlacementDispatchService: { dispatch: vi.fn(), move } as never,
        workerSessionPlacementService: {
          getMany: () => new Map([[sessionId, activePlacementRecord()]]),
        },
      }),
      {
        expected: { generation: 4, environmentId: "environment-previous", ownerEpoch: 1 },
        target: { kind: "profile", profileId: "test", machineClass: "beast" },
      },
    );

    expect(move).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "profile", profileId: "test", machineClass: "beast" },
      }),
      expect.any(Function),
      undefined,
    );
  });

  it.each([
    { state: "local", recoveryError: null, abandonSource: undefined },
    { state: "failed", recoveryError: "worker failed", abandonSource: true },
    { state: "failed", recoveryError: FORCED_WORKER_ABANDONMENT_ERROR, abandonSource: undefined },
  ] as const)(
    "rejects a $state move without an explicit forced-abandonment retry",
    async (source) => {
      mocks.resolveTarget.mockReturnValue(targetWithEntry({ sessionId }));
      const move = vi.fn();

      const respond = await invokeSessionMove(
        makeContext({
          workerPlacementDispatchService: { dispatch: vi.fn(), move } as never,
          workerSessionPlacementService: {
            getMany: () =>
              new Map([[sessionId, { ...failedPlacementRecord(), ...source } as never]]),
          },
        }),
        {
          expected: { generation: 4, environmentId: "environment-previous", ownerEpoch: 1 },
          target: { kind: "gateway" },
          ...(source.abandonSource ? { abandonSource: true } : {}),
        },
      );

      expect(move).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.INVALID_REQUEST,
          message: `session cannot move from placement ${source.state}`,
        }),
      );
    },
  );

  it.each([undefined, 2, 3])(
    "redispatches a reclaimed session with correlated identity (environment epoch: %s)",
    async (ownerEpoch) => {
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
        ...activePlacementRecord(),
        environmentId: "environment-2",
        generation: 5,
        activeOwnerEpoch: 2,
      };
      const dispatch = vi.fn().mockResolvedValue(dispatchedPlacement);
      const context = makeContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: {
          getMany: () => new Map([[sessionId, reclaimedPlacementRecord()]]),
        },
      });
      vi.spyOn(context.workerEnvironmentService!, "get").mockReturnValue(
        ownerEpoch === undefined
          ? undefined
          : {
              environmentId: "environment-2",
              providerId: "fake",
              profileId: "test",
              leaseId: "lease-2",
              sharedHost: false,
              state: "attached",
              ownerEpoch,
              createdAtMs: 1,
              idleSinceAtMs: null,
              attachedSessionIds: [sessionId],
              desktopAvailable: false,
              desktopApps: [],
              tunnelStatus: "stopped",
            },
      );
      const respond = await invoke(context);

      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          sessionKey,
          agentId: "main",
          profileId: "test",
        }),
        expect.any(Function),
        undefined,
      );
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          placement: expect.objectContaining({
            state: "active",
            environmentId: "environment-2",
            generation: 5,
            ...(ownerEpoch === 2 ? { providerId: "fake", profileId: "test" } : {}),
          }),
        }),
        undefined,
      );
      if (ownerEpoch !== 2) {
        const payload = vi.mocked(respond).mock.calls[0]?.[1];
        expect(payload).not.toHaveProperty("placement.providerId");
        expect(payload).not.toHaveProperty("placement.profileId");
      }
    },
  );

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
        workerEnvironmentService: {
          get: getEnvironment,
          supportsExecutionMode: () => true,
        } as never,
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

  it.each([
    [
      "fake",
      "failed",
      "cloud worker environment must be stopped before redispatch; use Stop cloud worker",
    ],
    [
      "device",
      "attached",
      "device worker placement must be abandoned before redispatch; use Continue on Gateway",
    ],
    [
      "unknown",
      "unavailable",
      "cloud worker environment must be stopped before redispatch; use Stop cloud worker",
    ],
  ])(
    "rejects failed-placement redispatch while its %s environment remains live",
    async (providerId, state, message) => {
      mocks.resolveTarget.mockReturnValue(targetWithEntry({ sessionId }));
      const dispatch = vi.fn();

      const respond = await invoke(
        makeContext({
          workerEnvironmentService: {
            get: vi.fn(() => {
              if (state === "unavailable") {
                throw new Error("environment inventory unavailable");
              }
              return { state, leaseId: "lease-previous", ownerEpoch: 1, providerId };
            }),
            supportsExecutionMode: () => true,
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
          message,
        }),
      );
    },
  );

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

  it("surfaces an execution-context feature mismatch as unavailable", async () => {
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
      .mockRejectedValue(
        new Error(
          "Worker environment is not dispatchable with the current execution-context contract: ready",
        ),
      );

    const respond = await invoke(
      makeContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
    );

    const error = vi.mocked(respond).mock.calls[0]?.[2];
    expect(error).toMatchObject({
      code: ErrorCodes.UNAVAILABLE,
      message: expect.stringContaining("current execution-context contract"),
    });
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
        devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
      }),
      expect.any(Function),
      undefined,
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
