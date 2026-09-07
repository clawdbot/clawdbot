import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { loadProviderScopedThinkingCatalog } from "../agents/model-catalog.runtime.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";

vi.mock("../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
}));

const effects = vi.hoisted(() => ({
  enqueueSystemEvent: vi.fn(),
  info: vi.fn(),
  mutateConfigFileWithRetry: vi.fn(),
  refreshQueuedFollowupSession: vi.fn(),
  triggerSessionPatchHook: vi.fn(),
  warn: vi.fn(),
}));
const placementMocks = vi.hoisted(() => ({
  getMany: vi.fn(),
  resolveWorkerPlacementSessionRuntimeCapabilities: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let lifecycleEvents: SessionLifecycleEvent[];
let unsubscribeLifecycle: () => void;

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => effects.enqueueSystemEvent(...args),
}));
vi.mock("../auto-reply/reply/queue.js", () => ({
  refreshQueuedFollowupSession: (...args: unknown[]) =>
    effects.refreshQueuedFollowupSession(...args),
}));
vi.mock("../gateway/session-patch-hooks.js", () => ({
  triggerSessionPatchHook: (...args: unknown[]) => effects.triggerSessionPatchHook(...args),
}));
vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return { ...actual, mutateConfigFileWithRetry: effects.mutateConfigFileWithRetry };
});

vi.mock("../logging/subsystem.js", async () => {
  const actual =
    await vi.importActual<typeof import("../logging/subsystem.js")>("../logging/subsystem.js");
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) =>
      subsystem === "agents/sticky-model-selection"
        ? { info: effects.info, warn: effects.warn }
        : actual.createSubsystemLogger(subsystem),
  };
});

vi.mock("../gateway/session-worker-placement-context.js", () => ({
  resolveSessionWorkerPlacementContext: () => ({
    workerSessionPlacementService: {
      getMany: placementMocks.getMany,
    },
  }),
}));
vi.mock("../gateway/worker-environments/placement-session-runtime.js", () => ({
  resolveWorkerPlacementSessionRuntimeCapabilities:
    placementMocks.resolveWorkerPlacementSessionRuntimeCapabilities,
}));

import {
  applySessionModelSelection,
  type ApplySessionModelSelectionParams,
} from "./apply-session-model-selection.js";

const catalog = [
  {
    provider: "anthropic",
    id: "claude-opus-4-6",
    name: "Claude Opus",
    contextTokens: 32_000,
  },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o", contextTokens: 16_000 },
] satisfies ModelCatalogEntry[];

function createEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 1,
    delivery: { kind: "none" },
    ...overrides,
  };
}

function createParams(overrides: Partial<ApplySessionModelSelectionParams> = {}) {
  const sessionEntry = overrides.sessionEntry ?? createEntry();
  const sessionKey = overrides.sessionKey ?? "agent:main:dm:1";
  return {
    cfg: {},
    agentId: "main",
    sessionKey,
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    currentProvider: "anthropic",
    currentModel: "claude-opus-4-6",
    modelCatalog: catalog,
    thinkingCatalog: catalog,
    canPersistStickyModelSelection: false,
    request: {
      provider: "openai",
      model: "gpt-4o",
      isDefault: false,
      runtime: { kind: "unchanged" },
    },
    markLiveSwitchPending: true,
    ...overrides,
  } satisfies ApplySessionModelSelectionParams;
}

beforeEach(() => {
  vi.mocked(loadProviderScopedThinkingCatalog).mockReset().mockResolvedValue([]);
  lifecycleEvents = [];
  unsubscribeLifecycle = onSessionLifecycleEvent((event) => lifecycleEvents.push(event));
  effects.enqueueSystemEvent.mockReset();
  effects.info.mockReset();
  effects.warn.mockReset();
  effects.mutateConfigFileWithRetry.mockReset().mockResolvedValue({
    nextConfig: {},
    result: "defaults",
  });
  effects.refreshQueuedFollowupSession.mockReset();
  effects.triggerSessionPatchHook.mockReset();
  placementMocks.getMany.mockReset().mockReturnValue(new Map());
  placementMocks.resolveWorkerPlacementSessionRuntimeCapabilities.mockReset();
});

afterEach(() => unsubscribeLifecycle());

