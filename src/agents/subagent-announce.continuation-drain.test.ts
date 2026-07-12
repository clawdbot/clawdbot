// "RFC §" references herein cite docs/design/continue-work-signal-v2.md (Agent Self-Elected Turn Continuation / CONTINUE_WORK).
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentAnnounceDeliveryRuntimeMock } from "./subagent-announce.test-support.js";
import type { SpawnSubagentResult } from "./subagent-spawn.js";

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
// #1144: controllable so a test can force the child chain-cost persist to fail
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
// #1144: capture durable delayed-bracket delegate enqueues (replaces the old
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

vi.mock("./subagent-announce.runtime.js", () => ({
  callGateway: (request: unknown) => callGatewayMock(request),
  dispatchGatewayMethodInProcess: vi.fn(),
  getRuntimeConfig: () => mockConfig,
  isEmbeddedAgentRunActive: (sessionId: string) => isEmbeddedAgentRunActiveMock(sessionId),
  loadConfig: () => mockConfig,
  loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
  readSessionMessagesAsync: vi.fn(async () => []),
  readSessionEntry: (storePath: string, sessionKey: string) => {
    const store = loadSessionStoreMock(storePath) as Record<string, unknown> | undefined;
    return store?.[sessionKey];
  },
  resolveContinuationRuntimeConfig: (cfg?: unknown) => resolveContinuationRuntimeConfigMock(cfg),
  queueEmbeddedAgentMessage: (sessionId: string, text: string) =>
    queueEmbeddedAgentMessageMock(sessionId, text),
  resolveAgentIdFromSessionKey: (sessionKey: string) =>
    resolveAgentIdFromSessionKeyMock(sessionKey),
  resolveMainSessionKey: (cfg: unknown) => resolveMainSessionKeyMock(cfg),
  resolveStorePath: (store: unknown, options: unknown) => resolveStorePathMock(store, options),
  waitForEmbeddedAgentRunEnd: (sessionId: string, timeoutMs?: number) =>
    waitForEmbeddedAgentRunEndMock(sessionId, timeoutMs),
}));

vi.mock("./subagent-announce-delivery.runtime.js", () =>
  createSubagentAnnounceDeliveryRuntimeMock({
    callGateway: (request: unknown) => callGatewayMock(request),
    dispatchGatewayMethodInProcess: vi.fn(),
    getRuntimeConfig: () => mockConfig,
    loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
    resolveAgentIdFromSessionKey: (sessionKey: string) =>
      resolveAgentIdFromSessionKeyMock(sessionKey),
    resolveMainSessionKey: (cfg: unknown) => resolveMainSessionKeyMock(cfg),
    resolveStorePath: (store: unknown, options: unknown) => resolveStorePathMock(store, options),
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

vi.mock("./subagent-announce-delivery.js", () => ({
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

vi.mock("./subagent-announce.registry.runtime.js", () => subagentRegistryRuntimeMock);

vi.mock("../auto-reply/continuation/delegate-dispatch.js", () => ({
  dispatchToolDelegates: (params: unknown) => dispatchToolDelegatesMock(params),
}));

vi.mock("../auto-reply/continuation-delegate-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auto-reply/continuation-delegate-store.js")>()),
  clearQueuedDelegatesChainTokensFold: (sessionKey: string) =>
    clearQueuedDelegatesChainTokensFoldMock(sessionKey),
}));

// Feed the in-function tool-delegate drain (subagent-announce.ts) and capture
// its spawn. `consumePendingDelegates` is mocked on the canonical store module
// (not the barrel shim) because the forks pool does not intercept barrel
// re-exports; the shim forwards the canonical binding.
vi.mock("../auto-reply/continuation/delegate-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auto-reply/continuation/delegate-store.js")>()),
  consumePendingDelegates: (sessionKey: string) => consumePendingDelegatesMock(sessionKey),
  markPendingDelegateFailed: (...args: unknown[]) => markPendingDelegateFailedMock(...args),
  enqueuePendingDelegate: (sessionKey: string, delegate: unknown) =>
    enqueuePendingDelegateMock(sessionKey, delegate),
  clearQueuedDelegatesChainTokensFold: (sessionKey: string) =>
    clearQueuedDelegatesChainTokensFoldMock(sessionKey),
  stagePostCompactionDelegate: (sessionKey: string, delegate: unknown) =>
    stagePostCompactionDelegateMock(sessionKey, delegate),
}));

