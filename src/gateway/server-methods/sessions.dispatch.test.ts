import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
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

import { sessionsHandlers } from "./sessions.js";

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
    turnClaim: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
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

async function invoke(context: GatewayRequestContext) {
  const respond = vi.fn() as unknown as RespondFn;
  await expectDefined(
    sessionsHandlers["sessions.dispatch"],
    'sessionsHandlers["sessions.dispatch"] test invariant',
  )({
    req: { id: "dispatch-request" } as never,
    params: { key: sessionKey, profileId: "test" },
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
    sessionsHandlers["sessions.reclaim"],
    'sessionsHandlers["sessions.reclaim"] test invariant',
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

  it("rejects dispatch from a nonlocal placement", async () => {
    mocks.resolveTarget.mockReturnValue(targetWithEntry({ sessionId }));
    const dispatch = vi.fn();
    const respond = await invoke(
      makeContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: {
          getMany: () => new Map([[sessionId, { state: "requested" } as never]]),
        },
      }),
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("placement requested"),
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

    expect(dispatch).toHaveBeenCalledWith({
      sessionId,
      sessionKey,
      agentId: "main",
      profileId: "test",
    });
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
    const dispatch = vi.fn().mockResolvedValue({
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
      turnClaim: null,
      createdAtMs: 1,
      updatedAtMs: 2,
      stateChangedAtMs: 2,
    });
    const respond = await invoke(
      makeContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
    );

    expect(dispatch).toHaveBeenCalledWith({
      sessionId,
      sessionKey,
      agentId: "main",
      profileId: "test",
    });
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
