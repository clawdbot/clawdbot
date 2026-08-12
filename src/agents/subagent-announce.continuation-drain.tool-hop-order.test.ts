// "RFC §" references herein cite docs/design/continue-work-signal-v2.md (Agent Self-Elected Turn Continuation / CONTINUE_WORK).
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentAnnounceDeliveryRuntimeMock } from "./subagents/announce/subagent-announce.test-support.js";
import type { SpawnSubagentResult } from "./subagents/spawn/subagent-spawn.js";

// Verify subagent-announce drains the child session's continue_delegate
// queue after the child settles, using the child's inherited chain state
// (not hardcoded 0) so hop labels and cost caps stay accurate for two-hop
// chains.
//
// RFC: docs/design/continue-work-signal-v2.md §3.2, §3.4

type AgentCallRequest = { method?: string; params?: Record<string, unknown> };

const agentSpy = vi.fn(async (_req: AgentCallRequest) => ({ runId: "run-main", status: "ok" }));
const callGatewayMock = vi.fn(async (_request: unknown) => ({}));
const loadSessionStoreMock = vi.fn((_storePath: string) => ({}) as Record<string, unknown>);
// controllable so a test can force the child chain-cost persist to fail
// and exercise the in-memory fallback fold. Default routes the entry patch
// through the same in-memory store the drain reads.
const updateSessionEntryInStore = async (
  scope: { sessionKey: string; storePath?: string },
  update: (entry: Record<string, unknown>) => Partial<Record<string, unknown>> | null,
  _options?: { requireWriteSuccess?: boolean },
) => {
  const store = loadSessionStoreMock(scope.storePath ?? "/tmp/sessions.json");
  const existing = store[scope.sessionKey];
  if (!existing || typeof existing !== "object") {
    return null;
  }
  const patch = update(existing as Record<string, unknown>);
  if (!patch) {
    return null;
  }
  Object.assign(existing, patch);
  return existing;
};
const updateSessionEntryMock = vi.fn(updateSessionEntryInStore);
const resolveAgentIdFromSessionKeyMock = vi.fn((sessionKey: string) => {
  return sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main";
});
const resolveStorePathMock = vi.fn((_store: unknown, _options: unknown) => "/tmp/sessions.json");
const resolveMainSessionKeyMock = vi.fn((_cfg: unknown) => "agent:main:main");
const isEmbeddedAgentRunActiveMock = vi.fn((_sessionId: string) => false);
const queueEmbeddedAgentMessageMock = vi.fn((_sessionId: string, _text: string) => false);
const waitForEmbeddedAgentRunEndMock = vi.fn(
  async (_sessionId: string, _timeoutMs?: number) => true,
);
const validTraceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

const dispatchToolDelegatesMock = vi.fn(
  async (
    _params: unknown,
  ): Promise<{
    dispatched: number;
    rejected: number;
    chainState?: {
      currentChainCount: number;
      chainStartedAt: number;
      accumulatedChainTokens: number;
    };
  }> => ({
    dispatched: 0,
    rejected: 0,
  }),
);

// In-function tool-delegate chain-hop coverage: feed consumePendingDelegates so
// runSubagentAnnounceFlow's own drain loop (sibling to drainChildContinuationQueue)
// runs, and capture the spawn it issues to assert model propagation.
type ConsumedToolDelegate = {
  task: string;
  model?: string;
  flowId?: string;
  expectedRevision?: number;
};
const consumePendingDelegatesMock = vi.fn((_sessionKey: string): ConsumedToolDelegate[] => []);
const markPendingDelegateFailedMock = vi.fn();
// capture durable delayed-bracket delegate enqueues (replaces the old
// volatile setTimeout path).
const enqueuePendingDelegateMock = vi.fn((_sessionKey: string, _delegate: unknown) => {});
const clearQueuedDelegatesChainTokensFoldMock = vi.fn((_sessionKey: string) => 0);
const stagePostCompactionDelegateMock = vi.fn((_sessionKey: string, _delegate: unknown) => {});
const spawnSubagentDirectMock = vi.fn(
  async (_params: Record<string, unknown>, _ctx: unknown): Promise<SpawnSubagentResult> => ({
    status: "accepted",
    childSessionKey: "agent:main:subagent:grandchild",
    runId: "run-grandchild",
  }),
);
const resolveContinuationRuntimeConfigMock = vi.fn((_cfg?: unknown) => ({
  enabled: true,
  defaultDelayMs: 15_000,
  minDelayMs: 5_000,
  maxDelayMs: 300_000,
  maxChainLength: 10,
  costCapTokens: 500_000,
  maxDelegatesPerTurn: 5,
  contextPressureThreshold: undefined,
}));

