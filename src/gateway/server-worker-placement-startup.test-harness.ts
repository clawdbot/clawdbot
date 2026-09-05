import { vi } from "vitest";

const runtimeFactoryMocks = vi.hoisted(() => ({
  createDispatch: vi.fn(),
  createDiskSpace: vi.fn(),
  createSessionEvidenceResolver: vi.fn(),
  resolveSessionEvidence: vi.fn(),
}));
const moveDestinationMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  findManagedWorktree: vi.fn(() => ({
    id: "worktree-recovery",
    ownerId: "agent:main:move-source",
    path: "/gateway/workspace",
  })),
  resolveCanonicalSession: vi.fn(() => ({
    sessionId: "session-recovery",
    worktree: { id: "worktree-recovery" },
  })),
  resolveExecutionMode: vi.fn(() => "remote-exec"),
  resolveGatewaySessionTarget: vi.fn(() => ({
    agentId: "main",
    canonicalKey: "agent:main:move-source",
    store: {},
    storeKeys: ["agent:main:move-source"],
    storePath: "/tmp/openclaw-worker-placement-session.sqlite",
  })),
  resolveSessionRuntime: vi.fn(() => "codex"),
  resolveSessionTarget: vi.fn(
    (
      _params: Parameters<
        typeof import("./server-worker-placement-session-target.js").resolveWorkerPlacementSessionTarget
      >[0],
    ) => ({
      config: {},
      entry: {},
      target: { agentId: "main", canonicalKey: "agent:main:move-source" },
      worktree: { path: "/gateway/workspace" },
    }),
  ),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, getRuntimeConfig: moveDestinationMocks.getRuntimeConfig };
});

vi.mock("./server-worker-placement-session-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./server-worker-placement-session-target.js")>();
  return {
    ...actual,
    resolveWorkerPlacementSessionTarget: moveDestinationMocks.resolveSessionTarget,
  };
});

vi.mock("./worker-environments/placement-session-runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./worker-environments/placement-session-runtime.js")>();
  return {
    ...actual,
    resolveWorkerPlacementExecutionMode: moveDestinationMocks.resolveExecutionMode,
    resolveWorkerPlacementSessionRuntime: moveDestinationMocks.resolveSessionRuntime,
  };
});

vi.mock("./session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-utils.js")>();
  return {
    ...actual,
    resolveCanonicalSessionEntryFromStoreKeys: moveDestinationMocks.resolveCanonicalSession,
    resolveGatewaySessionStoreTargetWithStore: moveDestinationMocks.resolveGatewaySessionTarget,
  };
});

vi.mock("../agents/worktrees/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/worktrees/service.js")>();
  return {
    ...actual,
    managedWorktrees: {
      findLiveByOwner: moveDestinationMocks.findManagedWorktree,
    },
  };
});

vi.mock("./worker-environments/placement-dispatch.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./worker-environments/placement-dispatch.js")>();
  return {
    ...actual,
    createWorkerPlacementDispatchService: runtimeFactoryMocks.createDispatch,
  };
});

vi.mock("./server-worker-placement-session-evidence.js", () => ({
  createWorkerPlacementSessionEvidenceResolver: runtimeFactoryMocks.createSessionEvidenceResolver,
}));

vi.mock("./worker-environments/placement-disk-space.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./worker-environments/placement-disk-space.js")>();
  return {
    ...actual,
    createWorkerPlacementDiskSpaceMonitor: runtimeFactoryMocks.createDiskSpace,
  };
});

export function getWorkerPlacementStartupMocks() {
  return { runtimeFactoryMocks, moveDestinationMocks };
}
