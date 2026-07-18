import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPendingSessionDeliveries } from "../infra/session-delivery-queue-storage.js";
import type { QueuedSessionDelivery } from "../infra/session-delivery-queue-storage.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";
import { withTempDir } from "../test-helpers/temp-dir.js";

const runtimeLogMock = vi.hoisted(() => vi.fn());
const runtimeErrorMock = vi.hoisted(() => vi.fn());
const requestHeartbeatNowMock = vi.hoisted(() => vi.fn());
const allSessionKeysMock = vi.hoisted(() => vi.fn(() => [] as string[]));
const requesterDepthMock = vi.hoisted(() => vi.fn(() => 0));

const registryRuntimeMock = vi.hoisted(() => ({
  shouldIgnorePostCompletionAnnounceForSession: vi.fn(() => false),
  isSubagentSessionRunActive: vi.fn(() => true),
  countActiveDescendantRuns: vi.fn(() => 0),
  countPendingDescendantRuns: vi.fn(() => 0),
  countPendingDescendantRunsExcludingRun: vi.fn(() => 0),
  listAncestorSessionKeys: vi.fn((_sessionKey: string): string[] => []),
  listSubagentRunsForRequester: vi.fn(() => []),
  replaceSubagentRunAfterSteer: vi.fn(() => true),
  resolveRequesterForChildSession: vi.fn(() => null),
}));

let mockConfig: OpenClawConfig = {
  agents: { defaults: { continuation: { enabled: true } } },
  session: { mainKey: "main", scope: "per-sender" },
};
let mockCrossSessionTargeting: "disabled" | "enabled" = "disabled";

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: (...args: unknown[]) => runtimeLogMock(...args),
    error: (...args: unknown[]) => runtimeErrorMock(...args),
  },
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  markTrustedContinuationHeartbeatWake: <T>(request: T) => request,
  requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
}));

vi.mock("../config/sessions/targets.js", () => ({
  resolveAllAgentSessionStoreTargetsSync: () => [{ storePath: "/tmp/targeted-return-all.json" }],
}));

vi.mock("../config/sessions/store-load.js", () => ({
  loadSessionStore: () =>
    Object.fromEntries(allSessionKeysMock().map((sessionKey: string) => [sessionKey, {}])),
}));

vi.mock("./subagent-announce.runtime.js", () => ({
  callGateway: vi.fn(async () => ({})),
  dispatchGatewayMethodInProcess: vi.fn(async () => ({})),
  getRuntimeConfig: () => mockConfig,
  isEmbeddedAgentRunActive: () => false,
  loadSessionStore: () => ({}),
  readSessionMessagesAsync: vi.fn(async () => []),
  readSessionEntry: () => undefined,
  resolveAgentIdFromSessionKey: (sessionKey: string) =>
    sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main",
  resolveContinuationRuntimeConfig: (_cfg?: unknown) => ({
    enabled: true,
    defaultDelayMs: 15_000,
    minDelayMs: 5_000,
    maxDelayMs: 300_000,
    maxChainLength: 10,
    costCapTokens: 500_000,
    maxDelegatesPerTurn: 5,
    contextPressureThreshold: undefined,
    crossSessionTargeting: mockCrossSessionTargeting,
  }),
  resolveStorePath: () => "/tmp/sessions.json",
  waitForEmbeddedAgentRunEnd: vi.fn(async () => true),
}));

vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: async () => ({ delivered: true, path: "direct" }),
  loadRequesterSessionEntry: (sessionKey: string) => ({
    entry: {
      sessionId: `session-${sessionKey}`,
      updatedAt: Date.now(),
    },
  }),
  loadSessionEntryByKey: (sessionKey: string) => ({
    sessionId: `session-${sessionKey}`,
    updatedAt: Date.now(),
  }),
  resolveAnnounceOrigin: (
    _entry: unknown,
    requesterOrigin?: { channel?: string; to?: string; accountId?: string; threadId?: string },
  ) => requesterOrigin ?? {},
  resolveSubagentCompletionOrigin: async (params: { requesterOrigin?: unknown }) =>
    params.requesterOrigin,
  resolveSubagentAnnounceTimeoutMs: () => 10_000,
  runAnnounceDeliveryWithRetry: async <T>(params: { run: () => Promise<T> }) => await params.run(),
}));

