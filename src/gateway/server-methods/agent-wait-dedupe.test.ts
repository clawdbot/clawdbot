/**
 * Tests gateway dedupe observations feeding the canonical agent job registry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_RUN_ABORTED_ERROR } from "../../agents/run-termination.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import type { DedupeEntry } from "../server-shared.js";
import { testing, setGatewayDedupeEntry, waitForAgentJob } from "./agent-job.js";

type DedupeKind = "agent" | "chat";
type SnapshotReadOptions = { source?: "chat" };
type SnapshotWaitOptions = Omit<Parameters<typeof waitForAgentJob>[0], "runId">;
type RunEntryParams = {
  dedupe: Map<string, DedupeEntry>;
  kind: DedupeKind;
  runId: string;
  ts?: number;
  ok?: boolean;
  payload: Record<string, unknown>;
};

describe("agent job gateway dedupe observations", () => {
  function setRunEntry(params: RunEntryParams) {
    setGatewayDedupeEntry({
      dedupe: params.dedupe,
      key: `${params.kind}:${params.runId}`,
      entry: {
        ts: params.ts ?? Date.now(),
        ok: params.ok ?? true,
        payload: params.payload,
      },
    });
  }

  function setAgentEntry(params: Omit<RunEntryParams, "kind">) {
    setRunEntry({ ...params, kind: "agent" });
  }

  function setChatEntry(params: Omit<RunEntryParams, "kind">) {
    setRunEntry({ ...params, kind: "chat" });
  }

  function agentMetaPayload(
    runId: string,
    meta: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      runId,
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      ...overrides,
      result: { meta },
    };
  }

  function okPayload(runId: string, overrides: Record<string, unknown> = {}) {
    return { runId, status: "ok", ...overrides };
  }

  function okSnapshot(overrides: Record<string, unknown> = {}) {
    return { status: "ok", error: undefined, ...overrides };
  }

  function queueTimeoutPayload(runId: string, overrides: Record<string, unknown> = {}) {
    return {
      runId,
      status: "timeout",
      timeoutPhase: "queue",
      providerStarted: false,
      endedAt: 100,
      ...overrides,
    };
  }

  function setRpcQueueTimeoutEntry(params: {
    dedupe: Map<string, DedupeEntry>;
    kind: DedupeKind;
    runId: string;
    ts?: number;
  }) {
    setRunEntry({
      dedupe: params.dedupe,
      kind: params.kind,
      runId: params.runId,
      ts: params.ts ?? 100,
      payload: queueTimeoutPayload(params.runId, {
        stopReason: "rpc",
      }),
    });
  }

  function expectTerminalSnapshot(
    runId: string,
    snapshot: Record<string, unknown>,
    options: SnapshotReadOptions = {},
  ) {
    expect(testing.getTerminalSnapshot(runId, options.source)).toEqual(snapshot);
  }

  function expectNoTerminalSnapshot(runId: string, options: SnapshotReadOptions = {}) {
    expect(testing.getTerminalSnapshot(runId, options.source)).toBeNull();
  }

  function waitForTerminalSnapshot(runId: string, options: Partial<SnapshotWaitOptions> = {}) {
    return waitForAgentJob({ runId, timeoutMs: 1_000, ...options });
  }

  const RPC_QUEUE_CANCEL_SNAPSHOT = {
    status: "error",
    startedAt: undefined,
    endedAt: 100,
    error: undefined,
    stopReason: "rpc",
    livenessState: undefined,
    timeoutPhase: "queue",
    providerStarted: false,
  } as const;

  beforeEach(() => {
    testing.resetAgentJobs();
    vi.useFakeTimers();
  });

  afterEach(() => {
    testing.resetAgentJobs();
    vi.useRealTimers();
  });

  it("unblocks waiters when a terminal chat dedupe entry is written", async () => {
    const dedupe = new Map();
    const runId = "run-chat-terminal";
    const waiter = waitForTerminalSnapshot(runId);

    await Promise.resolve();
    expect(testing.getWaiterCount(runId)).toBe(1);

    setChatEntry({
      dedupe,
      runId,
      payload: okPayload(runId, { startedAt: 100, endedAt: 200 }),
    });

    await expect(waiter).resolves.toEqual(okSnapshot({ startedAt: 100, endedAt: 200 }));
    expect(testing.getWaiterCount(runId)).toBe(0);
  });

  it("preserves structured yield metadata from terminal agent results", () => {
    const dedupe = new Map();
    const runId = "run-yielded";

    setAgentEntry({
      dedupe,
      runId,
      payload: agentMetaPayload(runId, {
        stopReason: "end_turn",
        livenessState: "paused",
        yielded: true,
      }),
    });

    expectTerminalSnapshot(
      runId,
      okSnapshot({
        startedAt: 100,
        endedAt: 200,
        stopReason: "end_turn",
        livenessState: "paused",
        yielded: true,
      }),
    );
  });

  it("preserves timeout attribution from terminal agent result metadata", () => {
    const dedupe = new Map();
    const runId = "run-provider-timeout";

    setAgentEntry({
      dedupe,
      runId,
      payload: agentMetaPayload(
        runId,
        {
          timeoutPhase: "provider",
          providerStarted: true,
        },
        {
          status: "timeout",
        },
      ),
    });

    expectTerminalSnapshot(runId, {
      status: "timeout",
      startedAt: 100,
      endedAt: 200,
      error: undefined,
      timeoutPhase: "provider",
      providerStarted: true,
    });
  });

  it("keeps hard timeout snapshots stronger than blocked liveness", () => {
    const dedupe = new Map();
    const runId = "run-blocked-provider-timeout";

    setAgentEntry({
      dedupe,
      runId,
      payload: agentMetaPayload(
        runId,
        {
          livenessState: "blocked",
          timeoutPhase: "provider",
          providerStarted: true,
        },
        {
          status: "error",
          error: "model timed out",
        },
      ),
    });

    expectTerminalSnapshot(runId, {
      status: "timeout",
      startedAt: 100,
      endedAt: 200,
      error: "model timed out",
      livenessState: "blocked",
      timeoutPhase: "provider",
      providerStarted: true,
    });
  });

  it("normalizes blocked ok agent snapshots to errors", () => {
    const dedupe = new Map();
    const runId = "run-blocked-agent";

    setAgentEntry({
      dedupe,
      runId,
      payload: agentMetaPayload(
        runId,
        {
          livenessState: "blocked",
        },
        {
          error: "Context overflow: prompt too large for the model.",
        },
      ),
    });

    expectTerminalSnapshot(runId, {
      status: "error",
      startedAt: 100,
      endedAt: 200,
      error: "Context overflow: prompt too large for the model.",
      livenessState: "blocked",
    });
  });

  it("normalizes aborted ok agent snapshots to errors", () => {
    const dedupe = new Map();
    const runId = "run-aborted-agent";

    setAgentEntry({
      dedupe,
      runId,
      payload: agentMetaPayload(runId, {
        stopReason: "aborted",
      }),
    });

    expectTerminalSnapshot(runId, {
      status: "error",
      startedAt: 100,
      endedAt: 200,
      error: AGENT_RUN_ABORTED_ERROR,
      stopReason: "aborted",
    });
  });

  it("unblocks waiters with normalized aborted snapshots", async () => {
    const dedupe = new Map();
    const runId = "run-wait-aborted";
    const waiter = waitForTerminalSnapshot(runId);

    await Promise.resolve();
    expect(testing.getWaiterCount(runId)).toBe(1);

    setAgentEntry({
      dedupe,
      runId,
      payload: {
        runId,
        status: "ok",
        stopReason: "aborted",
        endedAt: 300,
      },
    });

    await expect(waiter).resolves.toEqual({
      status: "error",
      endedAt: 300,
      error: AGENT_RUN_ABORTED_ERROR,
      stopReason: "aborted",
    });
    expect(testing.getWaiterCount(runId)).toBe(0);
  });

  it("keeps stale chat dedupe blocked while agent dedupe is in-flight", async () => {
    const dedupe = new Map();
    const runId = "run-stale-chat";
    setChatEntry({
      dedupe,
      runId,
      payload: okPayload(runId),
    });
    setAgentEntry({
      dedupe,
      runId,
      payload: {
        runId,
        status: "accepted",
      },
    });

    expectNoTerminalSnapshot(runId);

    const blockedWait = waitForTerminalSnapshot(runId, { timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(30);
    await expect(blockedWait).resolves.toBeNull();
    expect(testing.getWaiterCount(runId)).toBe(0);
  });

  it("uses newer terminal chat snapshot when agent entry is non-terminal", () => {
    const dedupe = new Map();
    const runId = "run-nonterminal-agent-with-newer-chat";
    setAgentEntry({
      dedupe,
      runId,
      ts: 100,
      payload: {
        runId,
        status: "accepted",
      },
    });
    setChatEntry({
      dedupe,
      runId,
      ts: 200,
      payload: okPayload(runId, { startedAt: 1, endedAt: 2 }),
    });

    expectTerminalSnapshot(runId, okSnapshot({ startedAt: 1, endedAt: 2 }));
  });

  it("ignores stale agent snapshots when waiting for an active chat run", async () => {
    const dedupe = new Map();
    const runId = "run-chat-active-ignore-agent";
    setAgentEntry({
      dedupe,
      runId,
      payload: okPayload(runId),
    });

    expectNoTerminalSnapshot(runId, { source: "chat" });

    const wait = waitForTerminalSnapshot(runId, {
      source: "chat",
    });
    await Promise.resolve();
    expect(testing.getWaiterCount(runId)).toBe(1);

    setChatEntry({
      dedupe,
      runId,
      payload: okPayload(runId, { startedAt: 123, endedAt: 456 }),
    });

    await expect(wait).resolves.toEqual(okSnapshot({ startedAt: 123, endedAt: 456 }));
  });

  it("prefers the freshest terminal snapshot when agent/chat dedupe keys collide", () => {
    const runId = "run-collision";
    const dedupe = new Map();

    setAgentEntry({
      dedupe,
      runId,
      ts: 100,
      payload: okPayload(runId, { startedAt: 10, endedAt: 20 }),
    });
    setChatEntry({
      dedupe,
      runId,
      ts: 200,
      ok: false,
      payload: { runId, status: "error", startedAt: 30, endedAt: 40, error: "chat failed" },
    });

    expectTerminalSnapshot(runId, {
      status: "error",
      startedAt: 30,
      endedAt: 40,
      error: "chat failed",
    });

    const dedupeReverse = new Map();
    setChatEntry({
      dedupe: dedupeReverse,
      runId,
      ts: 100,
      payload: okPayload(runId, { startedAt: 1, endedAt: 2 }),
    });
    setAgentEntry({
      dedupe: dedupeReverse,
      runId,
      ts: 200,
      payload: { runId, status: "timeout", startedAt: 3, endedAt: 4, error: "still running" },
    });

    expectTerminalSnapshot(runId, {
      status: "timeout",
      startedAt: 3,
      endedAt: 4,
      error: "still running",
    });
  });

  it("uses the newer source when an older cross-source terminal is sticky", () => {
    const runId = "run-sticky-collision";
    const newerChat = new Map();

    setRpcQueueTimeoutEntry({
      dedupe: newerChat,
      kind: "agent",
      runId,
      ts: 100,
    });
    setChatEntry({
      dedupe: newerChat,
      runId,
      ts: 200,
      payload: okPayload(runId, { startedAt: 150, endedAt: 200 }),
    });

    expectTerminalSnapshot(runId, okSnapshot({ startedAt: 150, endedAt: 200 }));

    const newerAgentRunId = `${runId}-reverse`;
    const newerAgent = new Map();
    setAgentEntry({
      dedupe: newerAgent,
      runId: newerAgentRunId,
      ts: 200,
      payload: okPayload(newerAgentRunId, { startedAt: 150, endedAt: 200 }),
    });
    setChatEntry({
      dedupe: newerAgent,
      runId: newerAgentRunId,
      ts: 100,
      payload: {
        runId: newerAgentRunId,
        status: "timeout",
        startedAt: 50,
        endedAt: 100,
        timeoutPhase: "provider",
        providerStarted: true,
      },
    });

    expectTerminalSnapshot(newerAgentRunId, okSnapshot({ startedAt: 150, endedAt: 200 }));
  });

  it("lets a fresh wait observe lifecycle completion after a dedupe snapshot", async () => {
    const dedupe = new Map();
    const runId = "run-lifecycle-after-dedupe";
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 100 },
    });
    setAgentEntry({
      dedupe,
      runId,
      ts: 150,
      payload: okPayload(runId, { startedAt: 100, endedAt: 150 }),
    });

    const wait = waitForTerminalSnapshot(runId, { ignoreCachedSnapshot: true });
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "end", startedAt: 100, endedAt: 200 },
    });

    await expect(wait).resolves.toEqual(okSnapshot({ startedAt: 100, endedAt: 200 }));
  });

  it("preserves an RPC cancel snapshot when late completion writes the same key", () => {
    const dedupe = new Map();
    const runId = "run-cancel-wins";

    setRpcQueueTimeoutEntry({
      dedupe,
      kind: "agent",
      runId,
    });
    setAgentEntry({
      dedupe,
      runId,
      ts: 200,
      payload: okPayload(runId, { endedAt: 200 }),
    });

    expectTerminalSnapshot(runId, RPC_QUEUE_CANCEL_SNAPSHOT);
  });

  it("preserves an RPC cancel snapshot when a later accepted write reuses the key", () => {
    const dedupe = new Map();
    const runId = "run-cancel-wins-over-accepted";

    setRpcQueueTimeoutEntry({
      dedupe,
      kind: "agent",
      runId,
    });
    setAgentEntry({
      dedupe,
      runId,
      ts: 200,
      payload: { runId, status: "accepted" },
    });

    expectTerminalSnapshot(runId, RPC_QUEUE_CANCEL_SNAPSHOT);
  });

  it("lets an earlier terminal completion correct a provisional timeout snapshot", () => {
    const dedupe = new Map();
    const runId = "run-earlier-completion-wins";

    setAgentEntry({
      dedupe,
      runId,
      ts: 200,
      payload: {
        runId,
        status: "timeout",
        timeoutPhase: "provider",
        startedAt: 100,
        endedAt: 200,
      },
    });
    setAgentEntry({
      dedupe,
      runId,
      ts: 250,
      payload: okPayload(runId, { startedAt: 100, endedAt: 190 }),
    });

    expectTerminalSnapshot(runId, okSnapshot({ startedAt: 100, endedAt: 190 }));
  });

  it("does not make bare queue timeouts sticky", () => {
    const dedupe = new Map();
    const runId = "run-queue-timeout-replaced";

    setAgentEntry({
      dedupe,
      runId,
      ts: 100,
      payload: queueTimeoutPayload(runId),
    });
    setAgentEntry({
      dedupe,
      runId,
      ts: 200,
      payload: okPayload(runId, { endedAt: 200 }),
    });

    expectTerminalSnapshot(runId, okSnapshot({ endedAt: 200 }));
  });

  it("preserves an RPC cancel snapshot when late rejection writes the same chat key", () => {
    const dedupe = new Map();
    const runId = "run-cancel-chat-error";

    setRpcQueueTimeoutEntry({
      dedupe,
      kind: "chat",
      runId,
    });
    setChatEntry({
      dedupe,
      runId,
      ts: 200,
      ok: false,
      payload: { runId, status: "error", summary: "late failure", endedAt: 200 },
    });

    expectTerminalSnapshot(runId, RPC_QUEUE_CANCEL_SNAPSHOT);
  });

  it("resolves multiple waiters for the same run id", async () => {
    const dedupe = new Map();
    const runId = "run-multi";
    const first = waitForTerminalSnapshot(runId);
    const second = waitForTerminalSnapshot(runId);

    await Promise.resolve();
    expect(testing.getWaiterCount(runId)).toBe(2);

    setChatEntry({
      dedupe,
      runId,
      payload: okPayload(runId),
    });

    const firstResult = await first;
    const secondResult = await second;
    if (!firstResult || !secondResult) {
      throw new Error("expected waiters to resolve");
    }
    expect(firstResult.status).toBe("ok");
    expect(firstResult.error).toBeUndefined();
    expect(secondResult.status).toBe("ok");
    expect(secondResult.error).toBeUndefined();
    expect(testing.getWaiterCount(runId)).toBe(0);
  });

  it("cleans up waiter registration on timeout", async () => {
    const runId = "run-timeout";
    const wait = waitForTerminalSnapshot(runId, { timeoutMs: 20 });

    await Promise.resolve();
    expect(testing.getWaiterCount(runId)).toBe(1);

    await vi.advanceTimersByTimeAsync(25);
    await expect(wait).resolves.toBeNull();
    expect(testing.getWaiterCount(runId)).toBe(0);
  });
});
