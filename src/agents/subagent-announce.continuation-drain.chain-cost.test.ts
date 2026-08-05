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
const listSessionEntriesMock = vi.fn(({ storePath }: { agentId?: string; storePath?: string }) =>
  Object.entries(loadSessionStoreMock(storePath ?? "/tmp/sessions.json")).map(
    ([sessionKey, entry]) => ({ sessionKey, entry }),
  ),
);
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

vi.mock("./subagent-registry-runtime.js", () => subagentRegistryRuntimeMock);

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

vi.mock("./subagent-spawn.js", () => ({
  spawnSubagentDirect: (params: Record<string, unknown>, ctx: unknown) =>
    spawnSubagentDirectMock(params, ctx),
}));

vi.mock("../auto-reply/continuation/config.js", () => ({
  resolveContinuationRuntimeConfig: (cfg?: unknown) => resolveContinuationRuntimeConfigMock(cfg),
}));

vi.mock("../auto-reply/continuation/targeting.js", () => continuationTargetingMock);

vi.mock("../config/sessions/targets.js", () => ({
  resolveAllAgentSessionStoreTargetsSync: () => [
    { agentId: "main", storePath: "/tmp/sessions.json" },
  ],
}));

vi.mock("../config/sessions/store-load.js", () => ({
  loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-accessor.js")>()),
  listSessionEntries: (scope: { agentId?: string; storePath?: string }) =>
    listSessionEntriesMock(scope),
  updateSessionEntry: (
    scope: { sessionKey: string; storePath?: string },
    update: (entry: Record<string, unknown>) => Partial<Record<string, unknown>> | null,
    options?: { requireWriteSuccess?: boolean },
  ) => updateSessionEntryMock(scope, update, options),
}));

import { runSubagentAnnounceFlow } from "./subagent-announce.js";

const splitLintUse = [expectDefined];
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
    listSessionEntriesMock.mockClear();
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
    expect(listSessionEntriesMock).toHaveBeenCalledWith({
      agentId: "main",
      storePath: "/tmp/sessions.json",
    });
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

  // the trigger minted on the direct-announce path must distinguish an
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

  it("persists the settled child's run tokens into the child's durable chain cost before dispatch", async () => {
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

  it("folds the child run cost into the live drain basis when the durable persist fails", async () => {
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

  it("treats a no-op child token persist as failed and folds the run cost", async () => {
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

  it("routes a delayed bracket delegate through the durable pending store, not a volatile timer", async () => {
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

  it("persists only the internal traceparent on durable delayed bracket delegates", async () => {
    const attackerTraceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
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
      traceparent: validTraceparent,
      roundOneReply: `Research result.\n[[CONTINUE_DELEGATE: keep working +30s | traceparent=${attackerTraceparent}]]`,
    });

    expect(enqueuePendingDelegateMock).toHaveBeenCalledTimes(1);
    expect(enqueuePendingDelegateMock.mock.calls[0]?.[1]).toMatchObject({
      task: "keep working",
      delayMs: 30_000,
      traceparent: validTraceparent,
      spawnRequesterSessionKey: "agent:main:main",
    });
    const enqueued = enqueuePendingDelegateMock.mock.calls[0]?.[1] as
      | { traceparent?: string }
      | undefined;
    expect(enqueued?.traceparent).not.toBe(attackerTraceparent);
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("persists inherited silent/wake policy on durable delayed bracket delegates", async () => {
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
});
