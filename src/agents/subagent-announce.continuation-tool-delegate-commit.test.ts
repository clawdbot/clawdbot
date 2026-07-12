// C2 regression: the announce-path tool delegate accepted branch must finish
// (commit) the consumed TaskFlow row and thread continuationDelegateFlowId into
// the spawn, exactly like the shared dispatcher (delegate-dispatch.ts).
// Previously it only logged, so consumePendingDelegates left the row `running`
// and restart recovery re-drove it as duplicate continuation work. Mirrors the
// mocked chain-guard harness so only the announce tool path is exercised.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("./subagent-announce.registry.runtime.js", () => ({
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

vi.mock("../auto-reply/continuation-delegate-store.js", () => ({
  consumePendingDelegates: vi.fn(() => []),
  markPendingDelegateFailed: vi.fn(),
  markPendingDelegateSpawnAccepted: vi.fn(),
  stagePostCompactionDelegate: vi.fn(),
}));

import {
  consumePendingDelegates,
  markPendingDelegateFailed,
  markPendingDelegateSpawnAccepted,
} from "../auto-reply/continuation-delegate-store.js";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "../config/config.js";
import {
  clearSessionStoreCacheForTest,
  resolveStorePath,
  saveSessionStore,
} from "../config/sessions.js";
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

function buildToolDelegateParams(): AnnounceFlowParams {
  return {
    childSessionKey: "agent:main:subagent:tool-hop-1",
    childRunId: "run-tool-hop-1",
    requesterSessionKey: "agent:main:discord:dm:test-c2",
    requesterDisplayKey: "test-c2",
    task: "[continuation:chain-hop:1] Tool-delegated from sub-agent (depth 1): do research",
    roundOneReply: "Research complete.",
    timeoutMs: 30_000,
    cleanup: "delete",
    outcome: { status: "ok" as const },
    silentAnnounce: true,
    wakeOnReturn: true,
  };
}

const mockedConsumePendingDelegates = vi.mocked(consumePendingDelegates);
const mockedMarkPendingDelegateFailed = vi.mocked(markPendingDelegateFailed);
const mockedMarkPendingDelegateSpawnAccepted = vi.mocked(markPendingDelegateSpawnAccepted);

describe("announce tool-delegate accepted spawn commits the TaskFlow row (C2)", () => {
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await writeSessionStore({});
    setRuntimeConfigSnapshot(makeConfig() as never);
    spawnSpy = vi.spyOn(subagentSpawn, "spawnSubagentDirect").mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:continuation-child",
      runId: "run-continuation-child",
    });
    mockedConsumePendingDelegates.mockReturnValue([]);
    mockedMarkPendingDelegateFailed.mockClear();
    mockedMarkPendingDelegateSpawnAccepted.mockClear();
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    mockedConsumePendingDelegates.mockReturnValue([]);
    clearRuntimeConfigSnapshot();
    clearSessionStoreCacheForTest();
  });

  it("threads continuationDelegateFlowId and commits the flow via markPendingDelegateSpawnAccepted", async () => {
    mockedConsumePendingDelegates.mockReturnValue([
      { task: "continue next step", flowId: "flow-tool-c2", expectedRevision: 3 },
    ]);

    await runSubagentAnnounceFlow(buildToolDelegateParams());
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.continuationDelegateFlowId).toBe("flow-tool-c2");
    expect(spawnArgs.drainsContinuationDelegateQueue).toBe(true);

    // Accepted spawn commits the consumed row so recovery does not re-drive it.
    expect(mockedMarkPendingDelegateSpawnAccepted).toHaveBeenCalledTimes(1);
    const acceptArgs = expectDefined(
      mockedMarkPendingDelegateSpawnAccepted.mock.calls.at(0),
      "spawn acceptance call",
    );
    expect(acceptArgs[0]).toMatchObject({ flowId: "flow-tool-c2", expectedRevision: 3 });
    expect(acceptArgs[1]).toBe("agent:main:subagent:continuation-child");
    expect(mockedMarkPendingDelegateFailed).not.toHaveBeenCalled();
  });

  it("does not commit the flow when the spawn is rejected", async () => {
    mockedConsumePendingDelegates.mockReturnValue([
      { task: "continue next step", flowId: "flow-tool-c2-reject", expectedRevision: 1 },
    ]);
    spawnSpy.mockResolvedValue({ status: "forbidden", error: "depth exceeded" });

    await runSubagentAnnounceFlow(buildToolDelegateParams());
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(mockedMarkPendingDelegateSpawnAccepted).not.toHaveBeenCalled();
    expect(mockedMarkPendingDelegateFailed).toHaveBeenCalledTimes(1);
  });
});
