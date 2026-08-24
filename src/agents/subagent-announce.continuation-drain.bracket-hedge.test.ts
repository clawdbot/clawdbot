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
const markPendingDelegateSpawnAcceptedMock = vi.fn(
  (_delegate: ConsumedToolDelegate, _childSessionKey: string) => true,
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
    markPendingDelegateSpawnAcceptedMock.mockReset().mockReturnValue(true);
    enqueuePendingDelegateMock.mockReset();
    clearQueuedDelegatesChainTokensFoldMock.mockReset().mockReturnValue(0);
    stagePostCompactionDelegateMock.mockReset();
    spawnSubagentDirectMock.mockReset().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:grandchild",
      runId: "run-grandchild",
    });
  });

  it("does not reserve a current-chain hop when an immediate bracket delegate is rejected", async () => {
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

  it("does not reserve a current-chain hop for a post-compaction bracket delegate before tool delegates drain", async () => {
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
      createdAt: expect.any(Number),
    });
    expect(markPendingDelegateFailedMock).not.toHaveBeenCalled();
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    const [toolSpawn] = expectDefined(spawnSubagentDirectMock.mock.calls.at(0), "spawn call");
    expect(toolSpawn.task).toEqual(expect.stringContaining("[continuation:chain-hop:2]"));
    expect(toolSpawn.continuationChainState).toMatchObject({ count: 2, tokens: 7_000 });
    expect(toolSpawn.continuationDelegateFlowId).toBe("flow-tool-post-compaction");
  });

  it("arms a delayed bracket hedge after same-child tool delegates advance the override", async () => {
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

  it("arms a delayed bracket hedge from accepted tool hops only when a sibling tool is rejected", async () => {
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

  it("does not add tool hops to a delayed bracket hedge when all sibling tools are rejected", async () => {
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
