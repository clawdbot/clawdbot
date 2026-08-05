/**
 * Ensures a light-context post-compaction delegate marker is staged instead of
 * immediately chain-spawned. This announce-path coverage complements the main
 * reply staging test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks that DO intercept the SUT (non-barrel modules) ---

vi.mock("./subagent-announce.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readSessionMessagesAsync: vi.fn(async () => []),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (request: Record<string, unknown>) => {
    if (request.method === "chat.history") {
      return { messages: [] };
    }
    return {};
  }),
}));

vi.mock("./subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 1,
}));

vi.mock("./embedded-agent.js", () => ({
  isEmbeddedAgentRunActive: () => false,
  queueEmbeddedAgentMessage: () => false,
  waitForEmbeddedAgentRunEnd: async () => true,
}));

vi.mock("./subagent-registry-runtime.js", () => ({
  countActiveDescendantRuns: () => 0,
  countPendingDescendantRuns: () => 0,
  countPendingDescendantRunsExcludingRun: () => 0,
  isSubagentSessionRunActive: () => true,
  listSubagentRunsForRequester: () => [],
  replaceSubagentRunAfterSteer: () => true,
  resolveRequesterForChildSession: () => null,
  shouldIgnorePostCompletionAnnounceForSession: () => false,
}));

vi.mock("../auto-reply/continuation/state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auto-reply/continuation/state.js")>()),
  registerContinuationTimerHandle: vi.fn(),
  retainContinuationTimerRef: vi.fn(),
  releaseContinuationTimerRef: vi.fn(),
  unregisterContinuationTimerHandle: vi.fn(),
}));

vi.mock("../auto-reply/continuation/delegate-store.js", () => ({
  annotateQueuedDelegatesChainTokensFold: vi.fn(() => 0),
  clearQueuedDelegatesChainTokensFold: vi.fn(() => 0),
  consumePendingDelegates: vi.fn(() => []),
  enqueuePendingDelegate: vi.fn(),
  hasRecoverablePendingDelegate: vi.fn(() => false),
  markPendingDelegateFailed: vi.fn(),
  markPendingDelegateSpawnAccepted: vi.fn(),
  peekSoonestUnmaturedDelegateDueAt: vi.fn(() => undefined),
}));

vi.mock("../auto-reply/continuation/delegate-store-post-compaction.js", () => ({
  failStagedPostCompactionDelegatesForCleanup: vi.fn(() => 0),
  stagePostCompactionDelegate: vi.fn(),
}));

import { stagePostCompactionDelegate } from "../auto-reply/continuation/delegate-store-post-compaction.js";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resolveStorePath } from "../config/sessions.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { saveLegacySessionStore as saveSessionStore } from "../infra/state-migrations.legacy-session-store.js";
import { drainSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";
import { runSubagentAnnounceFlow } from "./subagent-announce.js";
import * as subagentSpawn from "./subagent-spawn.js";

type AnnounceFlowParams = Parameters<typeof runSubagentAnnounceFlow>[0];

function makeConfig() {
  return {
    session: { mainKey: "main", scope: "per-sender" as const },
    agents: {
      defaults: {
        continuation: {
          enabled: true,
          maxChainLength: 10,
          costCapTokens: 500_000,
          minDelayMs: 0,
          maxDelayMs: 0,
          crossSessionTargeting: "disabled" as const,
        },
      },
    },
  };
}

async function writeSessionStore(data: Record<string, unknown>) {
  const storePath = resolveStorePath(undefined, { agentId: "main" });
  await saveSessionStore(storePath, data as Parameters<typeof saveSessionStore>[1], {
    skipMaintenance: true,
  });
  clearSessionStoreCacheForTest();
}

function buildLeafParams(bracket: string): AnnounceFlowParams {
  return {
    childSessionKey: "agent:main:subagent:postcompaction-route",
    childRunId: "run-postcompaction-route",
    requesterSessionKey: "agent:main:discord:dm:test-route",
    requesterDisplayKey: "test-route",
    task: "[continuation:chain-hop:1] Delegated task: leaf research",
    roundOneReply: `Research result.\n${bracket}`,
    timeoutMs: 30_000,
    cleanup: "delete",
    outcome: { status: "ok" as const },
    silentAnnounce: true,
    wakeOnReturn: true,
  };
}

describe("announce-path post-compaction routing", () => {
  let spawnSpy: ReturnType<typeof vi.spyOn>;
  const stageMock = vi.mocked(stagePostCompactionDelegate);

  beforeEach(async () => {
    await writeSessionStore({});
    setRuntimeConfigSnapshot(makeConfig() as never);
    stageMock.mockReset();
    spawnSpy = vi.spyOn(subagentSpawn, "spawnSubagentDirect").mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:chain-next",
      runId: "run-chain-next",
    });
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    clearRuntimeConfigSnapshot();
    clearSessionStoreCacheForTest();
    resetSystemEventsForTest();
  });

  it("post-compaction bracket → stagePostCompactionDelegate, NOT chain-spawn (the lifeboat-drop fix)", async () => {
    const params = buildLeafParams("[[CONTINUE_DELEGATE: lifeboat leaf | post-compaction]]");
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    // The :995 fix: post-compaction routes to staging...
    expect(stageMock).toHaveBeenCalledTimes(1);
    // ...under the REQUESTER (parent) session key — NOT the leaf's childSessionKey.
    // This is the documented semantic-timing limitation (Emeric/Ronan byte): the
    // announce path catches the bracket on the LEAF's COMPLETION, when the leaf
    // is already terminating, so the lifeboat can only stage under the parent's
    // session (consumed at the PARENT's next compaction, not the leaf's own).
    // Caught-on-completion != staged-in-turn — doc names this. Asserting
    // the sessionKey here pins the behavior so a future change is visible.
    const stagedSessionKey = stageMock.mock.calls[0]?.[0];
    expect(stagedSessionKey).toBe("agent:main:discord:dm:test-route"); // requesterSessionKey
    expect(stagedSessionKey).not.toBe("agent:main:subagent:postcompaction-route"); // NOT childSessionKey
    const stagedArg = stageMock.mock.calls[0]?.[1] as { task?: string };
    expect(stagedArg.task).toContain("lifeboat leaf");
    // ...AND the normal chain-spawn is NOT taken (mutual exclusion).
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("post-compaction + target threads targetSessionKey into the staged payload", async () => {
    const params = buildLeafParams(
      "[[CONTINUE_DELEGATE: targeted lifeboat | target=agent:main:other | post-compaction]]",
    );
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(stageMock).toHaveBeenCalledTimes(1);
    const stagedArg = stageMock.mock.calls[0]?.[1] as { targetSessionKey?: string };
    expect(stagedArg.targetSessionKey).toBe("agent:main:other");
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("normal bracket (no post-compaction) → chain-spawn, NOT staged (the inverse / mutual-exclusion)", async () => {
    const params = buildLeafParams("[[CONTINUE_DELEGATE: normal leaf hop]]");
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(stageMock).not.toHaveBeenCalled();
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it("post-compaction bracket enqueues the delegate-staged-post-compaction system event", async () => {
    const params = buildLeafParams("[[CONTINUE_DELEGATE: event-probe leaf | post-compaction]]");
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(stageMock).toHaveBeenCalledTimes(1);
    // The staged event is enqueued under the requester session key.
    const events = drainSystemEventEntries("agent:main:discord:dm:test-route");
    const stagedEvent = events.find((e) =>
      (e.text ?? "").includes("[continuation:delegate-staged-post-compaction]"),
    );
    expect(stagedEvent).toBeDefined();
  });
});