vi.mock("./subagent-spawn.js", () => ({
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

vi.mock("../config/sessions/store-load.js", () => ({
  loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-accessor.js")>()),
  updateSessionEntry: (
    scope: { sessionKey: string; storePath?: string },
    update: (entry: Record<string, unknown>) => Partial<Record<string, unknown>> | null,
    options?: { requireWriteSuccess?: boolean },
  ) => updateSessionEntryMock(scope, update, options),
}));

import { runSubagentAnnounceFlow } from "./subagent-announce.js";

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

  it("threads a silent/wake parent's inherited policy into the early child drain (#1158)", async () => {
    // Finding r3517437268: this early drain runs BEFORE the later parentWasSilent
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

  it("does not set inherited silent/wake for a normal (visible) parent (#1158)", async () => {
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

  it("passes loadFresh/persist callbacks so a hedge-fired delayed delegate advances chain state durably (#1158)", async () => {
    // Finding r3517500714: the drain arms the shared hedge for delayed delegates.
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

  it("preserves post-bracket chain override for hedge-fired delayed tool drains (#1159)", async () => {
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

  it("force-dispatches delayed child drains when the post-bracket override cannot be persisted (#1159)", async () => {
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

  it("clears queued fold markers after a post-bracket override persists (#1159)", async () => {
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
    expect(didAnnounce).toBe(true);
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

  it("threads targeted returns through the session-delivery fanout helper", async () => {
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

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-targeted",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] targeted task",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "targeted result",
      continuationTargetSessionKeys: ["agent:main:root", "agent:main:sibling"],
    });

    expect(
      continuationTargetingMock.resolveContinuationReturnTargetSessionKeys,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultSessionKey: "agent:main:main",
        targetSessionKeys: ["agent:main:root", "agent:main:sibling"],
      }),
    );
    expect(continuationTargetingMock.enqueueContinuationReturnDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionKeys: ["agent:main:root", "agent:main:sibling"],
        idempotencyKeyBase: expect.stringContaining("continuation-return:"),
        wakeRecipients: true,
        childRunId: "run-targeted",
      }),
    );
  });

  // Regression test for the targeted-return branch-entry path:
  // continue_delegate({ targetSessionKey: "agent:main:main", mode: "silent-wake" })
  // must route the return to the named single target, not to the dispatcher.
  // Plural `continuationTargetSessionKeys` form is exercised above; this test
  // pins the singular form's path through the same announce-return seam.
  //
  // This test pins the branch-entry contract. The I/O-level
  // enqueue-without-immediate-ack contract is pinned by
  // `cross-session-targeting.test.ts` against the real
  // `enqueueContinuationReturnDeliveries` with mocked deps.
  it("routes singular continuationTargetSessionKey to the named recipient (not dispatcher)", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:test": {
            sessionId: "session-child",
            updatedAt: Date.now(),
          },
          "agent:main:test:channel:CHANNEL_A": {
            sessionId: "session-dispatcher",
            updatedAt: Date.now(),
          },
          "agent:main:main": {
            sessionId: "session-target",
            updatedAt: Date.now(),
          },
        }) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-singular-targeted",
      requesterSessionKey: "agent:main:test:channel:CHANNEL_A",
      requesterDisplayKey: "discord-channel",
      task: "[continuation:chain-hop:1] OV-1 fire-1 reproduction",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "received delegate at agent:main:main",
      silentAnnounce: true,
      wakeOnReturn: true,
      continuationTargetSessionKey: "agent:main:main",
    });

    // The resolver must see the singular targetSessionKey (not the
    // dispatcher's session) and the dispatcher only as the fallback default.
    expect(
      continuationTargetingMock.resolveContinuationReturnTargetSessionKeys,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultSessionKey: "agent:main:test:channel:CHANNEL_A",
        targetSessionKey: "agent:main:main",
      }),
    );
    // The enqueue must target the named recipient ONLY — not the dispatcher.
    expect(continuationTargetingMock.enqueueContinuationReturnDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionKeys: ["agent:main:main"],
        wakeRecipients: true,
        childRunId: "run-singular-targeted",
      }),
    );
    const enqueueCall =
      continuationTargetingMock.enqueueContinuationReturnDeliveries.mock.calls[0]?.[0];
    expect((enqueueCall as { targetSessionKeys: string[] })?.targetSessionKeys).not.toContain(
      "agent:main:test:channel:CHANNEL_A",
    );
    // Idempotency-key shape carries an index + sessionKey suffix per RFC §6.7
    // so the durable session-delivery-queue file under the recipient's key
    // resolves to a stable hash that the recovery loop can replay
    // post-restart. The actual file-write + ack-skip behavior is exercised
    // against the real `enqueueContinuationReturnDeliveries` in
    // `cross-session-targeting.test.ts`.
    expect((enqueueCall as { idempotencyKeyBase: string })?.idempotencyKeyBase).toMatch(
      /^continuation-return:/,
    );
  });

  it("fanoutMode=all spends one chain step per completion, not per recipient", async () => {
    const knownSessionKeys = [
      "agent:main:main",
      "agent:main:subagent:test",
      ...Array.from({ length: 48 }, (_, index) => `agent:main:recipient-${index}`),
    ];
    loadSessionStoreMock.mockImplementation(
      () =>
        Object.fromEntries(
          knownSessionKeys.map((sessionKey) => [
            sessionKey,
            {
              sessionId: `session-${sessionKey}`,
              updatedAt: Date.now(),
            },
          ]),
        ) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-fanout",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] fanout task",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "fanout result",
      continuationFanoutMode: "all",
      traceparent: validTraceparent,
    });

    const call = continuationTargetingMock.enqueueContinuationReturnDeliveries.mock
      .calls[0]?.[0] as
      | {
          targetSessionKeys?: string[];
          fanoutMode?: string;
          chainStepRemaining?: number;
          traceparent?: string;
        }
      | undefined;
    expect(call?.targetSessionKeys).toHaveLength(50);
    expect(call?.fanoutMode).toBe("all");
    expect(call?.chainStepRemaining).toBe(9);
    expect(call?.traceparent).toBe(validTraceparent);
  });

  it("drops return traceparent once the completion exhausts chain-step budget", async () => {
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

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-capped",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:2] capped targeted task",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "targeted result",
      continuationTargetSessionKeys: ["agent:main:root", "agent:main:sibling"],
      traceparent: validTraceparent,
    });

    expect(continuationTargetingMock.enqueueContinuationReturnDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionKeys: ["agent:main:root", "agent:main:sibling"],
        chainStepRemaining: 0,
      }),
    );
    expect(continuationTargetingMock.enqueueContinuationReturnDeliveries).toHaveBeenCalledWith(
      expect.not.objectContaining({ traceparent: expect.any(String) }),
    );
  });

  // #989-P2: the trigger minted on the direct-announce path must distinguish an
  // ordinary inter-session subagent completion from an actual continuation-chain
  // hop. Ordinary completions are external turn-entries and must reset the
  // chain budget downstream; only `[continuation:chain-hop:N]` returns are
  // mid-chain wakes that preserve the runaway leash.
  it("tags an ordinary subagent completion with continuationTrigger=subagent-return", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:ordinary": {
            sessionId: "session-child",
            updatedAt: Date.now(),
            inputTokens: 0,
            outputTokens: 0,
          },
          "agent:main:main": {
            sessionId: "session-main",
            updatedAt: Date.now(),
          },
        }) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:ordinary",
      childRunId: "run-ordinary",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "ordinary inter-session subagent task",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    expect(deliverSubagentAnnouncementMock).toHaveBeenCalledWith(
      expect.objectContaining({ continuationTriggerOverride: "subagent-return" }),
    );
  });

  it("tags an in-chain continuation-chain-hop return with continuationTrigger=delegate-return", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:hop": {
            sessionId: "session-child",
            updatedAt: Date.now(),
            inputTokens: 0,
            outputTokens: 0,
          },
          "agent:main:main": {
            sessionId: "session-main",
            updatedAt: Date.now(),
          },
        }) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:hop",
      childRunId: "run-hop",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Delegated from sub-agent: keep working",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    expect(deliverSubagentAnnouncementMock).toHaveBeenCalledWith(
      expect.objectContaining({ continuationTriggerOverride: "delegate-return" }),
    );
  });

  it("persists the settled child's run tokens into the child's durable chain cost before dispatch (#1144)", async () => {
    // A chain-hop child that spent tokens this turn must have those tokens
    // folded into its OWN durable `continuationChainTokens` BEFORE queued child
    // delegates spawn — persisted to the child entry, not just held in memory.
    // The child is the durable owner of any delayed delegate it queues, so
    // restart recovery re-drives that delegate from this persisted value; a
    // stale (pre-run) basis would let a child run that already blew past
    // costCapTokens launch another hop after a restart.
    const childEntry = {
      sessionId: "session-child",
      updatedAt: Date.now(),
      continuationChainCount: 1,
      continuationChainStartedAt: 1_700_000_000_000,
      continuationChainTokens: 5_000,
      // The child's just-completed run cost (input + output).
      inputTokens: 300_000,
      outputTokens: 250_000,
    };
    const store: Record<string, Record<string, unknown>> = {
      "agent:main:subagent:cost": childEntry,
      "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
    };
    loadSessionStoreMock.mockImplementation(() => store as unknown as Record<string, unknown>);

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:cost",
      childRunId: "run-cost",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Delegated from sub-agent: keep working",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    // The child's own run cost is folded into the CHILD entry's durable chain
    // total: 5_000 inherited + (300_000 + 250_000) run = 555_000. Restart
    // recovery re-drives child-queued delegates from this persisted value.
    expect(childEntry.continuationChainTokens).toBe(555_000);

    // The live drain reads that same persisted basis (no separate in-memory
    // fold), so the dispatcher sees 555_000 — over costCapTokens (500_000) — and
    // the real dispatcher would reject the hop.
    expect(updateSessionEntryMock.mock.calls[0]?.[2]).toMatchObject({
      requireWriteSuccess: true,
    });
    expect(updateSessionEntryMock.mock.calls[1]?.[2]).toMatchObject({
      requireWriteSuccess: true,
    });
    expect(dispatchToolDelegatesMock).toHaveBeenCalledTimes(1);
    const call = dispatchToolDelegatesMock.mock.calls[0]?.[0] as {
      chainState?: { accumulatedChainTokens?: number };
    };
    expect(call?.chainState?.accumulatedChainTokens).toBe(555_000);
    expect(call?.chainState?.accumulatedChainTokens).toBeGreaterThan(500_000);
  });

  it("folds the child run cost into the live drain basis when the durable persist fails (#1144)", async () => {
    // If the durable child chain-cost persist throws, the drain must NOT fall
    // through to the stale persisted basis. The run cost is folded into the
    // drain's in-memory cost basis instead so the cost cap still enforces
    // against the post-run total (fails closed).
    const childEntry = {
      sessionId: "session-child",
      updatedAt: Date.now(),
      continuationChainCount: 1,
      continuationChainStartedAt: 1_700_000_000_000,
      continuationChainTokens: 5_000,
      inputTokens: 300_000,
      outputTokens: 250_000,
    };
    const store: Record<string, Record<string, unknown>> = {
      "agent:main:subagent:cost-fail": childEntry,
      "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
    };
    loadSessionStoreMock.mockImplementation(() => store as unknown as Record<string, unknown>);
    // Force every chain-cost persist (parent + child) to fail.
    updateSessionEntryMock.mockRejectedValue(new Error("session store write failed"));

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:cost-fail",
      childRunId: "run-cost-fail",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Delegated from sub-agent: keep working",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    // Persist failed, so the durable child entry is unchanged (stale pre-run).
    expect(childEntry.continuationChainTokens).toBe(5_000);
    expect(updateSessionEntryMock.mock.calls[0]?.[2]).toMatchObject({
      requireWriteSuccess: true,
    });
    expect(updateSessionEntryMock.mock.calls[1]?.[2]).toMatchObject({
      requireWriteSuccess: true,
    });
    // But the live drain still enforces against the post-run total via the
    // in-memory fallback fold: 5_000 + (300_000 + 250_000) = 555_000.
    expect(dispatchToolDelegatesMock).toHaveBeenCalledTimes(1);
    const call = dispatchToolDelegatesMock.mock.calls[0]?.[0] as {
      chainState?: { accumulatedChainTokens?: number };
      dispatchQueuedRegardlessOfDelay?: boolean;
    };
    expect(call?.chainState?.accumulatedChainTokens).toBe(555_000);
    expect(call?.chainState?.accumulatedChainTokens).toBeGreaterThan(500_000);
    // Persist failed → force-dispatch queued delegates immediately so a delayed
    // one is not left durably queued to recover on the stale child basis.
    expect(call?.dispatchQueuedRegardlessOfDelay).toBe(true);
  });

  it("treats a no-op child token persist as failed and folds the run cost (#1158)", async () => {
    const childEntry = {
      sessionId: "session-child",
      updatedAt: Date.now(),
      continuationChainCount: 1,
      continuationChainStartedAt: 1_700_000_000_000,
      continuationChainTokens: 5_000,
      inputTokens: 300_000,
      outputTokens: 250_000,
    };
    const store: Record<string, Record<string, unknown>> = {
      "agent:main:subagent:cost-child-noop": childEntry,
      "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
    };
    loadSessionStoreMock.mockImplementation(() => store as unknown as Record<string, unknown>);
    updateSessionEntryMock
      .mockImplementationOnce(updateSessionEntryInStore)
      .mockResolvedValueOnce(null);

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:cost-child-noop",
      childRunId: "run-cost-child-noop",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Delegated from sub-agent: keep working",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    expect(childEntry.continuationChainTokens).toBe(5_000);
    expect(updateSessionEntryMock.mock.calls[1]?.[2]).toMatchObject({
      requireWriteSuccess: true,
    });
    expect(dispatchToolDelegatesMock).toHaveBeenCalledTimes(1);
    const call = dispatchToolDelegatesMock.mock.calls[0]?.[0] as {
      chainState?: { accumulatedChainTokens?: number };
      dispatchQueuedRegardlessOfDelay?: boolean;
    };
    expect(call?.chainState?.accumulatedChainTokens).toBe(555_000);
    expect(call?.dispatchQueuedRegardlessOfDelay).toBe(true);
  });

  it("routes a delayed bracket delegate through the durable pending store, not a volatile timer (#1144)", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:bracket": {
            sessionId: "session-child",
            updatedAt: Date.now(),
            continuationChainCount: 1,
            continuationChainStartedAt: 1_700_000_000_000,
            continuationChainTokens: 1_000,
          },
          "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
        }) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:bracket",
      childRunId: "run-bracket",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Delegated from sub-agent: keep working",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      // A delayed bracket delegate (+30s) emitted by the settled child.
      roundOneReply: "Research result.\n[[CONTINUE_DELEGATE: keep working +30s]]",
    });

    // The delayed bracket delegate is persisted under the CHILD session (same
    // queue + chain-state owner as tool delegates) with its delay — it survives
    // a restart before the delay elapses and preserves the child's hop/cost.
    expect(enqueuePendingDelegateMock).toHaveBeenCalledTimes(1);
    const [enqueueSessionKey, enqueued] = enqueuePendingDelegateMock.mock.calls[0] as [
      string,
      {
        task: string;
        delayMs?: number;
        traceparent?: string;
        spawnRequesterSessionKey?: string;
      },
    ];
    expect(enqueueSessionKey).toBe("agent:main:subagent:bracket");
    expect(enqueued.task).toBe("keep working");
    expect(enqueued.delayMs).toBe(30_000);
    expect(enqueued.traceparent).toBeUndefined();
    expect(enqueued.spawnRequesterSessionKey).toBe("agent:main:main");

    // It must NOT be spawned immediately via a volatile in-process path.
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(dispatchToolDelegatesMock).toHaveBeenCalledTimes(1);
    const dispatchCall = dispatchToolDelegatesMock.mock.calls[0]?.[0] as {
      chainState?: { currentChainCount?: number; accumulatedChainTokens?: number };
    };
    expect(dispatchCall.chainState).toMatchObject({
      currentChainCount: 2,
      accumulatedChainTokens: 1_000,
    });
  });

  it("persists traceparent on durable delayed bracket delegates (#1159)", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:bracket-trace": {
            sessionId: "session-child",
            updatedAt: Date.now(),
            continuationChainCount: 1,
            continuationChainStartedAt: 1_700_000_000_000,
            continuationChainTokens: 1_000,
          },
          "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
        }) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:bracket-trace",
      childRunId: "run-bracket-trace",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Delegated from sub-agent: keep working",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: `Research result.\n[[CONTINUE_DELEGATE: keep working +30s | traceparent=${validTraceparent}]]`,
    });

    expect(enqueuePendingDelegateMock).toHaveBeenCalledTimes(1);
    expect(enqueuePendingDelegateMock.mock.calls[0]?.[1]).toMatchObject({
      task: "keep working",
      delayMs: 30_000,
      traceparent: validTraceparent,
      spawnRequesterSessionKey: "agent:main:main",
    });
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("persists inherited silent/wake policy on durable delayed bracket delegates (#1159)", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:bracket-inherit": {
            sessionId: "session-child",
            updatedAt: Date.now(),
            continuationChainCount: 1,
            continuationChainStartedAt: 1_700_000_000_000,
            continuationChainTokens: 1_000,
          },
          "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
        }) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:bracket-inherit",
      childRunId: "run-bracket-inherit",
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
      silentAnnounce: true,
      wakeOnReturn: true,
    });

    expect(enqueuePendingDelegateMock).toHaveBeenCalledTimes(1);
    expect(enqueuePendingDelegateMock.mock.calls[0]?.[1]).toMatchObject({
      task: "keep working",
      delayMs: 30_000,
      mode: "silent-wake",
      inheritedSilent: true,
      inheritedWake: true,
    });
  });

  it("spawns a delayed bracket delegate immediately (no durable enqueue) when the child chain-cost persist fails (#1144)", async () => {
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

  it("rejects a bracket delegate when the parent chain-cost persist fails and the folded basis exceeds the cap (#1144)", async () => {
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

  it("treats a no-op parent token persist as failed and folds the run cost (#1158)", async () => {
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

  it("does not reserve a current-chain hop when an immediate bracket delegate is rejected (#1159)", async () => {
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
          "agent:main:subagent:mixed-rejected-bracket": {
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
      task: "tool-row delegate still fits after bracket rejection",
      flowId: "flow-tool-after-bracket-reject",
      expectedRevision: 2,
    };
    consumePendingDelegatesMock.mockReturnValue([toolDelegate]);
    spawnSubagentDirectMock
      .mockResolvedValueOnce({ status: "forbidden", error: "max children reached" })
      .mockResolvedValueOnce({
        status: "accepted",
        childSessionKey: "agent:main:subagent:tool-after-bracket-reject",
        runId: "run-tool-after-bracket-reject",
      });

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:mixed-rejected-bracket",
      childRunId: "run-mixed-rejected-bracket",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Delegated from sub-agent: prior hop",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done\n[[CONTINUE_DELEGATE: rejected bracket delegate]]",
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
    expect(toolSpawn.task).toEqual(expect.stringContaining("[continuation:chain-hop:2]"));
    expect(toolSpawn.continuationChainState).toMatchObject({ count: 2, tokens: 7_000 });
    expect(toolSpawn.continuationDelegateFlowId).toBe("flow-tool-after-bracket-reject");
    expect(markPendingDelegateFailedMock).not.toHaveBeenCalledWith(
      toolDelegate,
      expect.stringContaining("chain length"),
      "Delegate rejected",
    );
  });

  it("does not reserve a current-chain hop for a post-compaction bracket delegate before tool delegates drain (#1159)", async () => {
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
          "agent:main:subagent:post-compaction-mixed": {
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
      task: "tool-row delegate still fits",
      flowId: "flow-tool-post-compaction",
      expectedRevision: 2,
    };
    consumePendingDelegatesMock.mockReturnValue([toolDelegate]);

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:post-compaction-mixed",
      childRunId: "run-post-compaction-mixed",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Delegated from sub-agent: prior hop",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done\n[[CONTINUE_DELEGATE: rehydrate later | post-compaction]]",
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(stagePostCompactionDelegateMock).toHaveBeenCalledWith("agent:main:main", {
      task: "rehydrate later",
      stagedAt: expect.any(Number),
      firstArmedAt: expect.any(Number),
    });
    expect(markPendingDelegateFailedMock).not.toHaveBeenCalled();
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    const [toolSpawn] = expectDefined(spawnSubagentDirectMock.mock.calls.at(0), "spawn call");
    expect(toolSpawn.task).toEqual(expect.stringContaining("[continuation:chain-hop:2]"));
    expect(toolSpawn.continuationChainState).toMatchObject({ count: 2, tokens: 7_000 });
    expect(toolSpawn.continuationDelegateFlowId).toBe("flow-tool-post-compaction");
  });

  it("arms a delayed bracket hedge after same-child tool delegates advance the override (#1159)", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:delayed-bracket-tool": {
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
      { task: "tool-row delegate", flowId: "flow-tool-after-delayed", expectedRevision: 2 },
    ]);

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:delayed-bracket-tool",
      childRunId: "run-delayed-bracket-tool",
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

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    expect(dispatchToolDelegatesMock).toHaveBeenCalledTimes(1);
    const call = dispatchToolDelegatesMock.mock.calls[0]?.[0] as {
      chainState?: { currentChainCount?: number; accumulatedChainTokens?: number };
      loadFreshChainState?: () => { currentChainCount: number; accumulatedChainTokens: number };
    };
    expect(call.chainState).toMatchObject({
      currentChainCount: 2,
      accumulatedChainTokens: 7_000,
    });
    expect(call.loadFreshChainState?.()).toMatchObject({
      currentChainCount: 2,
      accumulatedChainTokens: 7_000,
    });
  });

  it("arms a delayed bracket hedge from accepted tool hops only when a sibling tool is rejected (#1159)", async () => {
    const childEntry = {
      sessionId: "session-child",
      updatedAt: Date.now(),
      continuationChainCount: 1,
      continuationChainStartedAt: 1_700_000_000_000,
      continuationChainTokens: 7_000,
    };
    const store: Record<string, Record<string, unknown>> = {
      "agent:main:subagent:delayed-bracket-one-reject": childEntry,
      "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
    };
    loadSessionStoreMock.mockImplementation(() => store as unknown as Record<string, unknown>);
    const acceptedTool = {
      task: "accepted tool-row delegate",
      flowId: "flow-tool-accepted-before-delay",
      expectedRevision: 2,
    };
    const rejectedTool = {
      task: "rejected tool-row delegate",
      flowId: "flow-tool-rejected-before-delay",
      expectedRevision: 3,
    };
    consumePendingDelegatesMock.mockReturnValue([acceptedTool, rejectedTool]);
    spawnSubagentDirectMock
      .mockResolvedValueOnce({
        status: "accepted",
        childSessionKey: "agent:main:subagent:accepted-tool-before-delay",
        runId: "run-accepted-tool-before-delay",
      })
      .mockResolvedValueOnce({ status: "forbidden", error: "max children reached" });

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:delayed-bracket-one-reject",
      childRunId: "run-delayed-bracket-one-reject",
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

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(2);
    expect(dispatchToolDelegatesMock).toHaveBeenCalledTimes(1);
    const call = dispatchToolDelegatesMock.mock.calls[0]?.[0] as {
      chainState?: { currentChainCount?: number; accumulatedChainTokens?: number };
      loadFreshChainState?: () => { currentChainCount: number; accumulatedChainTokens: number };
    };
    expect(call.chainState).toMatchObject({
      currentChainCount: 2,
      accumulatedChainTokens: 7_000,
    });
    expect(call.loadFreshChainState?.()).toMatchObject({
      currentChainCount: 2,
      accumulatedChainTokens: 7_000,
    });
    expect(childEntry.continuationChainCount).toBe(2);
    expect(markPendingDelegateFailedMock).toHaveBeenCalledWith(
      rejectedTool,
      expect.stringContaining("forbidden"),
      "Delegate rejected",
    );
  });

  it("does not add tool hops to a delayed bracket hedge when all sibling tools are rejected (#1159)", async () => {
    const childEntry = {
      sessionId: "session-child",
      updatedAt: Date.now(),
      continuationChainCount: 1,
      continuationChainStartedAt: 1_700_000_000_000,
      continuationChainTokens: 7_000,
    };
    const store: Record<string, Record<string, unknown>> = {
      "agent:main:subagent:delayed-bracket-all-rejected": childEntry,
      "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
    };
    loadSessionStoreMock.mockImplementation(() => store as unknown as Record<string, unknown>);
    const firstRejectedTool = {
      task: "first rejected tool-row delegate",
      flowId: "flow-tool-first-rejected-before-delay",
      expectedRevision: 2,
    };
    const secondRejectedTool = {
      task: "second rejected tool-row delegate",
      flowId: "flow-tool-second-rejected-before-delay",
      expectedRevision: 3,
    };
    consumePendingDelegatesMock.mockReturnValue([firstRejectedTool, secondRejectedTool]);
    spawnSubagentDirectMock
      .mockResolvedValueOnce({ status: "forbidden", error: "max children reached" })
      .mockResolvedValueOnce({ status: "forbidden", error: "max children reached" });

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:delayed-bracket-all-rejected",
      childRunId: "run-delayed-bracket-all-rejected",
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

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(2);
    const spawnTasks = spawnSubagentDirectMock.mock.calls.map(
      ([params]) => (params as { task: string }).task,
    );
    expect(spawnTasks).toEqual([
      expect.stringContaining("[continuation:chain-hop:2]"),
      expect.stringContaining("[continuation:chain-hop:2]"),
    ]);
    expect(dispatchToolDelegatesMock).toHaveBeenCalledTimes(1);
    const call = dispatchToolDelegatesMock.mock.calls[0]?.[0] as {
      chainState?: { currentChainCount?: number; accumulatedChainTokens?: number };
      loadFreshChainState?: () => { currentChainCount: number; accumulatedChainTokens: number };
    };
    expect(call.chainState).toMatchObject({
      currentChainCount: 1,
      accumulatedChainTokens: 7_000,
    });
    expect(call.loadFreshChainState?.()).toMatchObject({
      currentChainCount: 1,
      accumulatedChainTokens: 7_000,
    });
    expect(childEntry.continuationChainCount).toBe(1);
    expect(markPendingDelegateFailedMock).toHaveBeenCalledWith(
      firstRejectedTool,
      expect.stringContaining("forbidden"),
      "Delegate rejected",
    );
    expect(markPendingDelegateFailedMock).toHaveBeenCalledWith(
      secondRejectedTool,
      expect.stringContaining("forbidden"),
      "Delegate rejected",
    );
  });
});
