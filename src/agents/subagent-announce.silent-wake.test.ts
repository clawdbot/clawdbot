// "RFC §" references herein cite docs/design/continue-work-signal-v2.md (Agent Self-Elected Turn Continuation / CONTINUE_WORK).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentAnnounceDeliveryRuntimeMock } from "./subagent-announce.test-support.js";

// Pins the silent / silent-wake / wakeOnReturn announce routing
// at src/agents/subagent-announce.ts:604-634. RFC §2.3 calls this the
// specific fix for an observed six-minute stall — a canary-verified
// behavior that must have a pinning test.
//
// Behaviors pinned:
// 1. silentAnnounce:true, wakeOnReturn:true →
//    - deliverSubagentAnnouncement NOT invoked
//    - enqueueSystemEvent called with [continuation:enrichment-return] text + target session key
//    - requestHeartbeatNow called with reason:"continuation"
// 2. silentAnnounce:true, wakeOnReturn:false →
//    - deliverSubagentAnnouncement NOT invoked
//    - enqueueSystemEvent called (enrichment-return)
//    - requestHeartbeatNow NOT called
// 3. silentAnnounce:false →
//    - deliverSubagentAnnouncement invoked
//    - no enrichment-return event
//    - no heartbeat wake

const callGatewayMock = vi.fn(async (_request: unknown) => ({}));
const loadSessionStoreMock = vi.fn((_storePath: string) => ({}) as Record<string, unknown>);
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

const dispatchToolDelegatesMock = vi.fn(async (_params: unknown) => ({
  dispatched: 0,
  rejected: 0,
}));
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

// The silent/wake routing seam: these are dynamic-imported INSIDE the
// runSubagentAnnounceFlow body, so they must be mocked at module level
// for vi.mock to intercept the dynamic import.
const enqueueSystemEventMock = vi.fn((_text: string, _options?: unknown) => undefined);
const requestHeartbeatNowMock = vi.fn((_options: unknown) => undefined);

// Spy on the ordinary delivery path (not silent) so we can assert it
// is NOT called when silentAnnounce is true.
const deliverSubagentAnnouncementMock = vi.fn(async (_params: unknown) => ({
  delivered: true,
  path: "direct" as const,
}));

let mockConfig: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: { mainKey: "main", scope: "per-sender" },
};

const { subagentRegistryRuntimeMock } = vi.hoisted(() => ({
  subagentRegistryRuntimeMock: {
    shouldIgnorePostCompletionAnnounceForSession: vi.fn(() => false),
    isSubagentSessionRunActive: vi.fn(() => true),
    countActiveDescendantRuns: vi.fn(() => 0),
    countPendingDescendantRuns: vi.fn(() => 0),
    countPendingDescendantRunsExcludingRun: vi.fn(() => 0),
    listSubagentRunsForRequester: vi.fn(() => []),
    replaceSubagentRunAfterSteer: vi.fn(() => true),
    resolveRequesterForChildSession: vi.fn(() => null),
  },
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
  deliverSubagentAnnouncement: (params: unknown) => deliverSubagentAnnouncementMock(params),
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

vi.mock("../auto-reply/continuation/config.js", () => ({
  resolveContinuationRuntimeConfig: (cfg?: unknown) => resolveContinuationRuntimeConfigMock(cfg),
}));

// Dynamic-imported by the silent/wake branch. Both are intercepted at
// module-resolution time via vi.mock, so the dynamic import yields the
// mock implementation.
vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (text: string, options?: unknown) => enqueueSystemEventMock(text, options),
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  markTrustedContinuationHeartbeatWake: <T>(request: T) => request,
  requestHeartbeatNow: (options: unknown) => requestHeartbeatNowMock(options),
}));

import { runSubagentAnnounceFlow } from "./subagent-announce.js";

const childSessionKey = "agent:main:subagent:silent-test";
const requesterSessionKey = "agent:main:main";
const validTraceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

