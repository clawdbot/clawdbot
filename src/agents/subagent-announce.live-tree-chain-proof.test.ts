import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type GatewayRequest = {
  method?: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  expectFinal?: boolean;
};

const gatewayState = vi.hoisted(() => ({
  runCounter: 0,
  waitResults: new Map<string, { status: string; startedAt?: number; endedAt?: number }>(),
  chatHistoryBySessionKey: new Map<string, Array<Record<string, unknown>>>(),
}));

const callGatewayMock = vi.hoisted(() =>
  vi.fn(async (request: GatewayRequest) => {
    if (request.method === "sessions.patch" || request.method === "sessions.delete") {
      return { ok: true };
    }
    if (request.method === "agent") {
      gatewayState.runCounter += 1;
      return {
        runId: `run-${gatewayState.runCounter}`,
        status: "accepted",
        acceptedAt: Date.now(),
      };
    }
    if (request.method === "agent.wait") {
      const runId =
        typeof request.params?.runId === "string" ? request.params.runId.trim() : undefined;
      if (runId) {
        const planned = gatewayState.waitResults.get(runId);
        if (planned) {
          return planned;
        }
      }
      return { status: "pending" };
    }
    if (request.method === "chat.history") {
      const sessionKey =
        typeof request.params?.sessionKey === "string"
          ? request.params.sessionKey.trim()
          : undefined;
      return {
        messages: sessionKey ? (gatewayState.chatHistoryBySessionKey.get(sessionKey) ?? []) : [],
      };
    }
    return {};
  }),
);

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: [GatewayRequest]) => callGatewayMock(...args),
}));

import {
  enqueuePendingDelegate,
  pendingDelegateCount,
  resetDelegateStoreForTests,
} from "../auto-reply/continuation/delegate-store.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";
import { defaultRuntime } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { loadSessionEntryByKey } from "./subagents/announce/subagent-announce-delivery.js";
import {
  getSubagentRunByChildSessionKey,
  listSubagentRunsForRequester,
} from "./subagents/registry/subagent-registry-read.js";
import {
  releaseSubagentRun,
  resetSubagentRegistryForTests,
} from "./subagents/registry/subagent-registry.test-helpers.js";
import "./subagents/registry/subagent-registry.js";
import { getSubagentDepthFromSessionStore } from "./subagents/spawn/subagent-depth.js";
import { spawnSubagentDirect } from "./subagents/spawn/subagent-spawn.js";

const rootSessionKey = "agent:main:root";
let stateDir: string;

function makeConfig(): OpenClawConfig {
  return {
    session: { mainKey: "main", scope: "per-sender" as const },
    agents: {
      list: [{ id: "main" }],
      defaults: {
        workspace: process.cwd(),
        subagents: {
          maxSpawnDepth: 10,
          maxChildrenPerAgent: 10,
        },
        continuation: {
          enabled: true,
          maxChainLength: 10,
          costCapTokens: 500_000,
          minDelayMs: 0,
          maxDelayMs: 0,
          maxDelegatesPerTurn: 5,
          crossSessionTargeting: "disabled" as const,
        },
      },
    },
  };
}

async function upsertMainSessionEntry(sessionKey: string, sessionId: string, updatedAt: number) {
  await upsertSessionEntryCore(
    {
      sessionKey,
      agentId: "main",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    },
    { sessionId, updatedAt },
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolveTurn) => {
      setTimeout(resolveTurn, 20);
    });
  }
  throw new Error("timed out waiting for condition");
}

