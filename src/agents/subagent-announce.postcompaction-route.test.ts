/**
 * Ensures a light-context post-compaction delegate marker is staged instead of
 * immediately chain-spawned. This announce-path coverage complements the main
 * reply staging test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks that DO intercept the SUT (non-barrel modules) ---

vi.mock("./subagents/announce/subagent-announce.runtime.js", async (importOriginal) => ({
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

vi.mock("./subagents/spawn/subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 1,
}));

vi.mock("./embedded-agent.js", () => ({
  isEmbeddedAgentRunActive: () => false,
  queueEmbeddedAgentMessage: () => false,
  waitForEmbeddedAgentRunEnd: async () => true,
}));

vi.mock("./subagents/registry/subagent-registry-read.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  countActiveDescendantRuns: () => 0,
  countPendingDescendantRuns: () => 0,
  countPendingDescendantRunsExcludingRun: () => 0,
  isSubagentSessionRunActive: () => true,
  listSubagentRunsForRequester: () => [],
  replaceSubagentRunAfterSteer: () => true,
  resolveRequesterForChildSession: () => null,
  shouldIgnorePostCompletionAnnounceForSession: () => false,
}));
vi.mock("./subagents/registry/subagent-registry-runtime.js", () => ({
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

vi.mock("../auto-reply/continuation/delegate-store-post-compaction.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../auto-reply/continuation/delegate-store-post-compaction.js")
    >();
  return {
    ...actual,
    failStagedPostCompactionDelegatesForCleanup: vi.fn(() => 0),
    stagePostCompactionDelegate: vi.fn(actual.stagePostCompactionDelegate),
  };
});

import { stagePostCompactionDelegate } from "../auto-reply/continuation/delegate-store-post-compaction.js";
import { resetDelegateStoreForTests } from "../auto-reply/continuation/delegate-store.js";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntriesCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { drainSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-runtime.test-helpers.js";
import { runSubagentAnnounceFlow } from "./subagents/announce/subagent-announce.js";
import * as subagentSpawn from "./subagents/spawn/subagent-spawn.js";

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
  const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
  const removals = listSessionEntriesCore({ agentId: "main", storePath }).map(({ sessionKey }) => ({
    sessionKey,
  }));
  if (removals.length > 0) {
    await applySessionEntryLifecycleMutation({ agentId: "main", storePath, removals });
  }
  for (const [sessionKey, entry] of Object.entries(data)) {
    const record = entry as SessionEntry;
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        ...record,
        sessionId: record.sessionId ?? `session-${sessionKey}`,
      },
    );
  }
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
    resetTaskFlowRegistryForTests({ persist: false });
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot: () => ({ flows: new Map() }),
        saveSnapshot: () => {},
        upsertFlow: () => {},
        deleteFlow: () => {},
      },
    });
    resetDelegateStoreForTests();
    const params = buildLeafParams("");
    await writeSessionStore({
      [params.childSessionKey]: { sessionId: "session-child", updatedAt: Date.now() },
      [params.requesterSessionKey]: { sessionId: "session-requester", updatedAt: Date.now() },
    });
    setRuntimeConfigSnapshot(makeConfig() as never);
    stageMock.mockClear();
    spawnSpy = vi.spyOn(subagentSpawn, "spawnSubagentDirect").mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:chain-next",
      runId: "run-chain-next",
    });
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    clearRuntimeConfigSnapshot();
    resetSystemEventsForTest();
    resetDelegateStoreForTests();
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("post-compaction bracket → stagePostCompactionDelegate, NOT chain-spawn (the lifeboat-drop fix)", async () => {
    const params = buildLeafParams("[[CONTINUE_DELEGATE: lifeboat leaf | post-compaction]]");
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    // The :995 fix: post-compaction routes to staging...
    expect(stageMock).toHaveBeenCalledTimes(1);
    // The staged TaskFlow remains child-owned until the post-compaction seam releases it.
    const stagedSessionKey = stageMock.mock.calls[0]?.[0];
    expect(stagedSessionKey).toBe("agent:main:subagent:postcompaction-route");
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
    // The event follows the same child-owned post-compaction queue.
    const events = drainSystemEventEntries("agent:main:subagent:postcompaction-route");
    const stagedEvent = events.find((e) =>
      (e.text ?? "").includes("[continuation:delegate-staged-post-compaction]"),
    );
    expect(stagedEvent).toBeDefined();
  });
});