vi.mock("./subagent-announce.registry.runtime.js", () => registryRuntimeMock);

vi.mock("./subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: (...args: unknown[]) => requesterDepthMock(...args),
}));

const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");

async function readQueuedSystemEventDeliveries(stateDir: string): Promise<QueuedSessionDelivery[]> {
  return loadPendingSessionDeliveries(stateDir);
}

describe("subagent announce targeted continuation return integration", () => {
  beforeEach(() => {
    runtimeLogMock.mockReset();
    runtimeErrorMock.mockReset();
    requestHeartbeatNowMock.mockReset();
    requesterDepthMock.mockReset().mockReturnValue(0);
    resetSystemEventsForTest();
    mockConfig = {
      agents: { defaults: { continuation: { enabled: true } } },
      session: { mainKey: "main", scope: "per-sender" },
    };
    mockCrossSessionTargeting = "disabled";
    allSessionKeysMock.mockReset().mockReturnValue([]);
    registryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession
      .mockReset()
      .mockReturnValue(false);
    registryRuntimeMock.isSubagentSessionRunActive.mockReset().mockReturnValue(true);
    registryRuntimeMock.countPendingDescendantRuns.mockReset().mockReturnValue(0);
    registryRuntimeMock.listAncestorSessionKeys.mockReset().mockReturnValue([]);
    registryRuntimeMock.listSubagentRunsForRequester.mockReset().mockReturnValue([]);
    registryRuntimeMock.resolveRequesterForChildSession.mockReset().mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetSystemEventsForTest();
  });

  it("writes queue file, logs targeted-return, and drains the recipient System context", async () => {
    await withTempDir({ prefix: "openclaw-targeted-return-runtime-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const nonce = "TARGETED-RUNTIME-PATH-NONCE-580";
      const targetSessionKey = "agent:main:recipient-runtime";

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:runtime-path",
        childRunId: "run-targeted-runtime-path",
        requesterSessionKey: "agent:main:dispatcher-runtime",
        requesterDisplayKey: "dispatcher-runtime",
        task: `[continuation:chain-hop:1] targeted return ${nonce}`,
        timeoutMs: 100,
        cleanup: "keep",
        waitForCompletion: false,
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
        roundOneReply: `delegate completed with ${nonce}`,
        silentAnnounce: true,
        wakeOnReturn: true,
        continuationTargetSessionKey: targetSessionKey,
      });

      expect(runtimeErrorMock.mock.calls).toEqual([]);
      expect(didAnnounce).toBe(true);

      const queuedDeliveries = await loadPendingSessionDeliveries(stateDir);
      expect(queuedDeliveries).toHaveLength(1);

      const persisted = expectDefined(queuedDeliveries.at(0), "queued delivery");
      if (persisted.kind !== "systemEvent") {
        throw new Error(`expected systemEvent delivery, received ${persisted.kind}`);
      }
      expect(persisted.sessionKey).toBe(targetSessionKey);
      expect(persisted.text).toContain(nonce);

      expect(runtimeLogMock).toHaveBeenCalledWith(
        expect.stringContaining(`[continuation:targeted-return] Delivered to ${targetSessionKey}`),
      );

      expect(peekSystemEventEntries(targetSessionKey)).toHaveLength(1);
      const promptContext = await drainFormattedSystemEvents({
        cfg: mockConfig,
        sessionKey: targetSessionKey,
        isMainSession: false,
        isNewSession: false,
      });
      expect(promptContext).toContain("System:");
      expect(promptContext).toContain("[Internal task completion event]");
      expect(promptContext).toContain(nonce);
      expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: targetSessionKey,
          reason: "delegate-return",
          parentRunId: "run-targeted-runtime-path",
        }),
      );
    });
  });

  it("routes an explicit return past an inactive cleaned internal requester", async () => {
    await withTempDir(
      { prefix: "openclaw-targeted-return-inactive-explicit-" },
      async (stateDir) => {
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        const nonce = "TARGETED-INACTIVE-EXPLICIT-NONCE-581";
        // A cron key is unambiguously internal without relying on depth-store
        // fixture state, so this executes the inactive-requester guard.
        const requesterSessionKey = "agent:main:cron:cleaned-explicit-requester";
        const targetSessionKey = "agent:main:recipient-explicit-after-cleanup";
        registryRuntimeMock.isSubagentSessionRunActive.mockReturnValueOnce(false);
        registryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession.mockImplementation(
          (sessionKey: string) => sessionKey === requesterSessionKey,
        );

        const didAnnounce = await runSubagentAnnounceFlow({
          childSessionKey: "agent:main:subagent:explicit-after-cleanup",
          childRunId: "run-targeted-inactive-explicit",
          requesterSessionKey,
          requesterDisplayKey: "cleaned-explicit-requester",
          task: `[continuation:chain-hop:1] explicit return ${nonce}`,
          timeoutMs: 100,
          cleanup: "keep",
          waitForCompletion: false,
          startedAt: 10,
          endedAt: 20,
          outcome: { status: "ok" },
          roundOneReply: `delegate completed with ${nonce}`,
          silentAnnounce: true,
          wakeOnReturn: true,
          continuationTargetSessionKey: targetSessionKey,
        });

        expect(didAnnounce).toBe(true);
        const queued = await loadPendingSessionDeliveries(stateDir);
        expect(queued).toHaveLength(1);
        expect(queued.at(0)).toEqual(expect.objectContaining({ sessionKey: targetSessionKey }));
        expect(peekSystemEventEntries(requesterSessionKey)).toHaveLength(0);
        expect(peekSystemEventEntries(targetSessionKey)).toHaveLength(1);
      },
    );
  });

  it("delivers fanoutMode=tree returns after its inactive intermediate requester was cleaned up", async () => {
    await withTempDir({ prefix: "openclaw-targeted-return-tree-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const nonce = "TREE-TARGETED-RETURN-NONCE-641";
      const requesterSessionKey = "agent:main:subagent:dispatcher-tree";
      const rootSessionKey = "agent:main:root-tree";
      registryRuntimeMock.listAncestorSessionKeys.mockReturnValueOnce([
        requesterSessionKey,
        rootSessionKey,
      ]);
      registryRuntimeMock.isSubagentSessionRunActive.mockReturnValueOnce(false);
      registryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession.mockImplementation(
        (sessionKey: string) => sessionKey === requesterSessionKey,
      );

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:tree-return",
        childRunId: "run-tree-targeted-return",
        requesterSessionKey,
        requesterDisplayKey: "dispatcher-tree",
        task: `[continuation:chain-hop:1] tree return ${nonce}`,
        timeoutMs: 100,
        cleanup: "keep",
        waitForCompletion: false,
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
        roundOneReply: `delegate completed with ${nonce}`,
        silentAnnounce: true,
        wakeOnReturn: true,
        continuationFanoutMode: "tree",
      });

      expect(runtimeErrorMock.mock.calls).toEqual([]);
      expect(didAnnounce).toBe(true);
      expect(registryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession).toHaveBeenCalledWith(
        requesterSessionKey,
      );
      expect(registryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession).toHaveBeenCalledWith(
        rootSessionKey,
      );
      expect(registryRuntimeMock.listAncestorSessionKeys).toHaveBeenCalledWith(requesterSessionKey);

      const persisted = await readQueuedSystemEventDeliveries(stateDir);
      expect(persisted).toHaveLength(1);
      expect(persisted.map((entry) => entry.sessionKey)).toEqual([rootSessionKey]);
      for (const entry of persisted) {
        expect(entry.kind).toBe("systemEvent");
        if (entry.kind === "systemEvent") {
          expect(entry.text).toContain(nonce);
        }
      }

      for (const sessionKey of [rootSessionKey]) {
        expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
        expect(
          expectDefined(peekSystemEventEntries(sessionKey).at(0), "system event").text,
        ).toContain(nonce);
      }
      expect(requestHeartbeatNowMock).toHaveBeenCalledTimes(1);
      expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: rootSessionKey,
          reason: "delegate-return",
          parentRunId: "run-tree-targeted-return",
        }),
      );
      expect(runtimeLogMock).toHaveBeenCalledWith(
        expect.stringContaining(`[continuation:targeted-return] Delivered to ${rootSessionKey}`),
      );
    });
  });

  it("does not reopen a cleaned explicit return target", async () => {
    await withTempDir(
      { prefix: "openclaw-targeted-return-explicit-cleaned-" },
      async (stateDir) => {
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        const requesterSessionKey = "agent:main:subagent:explicit-cleaned";
        registryRuntimeMock.isSubagentSessionRunActive.mockReturnValueOnce(false);
        registryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession.mockImplementation(
          (sessionKey: string) => sessionKey === requesterSessionKey,
        );

        const didAnnounce = await runSubagentAnnounceFlow({
          childSessionKey: "agent:main:subagent:explicit-cleaned-child",
          childRunId: "run-explicit-cleaned-return",
          requesterSessionKey,
          requesterDisplayKey: "explicit-cleaned",
          task: "[continuation:chain-hop:1] explicit cleaned target",
          timeoutMs: 100,
          cleanup: "keep",
          waitForCompletion: false,
          startedAt: 10,
          endedAt: 20,
          outcome: { status: "ok" },
          roundOneReply: "delegate completed",
          silentAnnounce: true,
          wakeOnReturn: true,
          continuationTargetSessionKey: requesterSessionKey,
        });

        expect(didAnnounce).toBe(true);
        expect(await readQueuedSystemEventDeliveries(stateDir)).toHaveLength(0);
        expect(peekSystemEventEntries(requesterSessionKey)).toHaveLength(0);
        expect(requestHeartbeatNowMock).not.toHaveBeenCalled();
      },
    );
  });

  it("does not reopen cleaned recipients from an all-fanout return", async () => {
    await withTempDir({ prefix: "openclaw-targeted-return-all-cleaned-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const requesterSessionKey = "agent:main:subagent:all-cleaned";
      const liveSessionKey = "agent:main:root:all-live";
      allSessionKeysMock.mockReturnValue([requesterSessionKey, liveSessionKey]);
      registryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession.mockImplementation(
        (sessionKey: string) => sessionKey === requesterSessionKey,
      );

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:all-cleaned-child",
        childRunId: "run-all-cleaned-return",
        requesterSessionKey,
        requesterDisplayKey: "all-cleaned",
        task: "[continuation:chain-hop:1] all cleaned target",
        timeoutMs: 100,
        cleanup: "keep",
        waitForCompletion: false,
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
        roundOneReply: "delegate completed",
        silentAnnounce: true,
        wakeOnReturn: true,
        continuationFanoutMode: "all",
      });

      expect(didAnnounce).toBe(true);
      expect(
        (await readQueuedSystemEventDeliveries(stateDir)).map((entry) => entry.sessionKey),
      ).toEqual([liveSessionKey]);
      expect(peekSystemEventEntries(requesterSessionKey)).toEqual([]);
      expect(peekSystemEventEntries(liveSessionKey)).toHaveLength(1);
      expect(requestHeartbeatNowMock).toHaveBeenCalledTimes(1);
      expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: liveSessionKey }),
      );
    });
  });

  it("does not reopen a cleaned requester on the default silent-return path", async () => {
    await withTempDir({ prefix: "openclaw-targeted-return-default-cleaned-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const requesterSessionKey = "agent:main:subagent:default-cleaned";
      registryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession.mockImplementation(
        (sessionKey: string) => sessionKey === requesterSessionKey,
      );

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:default-cleaned-child",
        childRunId: "run-default-cleaned-return",
        requesterSessionKey,
        requesterDisplayKey: "default-cleaned",
        task: "ordinary silent return",
        timeoutMs: 100,
        cleanup: "keep",
        waitForCompletion: false,
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
        roundOneReply: "delegate completed",
        silentAnnounce: true,
        wakeOnReturn: true,
      });

      expect(didAnnounce).toBe(true);
      expect(await readQueuedSystemEventDeliveries(stateDir)).toEqual([]);
      expect(peekSystemEventEntries(requesterSessionKey)).toEqual([]);
      expect(requestHeartbeatNowMock).not.toHaveBeenCalled();
    });
  });

  it("does not fall back to a cleaned requester when every tree recipient is filtered", async () => {
    await withTempDir({ prefix: "openclaw-targeted-return-empty-tree-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const requesterSessionKey = "agent:main:subagent:cleaned-tree";
      registryRuntimeMock.listAncestorSessionKeys.mockReturnValueOnce([requesterSessionKey]);
      registryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession.mockReturnValueOnce(true);

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:empty-tree-return",
        childRunId: "run-empty-tree-targeted-return",
        requesterSessionKey,
        requesterDisplayKey: "cleaned-tree",
        task: "[continuation:chain-hop:1] empty filtered tree",
        timeoutMs: 100,
        cleanup: "keep",
        waitForCompletion: false,
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
        roundOneReply: "delegate completed",
        silentAnnounce: true,
        wakeOnReturn: true,
        continuationFanoutMode: "tree",
      });

      expect(didAnnounce).toBe(true);
      expect(await readQueuedSystemEventDeliveries(stateDir)).toEqual([]);
      expect(peekSystemEventEntries(requesterSessionKey)).toEqual([]);
      expect(requestHeartbeatNowMock).not.toHaveBeenCalled();
      expect(runtimeLogMock).toHaveBeenCalledWith(
        expect.stringContaining("[continuation:targeted-return] Delivered to  from"),
      );
    });
  });

  it("delivers post-compaction fanoutMode=tree returns like normal tree returns", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-tree-return-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const nonce = "POST-COMPACTION-TREE-RETURN-NONCE-642";
      const requesterSessionKey = "agent:main:post-compacted";
      const rootSessionKey = "agent:main:post-root";
      registryRuntimeMock.listAncestorSessionKeys.mockReturnValueOnce([
        requesterSessionKey,
        rootSessionKey,
      ]);

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:post-compaction-tree",
        childRunId: "run-post-compaction-tree-return",
        requesterSessionKey,
        requesterDisplayKey: "post-compacted",
        task:
          `[continuation:post-compaction] ` +
          `[continuation:chain-hop:1] carry compacted state ${nonce}`,
        timeoutMs: 100,
        cleanup: "keep",
        waitForCompletion: false,
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
        roundOneReply: `post-compaction delegate completed with ${nonce}`,
        silentAnnounce: true,
        wakeOnReturn: true,
        continuationFanoutMode: "tree",
      });

      expect(runtimeErrorMock.mock.calls).toEqual([]);
      expect(didAnnounce).toBe(true);

      const persisted = await readQueuedSystemEventDeliveries(stateDir);
      expect(persisted).toHaveLength(2);
      expect(persisted.map((entry) => entry.sessionKey).toSorted()).toEqual([
        requesterSessionKey,
        rootSessionKey,
      ]);
      for (const sessionKey of [requesterSessionKey, rootSessionKey]) {
        expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
        expect(
          expectDefined(peekSystemEventEntries(sessionKey).at(0), "system event").text,
        ).toContain(nonce);
      }
      expect(requestHeartbeatNowMock).toHaveBeenCalledTimes(2);
    });
  });
});