let mockConfig: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: { mainKey: "main", scope: "per-sender" },
};

const { continuationTargetingMock, subagentRegistryRuntimeMock, deliverSubagentAnnouncementMock } =
  vi.hoisted(() => ({
    continuationTargetingMock: {
      CONTINUATION_DELEGATE_FANOUT_MODES: ["tree", "all"] as const,
      enqueueContinuationReturnDeliveries: vi.fn(async (_params: unknown) => ({
        enqueued: 0,
        delivered: 0,
        deliveryIds: [],
      })),
      normalizeContinuationTargetKey: (value?: string) => {
        const trimmed = value?.trim();
        return trimmed || undefined;
      },
      normalizeContinuationTargetKeys: (values?: readonly string[]) => {
        const seen = new Set<string>();
        const keys: string[] = [];
        for (const value of values ?? []) {
          const trimmed = value.trim();
          if (!trimmed || seen.has(trimmed)) {
            continue;
          }
          seen.add(trimmed);
          keys.push(trimmed);
        }
        return keys;
      },
      hasContinuationDelegateTargeting: () => false,
      resolveContinuationReturnTargetSessionKeys: vi.fn((params: Record<string, unknown>) => {
        if (Array.isArray(params.targetSessionKeys)) {
          return params.targetSessionKeys;
        }
        if (typeof params.targetSessionKey === "string") {
          return [params.targetSessionKey];
        }
        if (Array.isArray(params.treeSessionKeys)) {
          return params.treeSessionKeys;
        }
        if (Array.isArray(params.allSessionKeys)) {
          return params.allSessionKeys;
        }
        return typeof params.defaultSessionKey === "string" ? [params.defaultSessionKey] : [];
      }),
    },
    subagentRegistryRuntimeMock: {
      shouldIgnorePostCompletionAnnounceForSession: vi.fn(() => false),
      isSubagentSessionRunActive: vi.fn(() => true),
      countActiveDescendantRuns: vi.fn(() => 0),
      countPendingDescendantRuns: vi.fn(() => 0),
      countPendingDescendantRunsExcludingRun: vi.fn(() => 0),
      listAncestorSessionKeys: vi.fn(() => []),
      listSubagentRunsForRequester: vi.fn(() => []),
      replaceSubagentRunAfterSteer: vi.fn(() => true),
      resolveRequesterForChildSession: vi.fn(() => null),
    },
    deliverSubagentAnnouncementMock: vi.fn(async () => ({ delivered: true, path: "direct" })),
  }));