function seedDefaultStore() {
  loadSessionStoreMock.mockImplementation(
    () =>
      ({
        [childSessionKey]: {
          sessionId: "session-silent-child",
          updatedAt: Date.now(),
        },
        [requesterSessionKey]: {
          sessionId: "session-main",
          updatedAt: Date.now(),
        },
      }) as Record<string, unknown>,
  );
}

const baseParams = {
  childSessionKey,
  childRunId: "run-silent",
  requesterSessionKey,
  requesterDisplayKey: "main",
  task: "silent-wake routing fixture",
  timeoutMs: 100,
  cleanup: "delete" as const,
  waitForCompletion: false,
  startedAt: 10,
  endedAt: 20,
  outcome: { status: "ok" as const },
  roundOneReply: "done",
};

describe("subagent-announce silent / silent-wake / wakeOnReturn routing (RFC §2.3)", () => {
  beforeEach(() => {
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
    loadSessionStoreMock.mockReset();
    resolveAgentIdFromSessionKeyMock.mockReset().mockImplementation(() => "main");
    resolveStorePathMock.mockReset().mockImplementation(() => "/tmp/sessions.json");
    resolveMainSessionKeyMock.mockReset().mockImplementation(() => "agent:main:main");
    isEmbeddedAgentRunActiveMock.mockReset().mockReturnValue(false);
    queueEmbeddedAgentMessageMock.mockReset().mockReturnValue(false);
    waitForEmbeddedAgentRunEndMock.mockReset().mockResolvedValue(true);
    enqueueSystemEventMock.mockReset();
    requestHeartbeatNowMock.mockReset();
    deliverSubagentAnnouncementMock
      .mockReset()
      .mockResolvedValue({ delivered: true, path: "direct" });
    mockConfig = {
      agents: { defaults: { continuation: { enabled: true } } },
      session: { mainKey: "main", scope: "per-sender" },
    };
    subagentRegistryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession
      .mockReset()
      .mockReturnValue(false);
    subagentRegistryRuntimeMock.isSubagentSessionRunActive.mockReset().mockReturnValue(true);
    subagentRegistryRuntimeMock.countPendingDescendantRuns.mockReset().mockReturnValue(0);
    subagentRegistryRuntimeMock.listSubagentRunsForRequester.mockReset().mockReturnValue([]);
    subagentRegistryRuntimeMock.resolveRequesterForChildSession.mockReset().mockReturnValue(null);
  });

  it("silentAnnounce:true + wakeOnReturn:true → enqueues system event AND wakes parent", async () => {
    seedDefaultStore();

    const didAnnounce = await runSubagentAnnounceFlow({
      ...baseParams,
      silentAnnounce: true,
      wakeOnReturn: true,
      traceparent: validTraceparent,
    });

    expect(didAnnounce).toBe(true);

    // No channel delivery on the silent path.
    expect(deliverSubagentAnnouncementMock).not.toHaveBeenCalled();

    // System event delivered to the requester session.
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [eventText, eventOptions] = enqueueSystemEventMock.mock.calls[0] as [
      string,
      { sessionKey?: string; traceparent?: string } | undefined,
    ];
    expect(typeof eventText).toBe("string");
    expect(eventText.length).toBeGreaterThan(0);
    expect(eventOptions?.sessionKey).toBe(requesterSessionKey);
    expect(eventOptions?.traceparent).toBe(validTraceparent);

    // Heartbeat wake fired with delegate-return provenance.
    expect(requestHeartbeatNowMock).toHaveBeenCalledTimes(1);
    const wakeOptions = requestHeartbeatNowMock.mock.calls[0]?.[0] as {
      sessionKey?: string;
      reason?: string;
      parentRunId?: string;
    };
    expect(wakeOptions?.sessionKey).toBe(requesterSessionKey);
    expect(wakeOptions?.reason).toBe("silent-wake-enrichment");
    expect(wakeOptions?.parentRunId).toBe(baseParams.childRunId);
  });

  it("silentAnnounce:true + wakeOnReturn:false → enqueues system event but does NOT wake", async () => {
    seedDefaultStore();

    const didAnnounce = await runSubagentAnnounceFlow({
      ...baseParams,
      silentAnnounce: true,
      wakeOnReturn: false,
    });

    expect(didAnnounce).toBe(true);

    expect(deliverSubagentAnnouncementMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [, eventOptions] = enqueueSystemEventMock.mock.calls[0] as [
      string,
      { sessionKey?: string; traceparent?: string } | undefined,
    ];
    expect(eventOptions?.sessionKey).toBe(requesterSessionKey);
    expect(eventOptions?.traceparent).toBeUndefined();

    // Critical: no wake when wakeOnReturn is false.
    expect(requestHeartbeatNowMock).not.toHaveBeenCalled();
  });

  it("omits traceparent from silent returns when chain-step budget is exhausted", async () => {
    seedDefaultStore();
    resolveContinuationRuntimeConfigMock.mockReturnValue({
      enabled: true,
      defaultDelayMs: 15_000,
      minDelayMs: 5_000,
      maxDelayMs: 300_000,
      maxChainLength: 1,
      costCapTokens: 500_000,
      maxDelegatesPerTurn: 5,
      contextPressureThreshold: undefined,
    });

    await runSubagentAnnounceFlow({
      ...baseParams,
      task: "[continuation:chain-hop:1] capped silent return",
      silentAnnounce: true,
      wakeOnReturn: true,
      traceparent: validTraceparent,
    });

    const [, eventOptions] = enqueueSystemEventMock.mock.calls[0] as [
      string,
      { sessionKey?: string; traceparent?: string } | undefined,
    ];
    expect(eventOptions?.sessionKey).toBe(requesterSessionKey);
    expect(eventOptions?.traceparent).toBeUndefined();
  });

  it("silentAnnounce:true with omitted wakeOnReturn → enqueues system event but does NOT wake", async () => {
    // Defensive: a silent announce without an explicit wakeOnReturn must
    // not surprise-wake the parent. The default for wakeOnReturn is falsy.
    seedDefaultStore();

    const didAnnounce = await runSubagentAnnounceFlow({
      ...baseParams,
      silentAnnounce: true,
    });

    expect(didAnnounce).toBe(true);
    expect(deliverSubagentAnnouncementMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    expect(requestHeartbeatNowMock).not.toHaveBeenCalled();
  });

  it("silentAnnounce:true → system event text references the task label", async () => {
    seedDefaultStore();

    await runSubagentAnnounceFlow({
      ...baseParams,
      task: "unique-task-marker-RFC23",
      silentAnnounce: true,
      wakeOnReturn: true,
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [
      string,
      { sessionKey?: string } | undefined,
    ];
    // Either the explicit completion trigger message or the fallback
    // `[continuation:enrichment-return] Delegate completed: <task>` text
    // must contain the task label so the parent can identify the source.
    expect(eventText).toContain("unique-task-marker-RFC23");
  });

  it("silentAnnounce:false → ordinary delivery, no enrichment-return event, no wake", async () => {
    seedDefaultStore();

    await runSubagentAnnounceFlow({
      ...baseParams,
      silentAnnounce: false,
      wakeOnReturn: false,
      traceparent: validTraceparent,
    });

    // Ordinary delivery path runs.
    expect(deliverSubagentAnnouncementMock).toHaveBeenCalledTimes(1);
    expect(deliverSubagentAnnouncementMock).toHaveBeenCalledWith(
      expect.objectContaining({ traceparent: validTraceparent }),
    );

    // No silent-path side effects.
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatNowMock).not.toHaveBeenCalled();
  });

  it("silentAnnounce omitted → ordinary delivery, no silent-path side effects", async () => {
    // Defensive: missing silentAnnounce must behave identically to false.
    seedDefaultStore();

    await runSubagentAnnounceFlow(baseParams);

    expect(deliverSubagentAnnouncementMock).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatNowMock).not.toHaveBeenCalled();
  });
});