describe("continuation chain production composition proof (tree hop-1 + hop-2)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    gatewayState.runCounter = 0;
    gatewayState.waitResults.clear();
    gatewayState.chatHistoryBySessionKey.clear();
    callGatewayMock.mockClear();

    stateDir = mkdtempSync(join(tmpdir(), "openclaw-proof-state-live-tree-chain-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    resetAgentEventsForTest();
    resetSubagentRegistryForTests();
    resetDelegateStoreForTests();
    resetSystemEventsForTest();
    setRuntimeConfigSnapshot(makeConfig());
    expect(getRuntimeConfig().agents?.defaults?.continuation?.enabled).toBe(true);

    await upsertMainSessionEntry(rootSessionKey, "sess-root", Date.now());

    logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy?.mockRestore();
    errorSpy?.mockRestore();
    clearRuntimeConfigSnapshot();
    resetSystemEventsForTest();
    resetDelegateStoreForTests();
    resetSubagentRegistryForTests();
    resetAgentEventsForTest();
    vi.unstubAllEnvs();
    // Both session access and shared state cache SQLite handles. Close them
    // before deleting this test's state directory so no handle/cache crosses
    // test boundaries (notably on Windows).
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    rmSync(stateDir, { recursive: true, force: true });
    expect(existsSync(stateDir)).toBe(false);
    stateDir = "";
  });

  it("delivers one depth-2 tree return after the settled intermediate registry row retires", async () => {
    const hop1Spawn = await spawnSubagentDirect(
      {
        task: "[continuation:chain-hop:1] live proof hop-1",
        silentAnnounce: true,
        wakeOnReturn: true,
        continuationFanoutMode: "tree",
        drainsContinuationDelegateQueue: true,
        continuationChainState: {
          count: 1,
          startedAt: Date.now(),
          tokens: 0,
          chainId: "proof-chain",
        },
      },
      {
        agentSessionKey: rootSessionKey,
        agentChannel: "discord",
        agentTo: "chan-root",
        agentAccountId: "acct-root",
      },
    );

    if (hop1Spawn.status !== "accepted") {
      throw new Error(`hop1 spawn failed: ${JSON.stringify(hop1Spawn)}`);
    }
    expect(hop1Spawn.status).toBe("accepted");
    expect(hop1Spawn.childSessionKey).toBeTruthy();
    expect(hop1Spawn.runId).toBeTruthy();

    const hop1ChildSessionKey = hop1Spawn.childSessionKey as string;
    const hop1RunId = hop1Spawn.runId as string;
    gatewayState.waitResults.set(hop1RunId, { status: "ok", startedAt: 10, endedAt: 20 });

    enqueuePendingDelegate(hop1ChildSessionKey, {
      task: "live proof hop-2",
      mode: "silent-wake",
      delayMs: 0,
      fanoutMode: "tree",
      firstArmedAt: Date.now(),
    });
    expect(pendingDelegateCount(hop1ChildSessionKey)).toBe(1);

    gatewayState.chatHistoryBySessionKey.set(hop1ChildSessionKey, [
      {
        role: "assistant",
        content: "CHAIN-1-DONE",
      },
    ]);
    emitAgentEvent({
      runId: hop1RunId,
      stream: "lifecycle",
      sessionKey: hop1ChildSessionKey,
      data: { phase: "end", startedAt: 10, endedAt: 20 },
    });

    try {
      await waitFor(
        () =>
          listSubagentRunsForRequester(hop1ChildSessionKey).some((entry) =>
            entry.task.includes("[continuation:chain-hop:2]"),
          ),
        4_000,
      );
    } catch {
      throw new Error(
        JSON.stringify({
          rootRuns: listSubagentRunsForRequester(rootSessionKey).map((entry) => ({
            runId: entry.runId,
            childSessionKey: entry.childSessionKey,
            requesterSessionKey: entry.requesterSessionKey,
            task: entry.task,
            endedAt: entry.execution.endedAt,
            cleanupCompletedAt: entry.cleanupCompletedAt,
          })),
          childRuns: listSubagentRunsForRequester(hop1ChildSessionKey).map((entry) => ({
            runId: entry.runId,
            childSessionKey: entry.childSessionKey,
            requesterSessionKey: entry.requesterSessionKey,
            task: entry.task,
          })),
          pendingDelegates: pendingDelegateCount(hop1ChildSessionKey),
          logs: logSpy.mock.calls.map(([message]: [unknown]) => String(message)),
          errors: errorSpy.mock.calls.map(([message]: [unknown]) => String(message)),
        }),
      );
    }
    await waitFor(
      () =>
        typeof getSubagentRunByChildSessionKey(hop1ChildSessionKey)?.cleanupCompletedAt ===
        "number",
      4_000,
    );
    releaseSubagentRun(hop1RunId);
    expect(getSubagentRunByChildSessionKey(hop1ChildSessionKey)).toBeNull();

    const requesterRuns = listSubagentRunsForRequester(hop1ChildSessionKey);
    const hop2Run = requesterRuns.find((entry) =>
      entry.task.includes("[continuation:chain-hop:2]"),
    );

    if (!hop2Run) {
      const childRunIds = requesterRuns.map((entry) => `${entry.runId}:${entry.task}`);
      const agentCallCount = callGatewayMock.mock.calls.filter(
        ([request]) => request.method === "agent",
      ).length;
      const logMessages = logSpy.mock.calls
        .map(([message]: [unknown]) => (typeof message === "string" ? message : String(message)))
        .slice(0, 12);
      throw new Error(
        `hop2 run missing childRuns=${JSON.stringify(childRunIds)} agentCalls=${agentCallCount} logs=${JSON.stringify(logMessages)}`,
      );
    }
    expect(hop2Run).toBeDefined();
    expect(hop2Run?.requesterSessionKey).toBe(hop1ChildSessionKey);
    expect(hop2Run?.controllerSessionKey).toBe(hop1ChildSessionKey);
    expect(hop2Run?.cleanup).toBe("keep");
    expect(hop2Run?.continuationTargetSessionKey).toBeUndefined();
    expect(hop2Run?.continuationTargetSessionKeys).toBeUndefined();
    expect(hop2Run?.continuationFanoutMode).toBe("tree");

    const hop2SessionKey = hop2Run?.childSessionKey as string;
    const hop2RunId = hop2Run?.runId as string;
    gatewayState.waitResults.set(hop2RunId, { status: "pending" });

    // Capture concrete registry + session-store state right before lifecycle announce.
    expect(getSubagentDepthFromSessionStore(hop2Run.requesterSessionKey)).toBe(1);
    expect(getSubagentRunByChildSessionKey(hop2SessionKey)?.runId).toBe(hop2RunId);
    expect(loadSessionEntryByKey(rootSessionKey)?.sessionId).toBe("sess-root");
    expect(loadSessionEntryByKey(hop1ChildSessionKey)?.sessionId).toBeTruthy();
    expect(loadSessionEntryByKey(hop2SessionKey)?.sessionId).toBeTruthy();

    gatewayState.chatHistoryBySessionKey.set(hop2SessionKey, [
      {
        role: "assistant",
        content: "GRANDCHILD-DONE",
      },
    ]);
    const countGrandchildReturns = (sessionKey: string) =>
      peekSystemEventEntries(sessionKey).filter((entry) => entry.text.includes("GRANDCHILD-DONE"))
        .length;
    const rootReturnsBeforeHop2Lifecycle = countGrandchildReturns(rootSessionKey);
    const cleanedHop1EventsBeforeHop2Lifecycle = peekSystemEventEntries(hop1ChildSessionKey).length;
    const countHop2RootReturnLogs = () =>
      logSpy.mock.calls.filter(
        ([message]: [unknown]) =>
          typeof message === "string" &&
          message.includes("[continuation:targeted-return]") &&
          message.includes(rootSessionKey) &&
          message.includes(hop2SessionKey),
      ).length;
    const targetedReturnLogsBeforeHop2Lifecycle = countHop2RootReturnLogs();

    const emitHop2Completion = () =>
      emitAgentEvent({
        runId: hop2RunId,
        stream: "lifecycle",
        sessionKey: hop2SessionKey,
        data: { phase: "end", startedAt: 30, endedAt: 40 },
      });
    emitHop2Completion();

    await waitFor(
      () =>
        countGrandchildReturns(rootSessionKey) === rootReturnsBeforeHop2Lifecycle + 1 &&
        countHop2RootReturnLogs() === targetedReturnLogsBeforeHop2Lifecycle + 1,
      4_000,
    );

    emitHop2Completion();
    await new Promise<void>((resolveTurn) => {
      setTimeout(resolveTurn, 50);
    });

    const rootReturnsAfterHop2Lifecycle = countGrandchildReturns(rootSessionKey);
    const cleanedHop1EventsAfterHop2Lifecycle = peekSystemEventEntries(hop1ChildSessionKey).length;
    const targetedReturnLogsAfterHop2Lifecycle = countHop2RootReturnLogs();
    expect(rootReturnsAfterHop2Lifecycle).toBe(rootReturnsBeforeHop2Lifecycle + 1);
    expect(targetedReturnLogsAfterHop2Lifecycle).toBe(targetedReturnLogsBeforeHop2Lifecycle + 1);
    // Tree routing must survive a retired intermediate without reopening that
    // completed run-mode session or duplicating the root return on lifecycle replay.
    expect(cleanedHop1EventsAfterHop2Lifecycle).toBe(cleanedHop1EventsBeforeHop2Lifecycle);
  });
});