vi.mock("./subagents/announce/subagent-announce.runtime.js", () => ({
  callGateway: (request: unknown) => callGatewayMock(request),
  dispatchGatewayMethodInProcess: vi.fn(),
  getRuntimeConfig: () => mockConfig,
  isEmbeddedAgentRunActive: (sessionId: string) => isEmbeddedAgentRunActiveMock(sessionId),
  loadConfig: () => mockConfig,
  loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
  readSessionMessagesAsync: vi.fn(async () => []),
  readSubagentSessionEntry: (storePath: string, sessionKey: string) => {
    const store = loadSessionStoreMock(storePath) as Record<string, unknown> | undefined;
    return store?.[sessionKey];
  },
  resolveContinuationRuntimeConfig: (cfg?: unknown) => resolveContinuationRuntimeConfigMock(cfg),
  queueEmbeddedAgentMessage: (sessionId: string, text: string) =>
    queueEmbeddedAgentMessageMock(sessionId, text),
  resolveAgentIdFromSessionKey: (sessionKey: string) =>
    resolveAgentIdFromSessionKeyMock(sessionKey),
  resolveMainSessionKey: (cfg: unknown) => resolveMainSessionKeyMock(cfg),
  resolveSessionStorePathCore: (store: unknown, options: unknown) =>
    resolveStorePathMock(store, options),
  waitForEmbeddedAgentRunEnd: (sessionId: string, timeoutMs?: number) =>
    waitForEmbeddedAgentRunEndMock(sessionId, timeoutMs),
}));

vi.mock("./subagents/announce/subagent-announce-delivery.runtime.js", () =>
  createSubagentAnnounceDeliveryRuntimeMock({
    callGateway: (request: unknown) => callGatewayMock(request),
    dispatchGatewayMethodInProcess: vi.fn(),
    getRuntimeConfig: () => mockConfig,
    loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
    resolveAgentIdFromSessionKey: (sessionKey: string) =>
      resolveAgentIdFromSessionKeyMock(sessionKey),
    resolveMainSessionKey: (cfg: unknown) => resolveMainSessionKeyMock(cfg),
    resolveSessionStorePathCore: (store: unknown, options: unknown) =>
      resolveStorePathMock(store, options),
    isEmbeddedAgentRunActive: (sessionId: string) => isEmbeddedAgentRunActiveMock(sessionId),
    queueEmbeddedAgentMessageWithOutcome: (sessionId: string, text: string) => {
      const queued = queueEmbeddedAgentMessageMock(sessionId, text);
      return queued
        ? {
            queued: true as const,
            sessionId,
            target: "reply_run" as const,
            gatewayHealth: "live" as const,
          }
        : {
            queued: false as const,
            sessionId,
            reason: "no_active_run" as const,
            gatewayHealth: "live" as const,
          };
    },
  }),
);

vi.mock("./subagents/announce/subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: deliverSubagentAnnouncementMock,
  loadRequesterSessionEntry: (sessionKey: string) => {
    const store = loadSessionStoreMock("/tmp/sessions.json");
    return { entry: store?.[sessionKey] };
  },
  loadSessionEntryByKey: (sessionKey: string) => {
    const store = loadSessionStoreMock("/tmp/sessions.json");
    return store?.[sessionKey];
  },
  resolveAnnounceOrigin: (
    _entry: unknown,
    requesterOrigin?: { channel?: string; to?: string; accountId?: string; threadId?: string },
  ) => requesterOrigin ?? {},
  resolveSubagentCompletionOrigin: async (params: { requesterOrigin?: unknown }) =>
    params.requesterOrigin,
  resolveSubagentAnnounceTimeoutMs: () => 10_000,
  runAnnounceDeliveryWithRetry: async <T>(params: { run: () => Promise<T> }) => await params.run(),
}));

vi.mock("./subagents/registry/subagent-registry-read.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...subagentRegistryRuntimeMock,
}));
vi.mock("./subagents/registry/subagent-registry-runtime.js", () => subagentRegistryRuntimeMock);

vi.mock("../auto-reply/continuation/delegate-dispatch.js", () => ({
  dispatchToolDelegates: (params: unknown) => dispatchToolDelegatesMock(params),
}));

