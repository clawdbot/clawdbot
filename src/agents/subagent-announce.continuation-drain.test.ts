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
type DelegateSpawnFenceResult =
  | { allowed: true }
  | { allowed: false; reason: "cancelled" | "stale"; summary: string };
const consumePendingDelegatesMock = vi.fn((_sessionKey: string): ConsumedToolDelegate[] => []);
const markPendingDelegateFailedMock = vi.fn();
const markPendingDelegateSpawnAcceptedMock = vi.fn(
  (_delegate: ConsumedToolDelegate, _childSessionKey: string) => true,
);
const revalidatePendingDelegateForSpawnMock = vi.fn(
  (_delegate: ConsumedToolDelegate, _controller: "pending"): DelegateSpawnFenceResult => ({
    allowed: true,
  }),
);
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
  markPendingDelegateSpawnAccepted: (delegate: ConsumedToolDelegate, childSessionKey: string) =>
    markPendingDelegateSpawnAcceptedMock(delegate, childSessionKey),
  revalidatePendingDelegateForSpawn: (delegate: ConsumedToolDelegate, controller: "pending") =>
    revalidatePendingDelegateForSpawnMock(delegate, controller),
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

const splitLintUse = [expectDefined, validTraceparent];
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
    markPendingDelegateSpawnAcceptedMock.mockReset().mockReturnValue(true);
    revalidatePendingDelegateForSpawnMock.mockReset().mockReturnValue({ allowed: true });
    enqueuePendingDelegateMock.mockReset();
    clearQueuedDelegatesChainTokensFoldMock.mockReset().mockReturnValue(0);
    stagePostCompactionDelegateMock.mockReset();
    spawnSubagentDirectMock.mockReset().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:grandchild",
      runId: "run-grandchild",
    });
  });

  it("drains the child session's continue_delegate queue using inherited chain state", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:test": {
            sessionId: "session-child",
            updatedAt: Date.now(),
            continuationChainCount: 1,
            continuationChainStartedAt: 1_700_000_000_000,
            continuationChainTokens: 5_000,
          },
          "agent:main:main": {
            sessionId: "session-main",
            updatedAt: Date.now(),
          },
        }) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-chain-hop",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "chain hop task",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    expect(dispatchToolDelegatesMock).toHaveBeenCalledTimes(1);
    const call = dispatchToolDelegatesMock.mock.calls[0]?.[0] as {
      sessionKey?: string;
      chainState?: {
        currentChainCount?: number;
        chainStartedAt?: number;
        accumulatedChainTokens?: number;
      };
      ctx?: { sessionKey?: string };
      maxChainLength?: number;
    };

    // Dispatch targets the CHILD session's queue so delegates the subagent
    // enqueued via continue_delegate during its turn are consumed.
    expect(call?.sessionKey).toBe("agent:main:subagent:test");
    expect(call?.ctx?.sessionKey).toBe("agent:main:subagent:test");

    // Chain state must be inherited from the child session entry — NOT
    // hardcoded zero. Hop labels depend on this to stay sequential.
    expect(call?.chainState?.currentChainCount).toBe(1);
    expect(call?.chainState?.chainStartedAt).toBe(1_700_000_000_000);
    expect(call?.chainState?.accumulatedChainTokens).toBe(5_000);
    expect(call?.maxChainLength).toBe(10);
  });

  it("threads a silent/wake parent's inherited policy into the early child drain", async () => {
    // This early drain runs BEFORE the later parentWasSilent
    // chain-hop guards. It must pass the parent's silent/wake policy so a
    // default-mode delegate the child queued stays internal instead of announcing.
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:test": { sessionId: "session-child", updatedAt: Date.now() },
          "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
        }) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-silent-parent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "silent chain hop",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
      silentAnnounce: true,
      wakeOnReturn: true,
    });

    expect(dispatchToolDelegatesMock).toHaveBeenCalledTimes(1);
    const call = dispatchToolDelegatesMock.mock.calls[0]?.[0] as {
      inheritedSilent?: boolean;
      inheritedWake?: boolean;
    };
    expect(call?.inheritedSilent).toBe(true);
    expect(call?.inheritedWake).toBe(true);
  });

  it("fences a tool delegate cancelled after the announce drain claimed it", async () => {
    const delegate = {
      task: "must not spawn after cancellation",
      flowId: "flow-cancelled-after-drain",
      expectedRevision: 4,
    };
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:test": { sessionId: "session-child", updatedAt: Date.now() },
          "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
        }) as Record<string, unknown>,
    );
    consumePendingDelegatesMock.mockReturnValueOnce([delegate]);
    revalidatePendingDelegateForSpawnMock.mockReturnValueOnce({
      allowed: false,
      reason: "cancelled",
      summary: "Continuation delegate cancelled before spawn.",
    });

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-cancelled-after-drain",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] prior delegate",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    expect(revalidatePendingDelegateForSpawnMock).toHaveBeenCalledWith(delegate, "pending");
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(markPendingDelegateFailedMock).not.toHaveBeenCalled();
  });

  it("threads delegate admission authority through an accepted announce drain", async () => {
    const delegate = {
      task: "spawn from announce drain",
      flowId: "flow-announce-drain",
      expectedRevision: 3,
    };
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:test": {
            sessionId: "session-child",
            lifecycleRevision: "child-lifecycle",
            updatedAt: Date.now(),
          },
          "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
        }) as Record<string, unknown>,
    );
    consumePendingDelegatesMock.mockReturnValueOnce([delegate]);

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-announce-drain",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] prior delegate",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    expect(spawnSubagentDirectMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        continuationDelegateAdmission: expect.objectContaining({
          source: {
            ownerSessionKey: "agent:main:subagent:test",
            flowId: delegate.flowId,
            expectedRevision: delegate.expectedRevision,
          },
        }),
      }),
    );
    expect(markPendingDelegateFailedMock).not.toHaveBeenCalled();
  });

  it("does not set inherited silent/wake for a normal (visible) parent", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:test": { sessionId: "session-child", updatedAt: Date.now() },
          "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
        }) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-visible-parent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "visible chain hop",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    expect(dispatchToolDelegatesMock).toHaveBeenCalledTimes(1);
    const call = dispatchToolDelegatesMock.mock.calls[0]?.[0] as {
      inheritedSilent?: boolean;
      inheritedWake?: boolean;
    };
    expect(call?.inheritedSilent).toBeFalsy();
    expect(call?.inheritedWake).toBeFalsy();
  });

  it("passes loadFresh/persist callbacks so a hedge-fired delayed delegate advances chain state durably", async () => {
    // The drain arms the shared hedge for delayed delegates.
    // The hedge-fired dispatch has no enclosing runner frame, so the drain must
    // supply loadFreshChainState + persistChainState — otherwise multiple delayed
    // delegates hedge-fire against the stale pre-spawn count and bypass maxChainLength.
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:test": {
            sessionId: "session-child",
            updatedAt: Date.now(),
            continuationChainCount: 2,
            continuationChainStartedAt: 1_700_000_000_000,
            continuationChainTokens: 4_000,
          },
          "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
        }) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-hedge-callbacks",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "delayed chain hop",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    expect(dispatchToolDelegatesMock).toHaveBeenCalledTimes(1);
    const call = dispatchToolDelegatesMock.mock.calls[0]?.[0] as {
      loadFreshChainState?: () => unknown;
      persistChainState?: (state: unknown) => unknown;
    };
    expect(typeof call?.loadFreshChainState).toBe("function");
    expect(typeof call?.persistChainState).toBe("function");
    // The fresh loader reads the child entry's persisted chain basis.
    expect(call?.loadFreshChainState?.()).toMatchObject({
      currentChainCount: 2,
      accumulatedChainTokens: 4_000,
    });
    updateSessionEntryMock.mockRejectedValueOnce(new Error("session store write failed"));
    await expect(
      call?.persistChainState?.({
        currentChainCount: 3,
        chainStartedAt: 1_700_000_000_000,
        accumulatedChainTokens: 4_500,
      }),
    ).rejects.toThrow("not durably persisted");
  });

  it("preserves post-bracket chain override for hedge-fired delayed tool drains", async () => {
    const childEntry = {
      sessionId: "session-child",
      updatedAt: Date.now(),
      continuationChainCount: 1,
      continuationChainStartedAt: 1_700_000_000_000,
      continuationChainTokens: 7_000,
      continuationChainId: "chain-post-bracket",
    };
    const store: Record<string, Record<string, unknown>> = {
      "agent:main:subagent:delayed-tool": childEntry,
      "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
    };
    loadSessionStoreMock.mockImplementation(() => store as unknown as Record<string, unknown>);

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:delayed-tool",
      childRunId: "run-delayed-tool",
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

    expect(dispatchToolDelegatesMock).toHaveBeenCalledTimes(1);
    const call = dispatchToolDelegatesMock.mock.calls[0]?.[0] as {
      chainState?: {
        currentChainCount?: number;
        accumulatedChainTokens?: number;
        chainId?: string;
      };
      loadFreshChainState?: () => {
        currentChainCount: number;
        accumulatedChainTokens: number;
        chainId?: string;
      };
    };
    expect(call?.chainState).toMatchObject({
      currentChainCount: 2,
      accumulatedChainTokens: 7_000,
      chainId: "chain-post-bracket",
    });
    expect(call?.loadFreshChainState?.()).toMatchObject({
      currentChainCount: 2,
      accumulatedChainTokens: 7_000,
      chainId: "chain-post-bracket",
    });
    expect(childEntry).toMatchObject({
      continuationChainCount: 2,
      continuationChainTokens: 7_000,
      continuationChainId: "chain-post-bracket",
    });
  });

  it("force-dispatches delayed child drains when the post-bracket override cannot be persisted", async () => {
    const childEntry = {
      sessionId: "session-child",
      updatedAt: Date.now(),
      continuationChainCount: 1,
      continuationChainStartedAt: 1_700_000_000_000,
      continuationChainTokens: 7_000,
    };
    const store: Record<string, Record<string, unknown>> = {
      "agent:main:subagent:override-persist-fail": childEntry,
      "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
    };
    loadSessionStoreMock.mockImplementation(() => store as unknown as Record<string, unknown>);
    updateSessionEntryMock.mockRejectedValueOnce(new Error("session store write failed"));

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:override-persist-fail",
      childRunId: "run-override-persist-fail",
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

    expect(dispatchToolDelegatesMock).toHaveBeenCalledTimes(1);
    const call = dispatchToolDelegatesMock.mock.calls[0]?.[0] as {
      chainState?: { currentChainCount?: number; accumulatedChainTokens?: number };
      dispatchQueuedRegardlessOfDelay?: boolean;
    };
    expect(call.chainState).toMatchObject({
      currentChainCount: 2,
      accumulatedChainTokens: 7_000,
    });
    expect(call.dispatchQueuedRegardlessOfDelay).toBe(true);
  });

  it("clears queued fold markers after a post-bracket override persists", async () => {
    const childEntry = {
      sessionId: "session-child",
      updatedAt: Date.now(),
      continuationChainCount: 1,
      continuationChainStartedAt: 1_700_000_000_000,
      continuationChainTokens: 7_000,
    };
    const store: Record<string, Record<string, unknown>> = {
      "agent:main:subagent:override-persist-clear-fold": childEntry,
      "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
    };
    loadSessionStoreMock.mockImplementation(() => store as unknown as Record<string, unknown>);

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:override-persist-clear-fold",
      childRunId: "run-override-persist-clear-fold",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Delegated from sub-agent: prior hop",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done\n[[CONTINUE_DELEGATE: delayed bracket +30s]]",
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(dispatchToolDelegatesMock).toHaveBeenCalledTimes(1);
    expect(clearQueuedDelegatesChainTokensFoldMock).toHaveBeenCalledWith(
      "agent:main:subagent:override-persist-clear-fold",
    );
  });

  it("defaults chain state to 0 when child session has no chain fields", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:leaf": {
            sessionId: "session-leaf",
            updatedAt: Date.now(),
          },
          "agent:main:main": {
            sessionId: "session-main",
            updatedAt: Date.now(),
          },
        }) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:leaf",
      childRunId: "run-leaf",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "leaf task",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    expect(dispatchToolDelegatesMock).toHaveBeenCalledTimes(1);
    const call = dispatchToolDelegatesMock.mock.calls[0]?.[0] as {
      chainState?: { currentChainCount?: number; accumulatedChainTokens?: number };
    };
    expect(call?.chainState?.currentChainCount).toBe(0);
    expect(call?.chainState?.accumulatedChainTokens).toBe(0);
  });

  it("does not dispatch when continuation is disabled", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
    };
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:test": {
            sessionId: "session-child",
            updatedAt: Date.now(),
            continuationChainCount: 1,
          },
        }) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-disabled",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "test",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    expect(dispatchToolDelegatesMock).not.toHaveBeenCalled();
  });

  it("does not fail the announce when dispatch throws", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:test": {
            sessionId: "session-child",
            updatedAt: Date.now(),
          },
          "agent:main:main": {
            sessionId: "session-main",
            updatedAt: Date.now(),
          },
        }) as Record<string, unknown>,
    );
    dispatchToolDelegatesMock.mockRejectedValueOnce(new Error("spawn failed"));

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-dispatch-error",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "test",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    expect(dispatchToolDelegatesMock).toHaveBeenCalledTimes(1);
    // Dispatch failure must not break the announce path — it is best-effort.
    expect(didAnnounce).toBe("delivered");
  });

  it("persists advanced child chain state after delegates dispatched", async () => {
    // `drainChildContinuationQueue` must consume
    // the `chainState` returned by `dispatchToolDelegates` (advanced past
    // the dispatched hops) and write it back to both the in-memory child
    // entry AND the durable session store. Without this, the next drain
    // reloads stale counters and `maxChainLength` enforcement breaks.
    const childEntry = {
      sessionId: "session-child",
      updatedAt: Date.now(),
      continuationChainCount: 1,
      continuationChainStartedAt: 1_700_000_000_000,
      continuationChainTokens: 5_000,
    };
    const store: Record<string, Record<string, unknown>> = {
      "agent:main:subagent:test": childEntry,
      "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
    };
    loadSessionStoreMock.mockImplementation(() => store as unknown as Record<string, unknown>);

    dispatchToolDelegatesMock.mockResolvedValueOnce({
      dispatched: 2,
      rejected: 0,
      chainState: {
        currentChainCount: 3,
        chainStartedAt: 1_700_000_000_000,
        accumulatedChainTokens: 12_500,
      },
    });

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-persist",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persist test",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    // In-memory child entry must reflect the advanced chain state so any
    // post-drain readers (e.g. a second drain on the same entry) see fresh
    // counters rather than the pre-dispatch snapshot.
    expect(childEntry.continuationChainCount).toBe(3);
    expect(childEntry.continuationChainStartedAt).toBe(1_700_000_000_000);
    expect(childEntry.continuationChainTokens).toBe(12_500);
  });

  it("skips persist when no delegates dispatched", async () => {
    // Negative case: when `dispatched` is 0, the chain state is unchanged
    // and we must not re-write the entry (avoid spurious `updatedAt` churn
    // and unnecessary store I/O).
    const childEntry = {
      sessionId: "session-child",
      updatedAt: Date.now(),
      continuationChainCount: 1,
      continuationChainStartedAt: 1_700_000_000_000,
      continuationChainTokens: 5_000,
    };
    const store: Record<string, Record<string, unknown>> = {
      "agent:main:subagent:test": childEntry,
      "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
    };
    loadSessionStoreMock.mockImplementation(() => store as unknown as Record<string, unknown>);

    dispatchToolDelegatesMock.mockResolvedValueOnce({
      dispatched: 0,
      rejected: 0,
      chainState: {
        currentChainCount: 1,
        chainStartedAt: 1_700_000_000_000,
        accumulatedChainTokens: 5_000,
      },
    });

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-no-dispatch",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "no dispatch test",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    // Counter unchanged — no advance to persist.
    expect(childEntry.continuationChainCount).toBe(1);
    expect(childEntry.continuationChainTokens).toBe(5_000);
  });
});
