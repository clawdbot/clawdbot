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
const inProcessDispatchMock = vi.hoisted(() =>
  vi.fn(
    async (
      _method: string,
      _params: Record<string, unknown>,
      _options?: Record<string, unknown>,
    ) => ({
      runId: "return-run",
      status: "accepted",
    }),
  ),
);

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: [GatewayRequest]) => callGatewayMock(...args),
}));
vi.mock("../gateway/server-plugin-in-process-dispatch.js", () => ({
  dispatchGatewayMethodInProcess: (
    method: string,
    params: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => inProcessDispatchMock(method, params, options),
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
import {
  resetContinuationTracer,
  setContinuationTracer,
  type SpanAttributes,
} from "../infra/continuation-tracer.js";
import { parseDiagnosticTraceparent } from "../infra/diagnostic-trace-context-pure.js";
import {
  resetDiagnosticTraceContextForTest,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";
import { defaultRuntime } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  listTaskFlowsForOwnerKey,
  reloadTaskFlowRegistryFromStore,
} from "../tasks/task-flow-runtime-internal.js";
import { resetTaskFlowRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
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
const originTraceId = "11111111111111111111111111111111";
const originSpanId = "2222222222222222";
const originTraceContext: DiagnosticTraceContext = {
  traceId: originTraceId,
  spanId: originSpanId,
  parentSpanId: "3333333333333333",
  traceFlags: "01",
};
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
          minDelayMs: 25,
          maxDelayMs: 25,
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

type RecordedContinuationSpan = {
  name: string;
  traceId: string;
  spanId: string;
  inputTraceparent?: string;
  attributes?: SpanAttributes;
};

function installRecordingContinuationTracer(): RecordedContinuationSpan[] {
  const spans: RecordedContinuationSpan[] = [];
  let sequence = 0;
  setContinuationTracer({
    startSpan(name, options) {
      sequence += 1;
      const parent = parseDiagnosticTraceparent(options?.traceparent);
      const traceId = parent?.traceId ?? sequence.toString(16).padStart(32, "0");
      const spanId = sequence.toString(16).padStart(16, "0");
      const recorded: RecordedContinuationSpan = {
        name,
        traceId,
        spanId,
        ...(options?.traceparent ? { inputTraceparent: options.traceparent } : {}),
        ...(options?.attributes ? { attributes: { ...options.attributes } } : {}),
      };
      spans.push(recorded);
      return {
        setAttributes(attributes) {
          recorded.attributes = { ...recorded.attributes, ...attributes };
        },
        setStatus() {},
        recordException() {},
        traceparent() {
          return `00-${traceId}-${spanId}-01`;
        },
        end() {},
      };
    },
  });
  return spans;
}

describe("continuation chain production composition proof (tree hop-1 + hop-2)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    gatewayState.runCounter = 0;
    gatewayState.waitResults.clear();
    gatewayState.chatHistoryBySessionKey.clear();
    callGatewayMock.mockClear();
    inProcessDispatchMock.mockClear();

    stateDir = mkdtempSync(join(tmpdir(), "openclaw-proof-state-live-tree-chain-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    resetAgentEventsForTest();
    resetSubagentRegistryForTests();
    resetTaskFlowRegistryForTests({ persist: false });
    resetDelegateStoreForTests();
    resetSystemEventsForTest();
    resetContinuationTracer();
    resetDiagnosticTraceContextForTest();
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
    resetTaskFlowRegistryForTests({ persist: false });
    resetSubagentRegistryForTests();
    resetAgentEventsForTest();
    resetContinuationTracer();
    resetDiagnosticTraceContextForTest();
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
    expect(hop2Run?.continuationTargetSessionKeys).toEqual([hop1ChildSessionKey, rootSessionKey]);
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
    const hop1ReturnsBeforeHop2Lifecycle = countGrandchildReturns(hop1ChildSessionKey);
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
    const hop1ReturnsAfterHop2Lifecycle = countGrandchildReturns(hop1ChildSessionKey);
    const targetedReturnLogsAfterHop2Lifecycle = countHop2RootReturnLogs();
    expect(rootReturnsAfterHop2Lifecycle).toBe(rootReturnsBeforeHop2Lifecycle + 1);
    expect(hop1ReturnsAfterHop2Lifecycle).toBe(hop1ReturnsBeforeHop2Lifecycle + 1);
    expect(targetedReturnLogsAfterHop2Lifecycle).toBe(targetedReturnLogsBeforeHop2Lifecycle + 1);
    // The frozen tree reaches every ancestor once and lifecycle replay does not
    // duplicate either the stale intermediate or root delivery.
  });

  it("keeps a raw-final token delegate owned by its registered disposable origin", async () => {
    const spans = installRecordingContinuationTracer();
    const delegateSentinel = "RAW-TOKEN-DELEGATE-DONE";
    const delegateTask = `reply exactly ${delegateSentinel}`;
    const originSpawn = await spawnSubagentDirect(
      {
        task: "emit one raw-final delegate token",
        label: "raw-token-origin",
        cleanup: "delete",
      },
      {
        agentSessionKey: rootSessionKey,
        agentChannel: "discord",
        agentTo: "chan-root",
        agentAccountId: "acct-root",
      },
    );
    if (originSpawn.status !== "accepted" || !originSpawn.childSessionKey || !originSpawn.runId) {
      throw new Error(`origin spawn failed: ${JSON.stringify(originSpawn)}`);
    }
    const originChildSessionKey = originSpawn.childSessionKey;
    const originChildRunId = originSpawn.runId;
    gatewayState.waitResults.set(originChildRunId, {
      status: "ok",
      startedAt: 10,
      endedAt: 20,
    });
    const originFinalText = `Origin complete.\n[[CONTINUE_DELEGATE: ${delegateTask} +1s]]`;
    gatewayState.chatHistoryBySessionKey.set(originChildSessionKey, [
      {
        role: "assistant",
        content: originFinalText,
      },
    ]);

    const emitOriginCompletion = () =>
      runWithDiagnosticTraceContext(originTraceContext, () => {
        emitAgentEvent({
          runId: originChildRunId,
          stream: "lifecycle",
          sessionKey: originChildSessionKey,
          data: {
            phase: "end",
            startedAt: 10,
            endedAt: 20,
            terminalReply: { disposition: "visible", text: originFinalText },
          },
        });
      });
    emitOriginCompletion();

    const listDelegateRuns = () =>
      [
        ...listSubagentRunsForRequester(rootSessionKey),
        ...listSubagentRunsForRequester(originChildSessionKey),
      ]
        .filter((entry) => entry.task.includes(delegateSentinel))
        .filter(
          (entry, index, entries) =>
            entries.findIndex((candidate) => candidate.runId === entry.runId) === index,
        );
    await waitFor(() => {
      const flow = listTaskFlowsForOwnerKey(originChildSessionKey)[0];
      return (
        flow?.status === "succeeded" &&
        listDelegateRuns().length === 1 &&
        spans.some((span) => span.name === "continuation.delegate.dispatch") &&
        spans.some((span) => span.name === "continuation.delegate.fire")
      );
    }, 4_000);

    const flows = listTaskFlowsForOwnerKey(originChildSessionKey);
    const flow = flows[0];
    const [delegateRun] = listDelegateRuns();
    if (!flow || !delegateRun) {
      throw new Error("expected one accepted raw-token delegate flow and run");
    }
    expect(flow).toMatchObject({
      ownerKey: originChildSessionKey,
      status: "succeeded",
      currentStep: "Accepted by continuation subagent",
    });
    expect(flow.stateJson).toMatchObject({
      childSessionKey: delegateRun.childSessionKey,
    });
    expect.soft(flow.stateJson).toMatchObject({ originRunId: originChildRunId });
    expect.soft(delegateRun.requesterSessionKey).toBe(originChildSessionKey);
    expect.soft(delegateRun.controllerSessionKey).toBe(originChildSessionKey);
    expect.soft(listTaskFlowsForOwnerKey(rootSessionKey)).toHaveLength(0);
    reloadTaskFlowRegistryFromStore();
    expect.soft(listTaskFlowsForOwnerKey(originChildSessionKey)).toEqual([
      expect.objectContaining({
        flowId: flow.flowId,
        ownerKey: originChildSessionKey,
        stateJson: expect.objectContaining({
          childSessionKey: delegateRun.childSessionKey,
          originRunId: originChildRunId,
        }),
      }),
    ]);

    const dispatchSpan = spans.find((span) => span.name === "continuation.delegate.dispatch");
    const fireSpan = spans.find((span) => span.name === "continuation.delegate.fire");
    expect(dispatchSpan).toBeDefined();
    expect(fireSpan).toBeDefined();
    expect.soft(dispatchSpan?.traceId).toBe(originTraceId);
    expect.soft(fireSpan?.traceId).toBe(originTraceId);
    expect.soft(dispatchSpan?.traceId).toBe(fireSpan?.traceId);

    emitOriginCompletion();
    await new Promise<void>((resolveTurn) => {
      setTimeout(resolveTurn, 50);
    });
    expect(listTaskFlowsForOwnerKey(originChildSessionKey)).toHaveLength(1);
    expect(listDelegateRuns()).toHaveLength(1);
    releaseSubagentRun(originChildRunId);
    expect(getSubagentRunByChildSessionKey(originChildSessionKey)).toBeNull();

    const delegateChildSessionKey = delegateRun.childSessionKey;
    const delegateChildRunId = delegateRun.runId;
    gatewayState.waitResults.set(delegateChildRunId, {
      status: "ok",
      startedAt: 30,
      endedAt: 40,
    });
    gatewayState.chatHistoryBySessionKey.set(delegateChildSessionKey, [
      {
        role: "assistant",
        content: delegateSentinel,
      },
    ]);
    const countReturns = (sessionKey: string) => {
      const gatewayReturns = callGatewayMock.mock.calls.filter(
        ([request]) =>
          request.method === "agent" &&
          request.params?.sessionKey === sessionKey &&
          typeof request.params.message === "string" &&
          request.params.message.includes(delegateSentinel),
      ).length;
      const inProcessReturns = inProcessDispatchMock.mock.calls.filter(
        ([method, params]) =>
          method === "agent" &&
          params.sessionKey === sessionKey &&
          typeof params.message === "string" &&
          params.message.includes(delegateSentinel),
      ).length;
      return gatewayReturns + inProcessReturns;
    };
    const originReturnsBefore = countReturns(originChildSessionKey);
    const rootReturnsBefore = countReturns(rootSessionKey);
    const emitDelegateCompletion = () =>
      emitAgentEvent({
        runId: delegateChildRunId,
        stream: "lifecycle",
        sessionKey: delegateChildSessionKey,
        data: {
          phase: "end",
          startedAt: 30,
          endedAt: 40,
          terminalReply: { disposition: "visible", text: delegateSentinel },
        },
      });

    emitDelegateCompletion();
    try {
      await waitFor(
        () =>
          countReturns(originChildSessionKey) + countReturns(rootSessionKey) ===
          originReturnsBefore + rootReturnsBefore + 1,
        4_000,
      );
    } catch {
      throw new Error(
        JSON.stringify({
          originRun: getSubagentRunByChildSessionKey(originChildSessionKey),
          delegateRun: getSubagentRunByChildSessionKey(delegateChildSessionKey),
          originEvents: peekSystemEventEntries(originChildSessionKey).map((entry) => entry.text),
          rootEvents: peekSystemEventEntries(rootSessionKey).map((entry) => entry.text),
          gatewayCalls: callGatewayMock.mock.calls,
          inProcessDispatches: inProcessDispatchMock.mock.calls,
          logs: logSpy.mock.calls.map(([message]: [unknown]) => String(message)),
          errors: errorSpy.mock.calls.map(([message]: [unknown]) => String(message)),
        }),
      );
    }
    expect.soft(countReturns(originChildSessionKey)).toBe(originReturnsBefore + 1);
    expect.soft(countReturns(rootSessionKey)).toBe(rootReturnsBefore);

    emitDelegateCompletion();
    await new Promise<void>((resolveTurn) => {
      setTimeout(resolveTurn, 50);
    });
    expect(countReturns(originChildSessionKey)).toBe(originReturnsBefore + 1);
    expect(countReturns(rootSessionKey)).toBe(rootReturnsBefore);
  });
});
