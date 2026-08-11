/**
 * Tests for announce-side chain guard (maxChainLength enforcement).
 * Verifies [continuation:chain-hop:N] task-prefix tracking using the repo's
 * max-depth convention: a shard already at hop N cannot spawn hop N+1 when
 * maxChainLength is N.
 *
 * Coverage gap from CODEWALK.md: "No existing test for announce-side chain guard"
 */
import { expectDefined } from "@openclaw/normalization-core";
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

vi.mock("../auto-reply/continuation/delegate-store.js", () => ({
  annotateQueuedDelegatesChainTokensFold: vi.fn(() => 0),
  clearQueuedDelegatesChainTokensFold: vi.fn(() => 0),
  consumePendingDelegates: vi.fn(() => []),
  enqueuePendingDelegate: vi.fn(),
  hasRecoverablePendingDelegate: vi.fn(() => false),
  markPendingDelegateFailed: vi.fn(),
  markPendingDelegateSpawnAccepted: vi.fn(),
  peekEarliestQueuedDelegateDueAt: vi.fn(() => undefined),
  revalidatePendingDelegateForSpawn: vi.fn(() => ({ allowed: true })),
}));

vi.mock("../auto-reply/continuation/delegate-store-post-compaction.js", () => ({
  failStagedPostCompactionDelegatesForCleanup: vi.fn(() => 0),
  stagePostCompactionDelegate: vi.fn(),
}));

import { stagePostCompactionDelegate } from "../auto-reply/continuation/delegate-store-post-compaction.js";
import {
  consumePendingDelegates,
  markPendingDelegateFailed,
} from "../auto-reply/continuation/delegate-store.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntriesCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { drainSystemEventEntries } from "../infra/system-events.js";
import { runSubagentAnnounceFlow } from "./subagents/announce/subagent-announce.js";
import * as subagentSpawn from "./subagents/spawn/subagent-spawn.js";

type AnnounceFlowParams = Parameters<typeof runSubagentAnnounceFlow>[0];

function makeConfig(
  overrides: {
    maxChainLength?: number;
    costCapTokens?: number;
    enabled?: boolean;
    crossSessionTargeting?: "disabled" | "enabled";
  } = {},
): OpenClawConfig {
  return {
    session: { mainKey: "main", scope: "per-sender" as const },
    agents: {
      defaults: {
        continuation: {
          enabled: overrides.enabled ?? true,
          maxChainLength: overrides.maxChainLength ?? 10,
          costCapTokens: overrides.costCapTokens ?? 500_000,
          minDelayMs: 0,
          maxDelayMs: 0, // zero delay to avoid timer issues
          crossSessionTargeting: overrides.crossSessionTargeting ?? "disabled",
        },
      },
    },
  };
}

/**
 * Seed session data through the SQLite-backed session-store facade.
 * vitest 4.x forks pool doesn't intercept vi.mock for barrel re-exports
 * (config.js -> io.js, sessions.js -> store.js) so we use the real store
 * instead of a module mock.
 */