describe("applySessionModelSelection — placement guard", () => {
  it("rejects a model selection incompatible with an active cloud placement without persisting", async () => {
    const sessionEntry = createEntry({ sessionId: "placement-active-1" });
    const initial = structuredClone(sessionEntry);
    const placement = {
      sessionId: "placement-active-1",
      state: "active" as const,
      executionMode: "worker-turn" as const,
      generation: 1,
      environmentId: "env-1",
      runnerId: "runner-1",
      runnerStatus: "available" as const,
      recoveryError: null,
      terminalReason: null,
      terminalAtMs: null,
      transitionGeneration: 1,
      ownerId: "worker",
      ownerEpoch: 1,
      turnClaim: null,
      workspace: null,
      retirement: null,
      createdAtMs: 0,
      updatedAtMs: 0,
    };
    placementMocks.getMany.mockReturnValue(new Map([["placement-active-1", placement]]));
    placementMocks.resolveWorkerPlacementSessionRuntimeCapabilities.mockReturnValue({
      executionMode: undefined,
    });

    const result = await applySessionModelSelection(createParams({ sessionEntry }));

    expect(result).toEqual({
      status: "rejected",
      reason: "invalid-runtime",
      message:
        "Session cannot select a runtime without cloud placement support while cloud worker placement is active.",
    });
    expect(sessionEntry).toEqual(initial);
    expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(effects.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("allows a model selection compatible with an active cloud placement", async () => {
    const sessionEntry = createEntry({ sessionId: "placement-active-2" });
    const placement = {
      sessionId: "placement-active-2",
      state: "active" as const,
      executionMode: "worker-turn" as const,
      generation: 1,
      environmentId: "env-1",
      runnerId: "runner-1",
      runnerStatus: "available" as const,
      recoveryError: null,
      terminalReason: null,
      terminalAtMs: null,
      transitionGeneration: 1,
      ownerId: "worker",
      ownerEpoch: 1,
      turnClaim: null,
      workspace: null,
      retirement: null,
      createdAtMs: 0,
      updatedAtMs: 0,
    };
    placementMocks.getMany.mockReturnValue(new Map([["placement-active-2", placement]]));
    placementMocks.resolveWorkerPlacementSessionRuntimeCapabilities.mockReturnValue({
      executionMode: "worker-turn",
    });

    const result = await applySessionModelSelection(createParams({ sessionEntry }));

    expect(result.status).toBe("applied");
  });

  it("skips placement validation when no active placement exists", async () => {
    const sessionEntry = createEntry({ sessionId: "placement-none" });
    placementMocks.getMany.mockReturnValue(new Map());

    const result = await applySessionModelSelection(createParams({ sessionEntry }));

    expect(result.status).toBe("applied");
    expect(placementMocks.resolveWorkerPlacementSessionRuntimeCapabilities).not.toHaveBeenCalled();
  });

  it("rejects a model selection when placement activates between the pre-write read and the durable commit", async () => {
    const tempRoot = tempDirs.make("openclaw-model-picker-placement-race-");
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionKey = "agent:main:dm:placement-race";
    const sessionEntry = createEntry({ sessionId: "placement-race-1" });
    await replaceSessionEntry({ sessionKey, storePath }, sessionEntry);
    const initial = structuredClone(sessionEntry);
    const localPlacement = {
      sessionId: "placement-race-1",
      state: "local" as const,
      executionMode: "worker-turn" as const,
      generation: 1,
      environmentId: "env-1",
      runnerId: "runner-1",
      runnerStatus: "available" as const,
      recoveryError: null,
      terminalReason: null,
      terminalAtMs: null,
      transitionGeneration: 1,
      ownerId: "worker",
      ownerEpoch: 1,
      turnClaim: null,
      workspace: null,
      retirement: null,
      createdAtMs: 0,
      updatedAtMs: 0,
    };
    const activePlacement = { ...localPlacement, state: "active" as const, generation: 2 };
    // First read (pre-write guard) sees a local placement; the synchronous commit boundary
    // then sees an activation that overtook the directive's first read.
    placementMocks.getMany
      .mockReturnValueOnce(new Map([["placement-race-1", localPlacement]]))
      .mockReturnValueOnce(new Map([["placement-race-1", activePlacement]]));
    placementMocks.resolveWorkerPlacementSessionRuntimeCapabilities.mockReturnValue({
      executionMode: undefined,
    });

    const result = await applySessionModelSelection(
      createParams({ sessionEntry, sessionKey, storePath }),
    );

    expect(result).toMatchObject({
      status: "rejected",
      message:
        "Session cannot select a runtime without cloud placement support while cloud worker placement is active.",
    });
    // The durable write was fenced: the stored entry is unchanged.
    const stored = loadSessionEntryReadOnly({ sessionKey, storePath });
    expect(stored).toEqual(initial);
    expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(effects.enqueueSystemEvent).not.toHaveBeenCalled();
  });
});