// Feed the in-function tool-delegate drain (subagent-announce.ts) and capture
// its spawn. Keep untouched canonical store exports real so cleanup and due
// queries exercise the same owner as production.
vi.mock("../auto-reply/continuation/delegate-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auto-reply/continuation/delegate-store.js")>()),
  consumePendingDelegates: (sessionKey: string) => consumePendingDelegatesMock(sessionKey),
  markPendingDelegateFailed: (...args: unknown[]) => markPendingDelegateFailedMock(...args),
  revalidatePendingDelegateForSpawn: vi.fn(() => ({ allowed: true })),
  enqueuePendingDelegate: (sessionKey: string, delegate: unknown) =>
    enqueuePendingDelegateMock(sessionKey, delegate),
  clearQueuedDelegatesChainTokensFold: (sessionKey: string) =>
    clearQueuedDelegatesChainTokensFoldMock(sessionKey),
}));

vi.mock("../auto-reply/continuation/delegate-store-post-compaction.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../auto-reply/continuation/delegate-store-post-compaction.js")
  >()),
  stagePostCompactionDelegate: (sessionKey: string, delegate: unknown) =>
    stagePostCompactionDelegateMock(sessionKey, delegate),
}));

vi.mock("./subagents/spawn/subagent-spawn.js", () => ({
  spawnSubagentDirect: (params: Record<string, unknown>, ctx: unknown) =>
    spawnSubagentDirectMock(params, ctx),
}));

vi.mock("../auto-reply/continuation/config.js", () => ({
  resolveContinuationRuntimeConfig: (cfg?: unknown) => resolveContinuationRuntimeConfigMock(cfg),
}));

vi.mock("../auto-reply/continuation/targeting.js", () => continuationTargetingMock);

vi.mock("../config/sessions/targets.js", () => ({
  resolveAllAgentSessionStoreTargetsSync: () => [{ storePath: "/tmp/sessions.json" }],
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-accessor.js")>()),
  updateSessionEntry: (
    scope: { sessionKey: string; storePath?: string },
    update: (entry: Record<string, unknown>) => Partial<Record<string, unknown>> | null,
    options?: { requireWriteSuccess?: boolean },
  ) => updateSessionEntryMock(scope, update, options),
}));

import { runSubagentAnnounceFlow } from "./subagents/announce/subagent-announce.js";

const splitLintUse = [validTraceparent];
void splitLintUse;