async function writeSessionStore(data: Record<string, unknown>) {
  const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
  const removals = listSessionEntriesCore({ agentId: "main", storePath }).map(({ sessionKey }) => ({
    sessionKey,
  }));
  if (removals.length > 0) {
    await applySessionEntryLifecycleMutation({ agentId: "main", storePath, removals });
  }
  for (const [sessionKey, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    await replaceSessionEntry({ agentId: "main", sessionKey, storePath }, {
      ...record,
      sessionId:
        typeof record.sessionId === "string" && record.sessionId.trim()
          ? record.sessionId
          : `session-${sessionKey}`,
    } as SessionEntry);
  }
}

function buildChainShardParams(hopIndex: number): AnnounceFlowParams {
  const taskPrefix = hopIndex > 0 ? `[continuation:chain-hop:${hopIndex}] ` : "";
  return {
    childSessionKey: `agent:main:subagent:shard-hop-${hopIndex}`,
    childRunId: `run-hop-${hopIndex}`,
    requesterSessionKey: "agent:main:discord:dm:test-chain",
    requesterDisplayKey: "test-chain",
    task: `${taskPrefix}Delegated task: do research`,
    roundOneReply: `Research result.\n[[CONTINUE_DELEGATE: continue next step]]`,
    timeoutMs: 30_000,
    cleanup: "delete",
    outcome: { status: "ok" as const },
    silentAnnounce: true,
    wakeOnReturn: true,
  };
}

describe("announce-side chain guard (maxChainLength enforcement)", () => {
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // Write empty session store so loadSessionEntryByKey finds no entries
    await writeSessionStore({});
    setRuntimeConfigSnapshot(makeConfig());
    spawnSpy = vi.spyOn(subagentSpawn, "spawnSubagentDirect").mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:chain-next",
      runId: "run-chain-next",
    });
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    clearRuntimeConfigSnapshot();
  });

  it("allows chain hop when nextChainHop <= maxChainLength", async () => {
    const params = buildChainShardParams(5);
    await runSubagentAnnounceFlow(params);
    // Fire-and-forget spawn: flush microtasks
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.task).toContain("[continuation:chain-hop:6]");
  });

  it("allows chain hop when the next shard reaches the configured boundary", async () => {
    const params = buildChainShardParams(9);
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.task).toContain("[continuation:chain-hop:10]");
  });

  it("blocks chain hop once the completing shard already occupies maxChainLength", async () => {
    const params = buildChainShardParams(10);
    await runSubagentAnnounceFlow(params);

    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("blocks chain hop well beyond maxChainLength", async () => {
    const params = buildChainShardParams(15);
    await runSubagentAnnounceFlow(params);

    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("allows first bracket-started hop (no prefix → hop 0)", async () => {
    const params = buildChainShardParams(0);
    params.task = "Delegated task: do research";
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.task).toContain("[continuation:chain-hop:1]");
  });

  it("rejects child-emitted bracket fanout=all when cross-session targeting is disabled", async () => {
    const params = buildChainShardParams(1);
    params.roundOneReply =
      "Research result.\n[[CONTINUE_DELEGATE: inspect all sessions | fanout=all]]";
    drainSystemEventEntries(params.requesterSessionKey);

    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(drainSystemEventEntries(params.requesterSessionKey).map((entry) => entry.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("cross-session targeting is disabled by policy"),
      ]),
    );
  });

  it("allows child-emitted bracket fanout=tree when cross-session targeting is disabled", async () => {
    const params = buildChainShardParams(1);
    params.roundOneReply = "Research result.\n[[CONTINUE_DELEGATE: inspect tree | fanout=tree]]";

    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.continuationFanoutMode).toBe("tree");
  });

  it("respects custom maxChainLength from config at the exact boundary", async () => {
    setRuntimeConfigSnapshot(makeConfig({ maxChainLength: 3 }));

    const params = buildChainShardParams(2);
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.task).toContain("[continuation:chain-hop:3]");
  });

  it("respects custom maxChainLength from config after the boundary is reached", async () => {
    setRuntimeConfigSnapshot(makeConfig({ maxChainLength: 3 }));

    const params = buildChainShardParams(3);
    await runSubagentAnnounceFlow(params);

    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("allows continuation when accumulated tokens equal costCapTokens exactly (> not >=)", async () => {
    await writeSessionStore({
      "agent:main:main": {
        sessionId: "test",
        updatedAt: Date.now(),
        continuationChainTokens: 500_000,
      },
    });

    const params = buildChainShardParams(1);
    params.requesterSessionKey = "agent:main:main";
    params.requesterDisplayKey = "main";
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects continuation when accumulated tokens exceed costCapTokens by one", async () => {
    await writeSessionStore({
      "agent:main:main": {
        sessionId: "test",
        updatedAt: Date.now(),
        continuationChainTokens: 500_001,
      },
    });

    const params = buildChainShardParams(1);
    params.requesterSessionKey = "agent:main:main";
    params.requesterDisplayKey = "main";
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tool-delegate chain guard (nextToolHop > toolMaxChainLength)
// ---------------------------------------------------------------------------

/**
 * Build params for a tool-delegate chain guard test.
 * The roundOneReply has NO bracket [[CONTINUE_DELEGATE:...]] so the bracket
 * path stays dormant and only tool delegates (from consumePendingDelegates)
 * are evaluated. The current chain hop is seeded through the durable SQLite
 * session owner used by the production drain.
 */
async function buildToolDelegateParams(hopIndex: number): Promise<AnnounceFlowParams> {
  const params: AnnounceFlowParams = {
    childSessionKey: `agent:main:subagent:tool-hop-${hopIndex}`,
    childRunId: `run-tool-hop-${hopIndex}`,
    requesterSessionKey: "agent:main:discord:dm:test-chain",
    requesterDisplayKey: "test-chain",
    task: "Tool-delegated from sub-agent (depth 1): do research",
    roundOneReply: "Research complete.", // no bracket delegate
    timeoutMs: 30_000,
    cleanup: "delete",
    outcome: { status: "ok" as const },
    silentAnnounce: true,
    wakeOnReturn: true,
  };
  await writeSessionStore({
    [params.childSessionKey]: {
      continuationChainCount: hopIndex,
      continuationChainStartedAt: Date.now(),
      continuationChainTokens: 0,
    },
  });
  return params;
}

const mockedConsumePendingDelegates = vi.mocked(consumePendingDelegates);
const mockedMarkPendingDelegateFailed = vi.mocked(markPendingDelegateFailed);

describe("tool-delegate chain guard (nextToolHop > toolMaxChainLength)", () => {
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await writeSessionStore({});
    setRuntimeConfigSnapshot(makeConfig({ maxChainLength: 10 }));
    spawnSpy = vi.spyOn(subagentSpawn, "spawnSubagentDirect").mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:tool-chain-next",
      runId: "run-tool-chain-next",
    });
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    mockedConsumePendingDelegates.mockReturnValue([]);
    mockedMarkPendingDelegateFailed.mockClear();
    clearRuntimeConfigSnapshot();
  });

  it("allows tool delegate at maxChainLength-1 (next hop = maxChainLength)", async () => {
    // childChainHop=9, bracketConsumedHop=0, toolHopBase=9, nextToolHop=10 = maxChainLength → allowed
    mockedConsumePendingDelegates.mockReturnValueOnce([
      { task: "tool task at boundary minus one" },
    ]);

    const params = await buildToolDelegateParams(9);
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.task).toContain("[continuation:chain-hop:10]");
    expect(spawnArgs.task).toContain("Delegated task");
  });

  it("rejects child tool-delegate fanout=all when cross-session targeting is disabled", async () => {
    mockedConsumePendingDelegates.mockReturnValueOnce([
      { task: "tool task for all", fanoutMode: "all" },
    ]);
    const params = await buildToolDelegateParams(1);
    drainSystemEventEntries(params.childSessionKey);

    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(drainSystemEventEntries(params.childSessionKey).map((entry) => entry.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("cross-session targeting is disabled by policy"),
      ]),
    );
  });

  it("allows child tool-delegate fanout=tree when cross-session targeting is disabled", async () => {
    mockedConsumePendingDelegates.mockReturnValueOnce([
      { task: "tool task for tree", fanoutMode: "tree" },
    ]);
    const params = await buildToolDelegateParams(1);

    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.continuationFanoutMode).toBe("tree");
  });

  it("allows tool delegate at maxChainLength (next hop = maxChainLength, off-by-one fix)", async () => {
    // With maxChainLength=5: childChainHop=4, nextToolHop=5 = maxChainLength → allowed (> not >=)
    setRuntimeConfigSnapshot(makeConfig({ maxChainLength: 5 }));
    mockedConsumePendingDelegates.mockReturnValueOnce([{ task: "tool task exactly at boundary" }]);

    const params = await buildToolDelegateParams(4);
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.task).toContain("[continuation:chain-hop:5]");
  });

  it("dispatches matured delayed tool delegates without charging a second delay", async () => {
    mockedConsumePendingDelegates.mockReturnValueOnce([
      { task: "matured delayed tool task", delayMs: 60_000 },
    ]);

    const params = await buildToolDelegateParams(1);
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.task).toContain("matured delayed tool task");
  });

  it("rejects tool delegate at maxChainLength+1 (next hop exceeds max)", async () => {
    // childChainHop=10, nextToolHop=11 > maxChainLength(10) → rejected
    mockedConsumePendingDelegates.mockReturnValueOnce([{ task: "tool task beyond boundary" }]);

    const params = await buildToolDelegateParams(10);
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(mockedMarkPendingDelegateFailed).toHaveBeenCalledWith(
      expect.objectContaining({ task: "tool task beyond boundary" }),
      expect.stringContaining("chain-capped"),
    );
  });

  it("rejects tool delegate well beyond maxChainLength", async () => {
    mockedConsumePendingDelegates.mockReturnValueOnce([{ task: "tool task way beyond boundary" }]);

    const params = await buildToolDelegateParams(15);
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("marks every over-cap consumed tool delegate failed", async () => {
    const first = { task: "first over-cap delegate", flowId: "flow-1", expectedRevision: 2 };
    const second = { task: "second over-cap delegate", flowId: "flow-2", expectedRevision: 4 };
    mockedConsumePendingDelegates.mockReturnValueOnce([first, second]);

    const params = await buildToolDelegateParams(10);
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(mockedMarkPendingDelegateFailed).toHaveBeenCalledWith(
      first,
      expect.stringContaining("chain-capped"),
    );
    expect(mockedMarkPendingDelegateFailed).toHaveBeenCalledWith(
      second,
      expect.stringContaining("chain-capped"),
    );
  });

  it("marks forbidden consumed tool delegate spawn failed as rejected", async () => {
    const delegate = { task: "forbidden spawned delegate", flowId: "flow-1", expectedRevision: 2 };
    mockedConsumePendingDelegates.mockReturnValueOnce([delegate]);
    spawnSpy.mockResolvedValue({
      status: "forbidden",
      error: "policy denied",
    });

    const params = await buildToolDelegateParams(1);
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(mockedMarkPendingDelegateFailed).toHaveBeenCalledWith(
      delegate,
      expect.stringContaining("DELEGATE spawn forbidden"),
    );
  });

  it("respects custom maxChainLength for tool delegates", async () => {
    setRuntimeConfigSnapshot(makeConfig({ maxChainLength: 3 }));
    const delegate = { task: "tool task at custom boundary" };
    mockedConsumePendingDelegates.mockReturnValueOnce([delegate]);

    // hop 2 → next=3 = maxChainLength → allowed
    const paramsAllow = await buildToolDelegateParams(2);
    await runSubagentAnnounceFlow(paramsAllow);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(spawnSpy).toHaveBeenCalledTimes(1);

    spawnSpy.mockClear();
    mockedConsumePendingDelegates.mockReturnValueOnce([delegate]);

    // hop 3 → next=4 > maxChainLength → rejected
    const paramsReject = await buildToolDelegateParams(3);
    await runSubagentAnnounceFlow(paramsReject);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Announce-path post-compaction routing (fix)
// ---------------------------------------------------------------------------

/**
 * A light-context leaf / completion path that emits a post-compaction bracket
 * delegate must STAGE the delegate at the compaction seam (parity with
 * agent-runner.ts) instead of spawning it as a normal immediate chain hop.
 * The two routes are mutually exclusive: staging skips spawnSubagentDirect.
 */
const mockedStagePostCompactionDelegate = vi.mocked(stagePostCompactionDelegate);

describe("announce-path post-compaction routing (stage at seam, skip spawn)", () => {
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await writeSessionStore({});
    setRuntimeConfigSnapshot(makeConfig());
    spawnSpy = vi.spyOn(subagentSpawn, "spawnSubagentDirect").mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:should-not-spawn",
      runId: "run-should-not-spawn",
    });
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    mockedStagePostCompactionDelegate.mockClear();
    clearRuntimeConfigSnapshot();
  });

  it("stages a post-compaction bracket delegate and skips the normal chain-spawn", async () => {
    const params = buildChainShardParams(1);
    params.roundOneReply =
      "Working state captured.\n[[CONTINUE_DELEGATE: resume migration step 3 | post-compaction]]";

    await runSubagentAnnounceFlow(params);
    // Allow any fire-and-forget spawn microtasks to flush (proving none fire).
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(mockedStagePostCompactionDelegate).toHaveBeenCalledTimes(1);
    const [stagedSessionKey, stagedDelegate] = expectDefined(
      mockedStagePostCompactionDelegate.mock.calls.at(0),
      "staged post-compaction delegate call",
    );
    expect(stagedSessionKey).toBe(params.requesterSessionKey);
    expect(stagedDelegate).toMatchObject({ task: "resume migration step 3" });
    // Mutual exclusion: staging at-seam must NOT also chain-spawn now.
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("still chain-spawns a normal (non-post-compaction) bracket delegate", async () => {
    const params = buildChainShardParams(1);
    params.roundOneReply = "Done.\n[[CONTINUE_DELEGATE: continue next step]]";

    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(mockedStagePostCompactionDelegate).not.toHaveBeenCalled();
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });
});