describe("subagent-announce continuation drain (F7)", () => {
  beforeEach(() => {
    agentSpy.mockClear();
    callGatewayMock.mockReset().mockImplementation(async () => ({}));
    dispatchToolDelegatesMock.mockReset().mockResolvedValue({ dispatched: 0, rejected: 0 });
    resolveContinuationRuntimeConfigMock.mockReset().mockImplementation((_cfg?: unknown) => ({
      enabled: true,
      defaultDelayMs: 15_000,
      minDelayMs: 5_000,
      maxDelayMs: 300_000,
      maxChainLength: 10,
      costCapTokens: 500_000,
      maxDelegatesPerTurn: 5,
      contextPressureThreshold: undefined,
    }));
    loadSessionStoreMock.mockReset().mockImplementation(() => ({}));
    updateSessionEntryMock.mockReset().mockImplementation(updateSessionEntryInStore);
    resolveAgentIdFromSessionKeyMock.mockReset().mockImplementation(() => "main");
    resolveStorePathMock.mockReset().mockImplementation(() => "/tmp/sessions.json");
    resolveMainSessionKeyMock.mockReset().mockImplementation(() => "agent:main:main");
    isEmbeddedAgentRunActiveMock.mockReset().mockReturnValue(false);
    queueEmbeddedAgentMessageMock.mockReset().mockReturnValue(false);
    waitForEmbeddedAgentRunEndMock.mockReset().mockResolvedValue(true);
    mockConfig = {
      agents: { defaults: { continuation: { enabled: true } } },
      session: { mainKey: "main", scope: "per-sender" },
    };
    subagentRegistryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession
      .mockReset()
      .mockReturnValue(false);
    subagentRegistryRuntimeMock.isSubagentSessionRunActive.mockReset().mockReturnValue(true);
    subagentRegistryRuntimeMock.countPendingDescendantRuns.mockReset().mockReturnValue(0);
    subagentRegistryRuntimeMock.listAncestorSessionKeys.mockReset().mockReturnValue([]);
    subagentRegistryRuntimeMock.listSubagentRunsForRequester.mockReset().mockReturnValue([]);
    subagentRegistryRuntimeMock.resolveRequesterForChildSession.mockReset().mockReturnValue(null);
    continuationTargetingMock.enqueueContinuationReturnDeliveries.mockReset().mockResolvedValue({
      enqueued: 0,
      delivered: 0,
      deliveryIds: [],
    });
    continuationTargetingMock.resolveContinuationReturnTargetSessionKeys
      .mockReset()
      .mockImplementation((params: Record<string, unknown>) => {
        if (Array.isArray(params.targetSessionKeys)) {
          return params.targetSessionKeys;
        }
        if (typeof params.targetSessionKey === "string") {
          return [params.targetSessionKey];
        }
        if (Array.isArray(params.treeSessionKeys)) {
          return params.treeSessionKeys;
        }
        if (Array.isArray(params.allSessionKeys)) {
          return params.allSessionKeys;
        }
        return typeof params.defaultSessionKey === "string" ? [params.defaultSessionKey] : [];
      });
    deliverSubagentAnnouncementMock
      .mockReset()
      .mockResolvedValue({ delivered: true, path: "direct" });
    consumePendingDelegatesMock.mockReset().mockReturnValue([]);
    markPendingDelegateFailedMock.mockReset();
    enqueuePendingDelegateMock.mockReset();
    clearQueuedDelegatesChainTokensFoldMock.mockReset().mockReturnValue(0);
    stagePostCompactionDelegateMock.mockReset();
    spawnSubagentDirectMock.mockReset().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:grandchild",
      runId: "run-grandchild",
    });
  });

  it("spawns a delayed bracket delegate immediately (no durable enqueue) when the child chain-cost persist fails", async () => {
    const store: Record<string, Record<string, unknown>> = {
      "agent:main:subagent:bracket-fail": {
        sessionId: "session-child",
        updatedAt: Date.now(),
        continuationChainCount: 1,
        continuationChainStartedAt: 1_700_000_000_000,
        continuationChainTokens: 1_000,
        inputTokens: 10_000,
        outputTokens: 20_000,
      },
      "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
    };
    loadSessionStoreMock.mockImplementation(() => store as unknown as Record<string, unknown>);
    // The child chain-cost persist throws, so the run-cost fallback lives only in
    // memory for this drain and cannot survive a restart.
    updateSessionEntryMock.mockRejectedValue(new Error("session store write failed"));

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:bracket-fail",
      childRunId: "run-bracket-fail",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Delegated from sub-agent: keep working",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "Research result.\n[[CONTINUE_DELEGATE: keep working +30s]]",
    });

    // Fail closed: a durable delayed delegate would recover from the stale child
    // entry and under-enforce the cost cap, so the hop is spawned immediately via
    // the in-process path (correct live folded cost basis) and NOT enqueued
    // durably where restart recovery could re-drive it on stale cost.
    expect(enqueuePendingDelegateMock).not.toHaveBeenCalled();
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a bracket delegate when the parent chain-cost persist fails and the folded basis exceeds the cap", async () => {
    const store: Record<string, Record<string, unknown>> = {
      "agent:main:subagent:bracket-guard": {
        sessionId: "session-child",
        updatedAt: Date.now(),
        continuationChainCount: 1,
        continuationChainStartedAt: 1_700_000_000_000,
        continuationChainTokens: 1_000,
        inputTokens: 150_000,
        outputTokens: 100_000,
      },
      // Parent chain cost is UNDER the cap without the run fold, OVER with it.
      "agent:main:main": {
        sessionId: "session-main",
        updatedAt: Date.now(),
        continuationChainTokens: 300_000,
      },
    };
    loadSessionStoreMock.mockImplementation(() => store as unknown as Record<string, unknown>);
    // Parent-entry persist throws, so the guard's requester basis stays stale.
    updateSessionEntryMock.mockRejectedValue(new Error("session store write failed"));

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:bracket-guard",
      childRunId: "run-bracket-guard",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Delegated from sub-agent: keep working",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "Research result.\n[[CONTINUE_DELEGATE: keep working +30s]]",
    });

    // Parent persist failed → the guard folds the run cost: 300_000 + (150_000 +
    // 100_000) = 550_000 > costCapTokens (500_000) → rejected. The bracket must
    // NOT spawn (immediate) or enqueue (durable) on the stale pre-run basis.
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(enqueuePendingDelegateMock).not.toHaveBeenCalled();
    expect(updateSessionEntryMock.mock.calls[0]?.[2]).toMatchObject({
      requireWriteSuccess: true,
    });
  });

  it("treats a no-op parent token persist as failed and folds the run cost", async () => {
    const store: Record<string, Record<string, unknown>> = {
      "agent:main:subagent:bracket-parent-missing": {
        sessionId: "session-child",
        updatedAt: Date.now(),
        continuationChainCount: 1,
        continuationChainStartedAt: 1_700_000_000_000,
        continuationChainTokens: 1_000,
        inputTokens: 150_000,
        outputTokens: 100_000,
      },
      "agent:main:main": {
        sessionId: "session-main",
        updatedAt: Date.now(),
        continuationChainTokens: 300_000,
      },
    };
    loadSessionStoreMock.mockImplementation(() => store as unknown as Record<string, unknown>);
    // The requester entry is readable for budget checks, but the write mutator
    // touches no entry (legacy/normalized-key mismatch shape). It returns
    // normally, so production must detect "no row mutated" and fold the run cost.
    updateSessionEntryMock.mockResolvedValueOnce(null);

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:bracket-parent-missing",
      childRunId: "run-bracket-parent-missing",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Delegated from sub-agent: keep working",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "Research result.\n[[CONTINUE_DELEGATE: keep working +30s]]",
    });

    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(enqueuePendingDelegateMock).not.toHaveBeenCalled();
    expect(updateSessionEntryMock.mock.calls[0]?.[2]).toMatchObject({
      requireWriteSuccess: true,
    });
  });

  // The in-function tool-delegate chain-hop (sibling to the chainSignal hop that
  // already propagates model) must forward an explicit continue_delegate model
  // override to the grandchild spawn so a tool-delegated hop honors the requested
  // provider/model instead of silently inheriting the parent's.
  it("propagates a tool-delegate model override into the in-function chain-hop spawn", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:test": { sessionId: "session-child", updatedAt: Date.now() },
          "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
        }) as Record<string, unknown>,
    );
    consumePendingDelegatesMock.mockReturnValue([
      { task: "investigate the failing shard", model: "github-copilot/claude-sonnet-4.6" },
    ]);

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-chain-hop",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Tool-delegated from sub-agent (depth 1): prior hop",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    // The chain-hop spawn is fire-and-forget inside the drain loop; flush the
    // microtask/timer queue so the spawn lands before asserting.
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(consumePendingDelegatesMock).toHaveBeenCalledWith("agent:main:subagent:test");
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    const [spawnParams] = expectDefined(spawnSubagentDirectMock.mock.calls.at(0), "spawn call");
    expect(spawnParams.task).toEqual(
      expect.stringContaining("[continuation:chain-hop:2] Tool-delegated from sub-agent"),
    );
    expect(spawnParams.drainsContinuationDelegateQueue).toBe(true);
    expect(spawnParams.model).toBe("github-copilot/claude-sonnet-4.6");
  });

  it("omits model from the in-function chain-hop spawn when the tool delegate has none", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:test": { sessionId: "session-child", updatedAt: Date.now() },
          "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
        }) as Record<string, unknown>,
    );
    consumePendingDelegatesMock.mockReturnValue([{ task: "inherit the parent model" }]);

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-chain-hop",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Tool-delegated from sub-agent (depth 1): prior hop",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    const [spawnParams] = expectDefined(spawnSubagentDirectMock.mock.calls.at(0), "spawn call");
    expect(spawnParams.task).toEqual(
      expect.stringContaining("[continuation:chain-hop:2] Tool-delegated from sub-agent"),
    );
    // Backward-compat: omitted model => no key => grandchild inherits parent model.
    expect("model" in spawnParams).toBe(false);
  });

  it("orders mixed bracket and tool delegates on distinct hops", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:mixed": {
            sessionId: "session-child",
            updatedAt: Date.now(),
            continuationChainCount: 1,
            continuationChainStartedAt: 1_700_000_000_000,
            continuationChainTokens: 7_000,
          },
          "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
        }) as Record<string, unknown>,
    );
    consumePendingDelegatesMock.mockReturnValue([
      { task: "tool-row delegate", flowId: "flow-tool-mixed", expectedRevision: 2 },
    ]);

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:mixed",
      childRunId: "run-mixed",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Delegated from sub-agent: prior hop",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done\n[[CONTINUE_DELEGATE: bracket delegate]]",
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(2);
    const [bracketSpawnValue, toolSpawnValue] = spawnSubagentDirectMock.mock.calls.map(
      ([params]) => params,
    );
    const bracketSpawn = expectDefined(bracketSpawnValue, "bracket spawn");
    const toolSpawn = expectDefined(toolSpawnValue, "tool spawn");
    expect(bracketSpawn.task).toEqual(expect.stringContaining("[continuation:chain-hop:2]"));
    expect(bracketSpawn.continuationChainState).toMatchObject({ count: 2, tokens: 7_000 });
    expect(toolSpawn.task).toEqual(expect.stringContaining("[continuation:chain-hop:3]"));
    expect(toolSpawn.continuationChainState).toMatchObject({ count: 3, tokens: 7_000 });
    expect(toolSpawn.continuationDelegateFlowId).toBe("flow-tool-mixed");
  });

  it("counts a bracket delegate against max-chain before tool delegates drain", async () => {
    resolveContinuationRuntimeConfigMock.mockImplementation((_cfg?: unknown) => ({
      enabled: true,
      defaultDelayMs: 15_000,
      minDelayMs: 5_000,
      maxDelayMs: 300_000,
      maxChainLength: 2,
      costCapTokens: 500_000,
      maxDelegatesPerTurn: 5,
      contextPressureThreshold: undefined,
    }));
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:mixed-cap": {
            sessionId: "session-child",
            updatedAt: Date.now(),
            continuationChainCount: 1,
            continuationChainStartedAt: 1_700_000_000_000,
            continuationChainTokens: 7_000,
          },
          "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
        }) as Record<string, unknown>,
    );
    const toolDelegate = {
      task: "tool-row delegate past cap",
      flowId: "flow-tool-cap",
      expectedRevision: 2,
    };
    consumePendingDelegatesMock.mockReturnValue([toolDelegate]);

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:mixed-cap",
      childRunId: "run-mixed-cap",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Delegated from sub-agent: prior hop",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done\n[[CONTINUE_DELEGATE: bracket delegate]]",
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    expect(spawnSubagentDirectMock.mock.calls[0]?.[0].task).toEqual(
      expect.stringContaining("[continuation:chain-hop:2]"),
    );
    expect(markPendingDelegateFailedMock).toHaveBeenCalledWith(
      toolDelegate,
      "Tool delegate rejected: chain length 3 exceeds maxChainLength 2.",
      "Delegate rejected",
    );
  });
});
