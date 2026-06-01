import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_RUN_ABORTED_ERROR } from "../../agents/run-termination.js";
import type { DedupeEntry } from "../server-shared.js";
import {
  testing,
  readTerminalSnapshotFromGatewayDedupe,
  setGatewayDedupeEntry,
  waitForTerminalGatewayDedupe,
} from "./agent-wait-dedupe.js";

describe("agent wait dedupe helper", () => {
  function setRunEntry(params: {
    dedupe: Map<string, DedupeEntry>;
    kind: "agent" | "chat";
    runId: string;
    ts?: number;
    ok?: boolean;
    payload: Record<string, unknown>;
  }) {
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

  function setRpcQueueTimeoutEntry(params: {
    dedupe: Map<string, DedupeEntry>;
    kind: "agent" | "chat";
    runId: string;
    ts?: number;
  }) {
    setRunEntry({
      dedupe: params.dedupe,
      kind: params.kind,
      runId: params.runId,
      ts: params.ts ?? 100,
      payload: {
        runId: params.runId,
        status: "timeout",
        stopReason: "rpc",
        timeoutPhase: "queue",
        providerStarted: false,
        endedAt: 100,
      },
    });
  }

  function expectTerminalSnapshot(
    dedupe: Map<string, DedupeEntry>,
    runId: string,
    snapshot: Record<string, unknown>,
  ) {
    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual(snapshot);
  }

  const RPC_QUEUE_TIMEOUT_SNAPSHOT = {
    status: "timeout",
    endedAt: 100,
    error: undefined,
    stopReason: "rpc",
    timeoutPhase: "queue",
    providerStarted: false,
  } as const;

  beforeEach(() => {
    testing.resetWaiters();
    vi.useFakeTimers();
  });

  afterEach(() => {
    testing.resetWaiters();
    vi.useRealTimers();
  });

  it("unblocks waiters when a terminal chat dedupe entry is written", async () => {
    const dedupe = new Map();
    const runId = "run-chat-terminal";
    const waiter = waitForTerminalGatewayDedupe({
      dedupe,
      runId,
      timeoutMs: 1_000,
    });

    await Promise.resolve();
    expect(testing.getWaiterCount(runId)).toBe(1);

    setRunEntry({
      dedupe,
      kind: "chat",
      runId,
      payload: {
        runId,
        status: "ok",
        startedAt: 100,
        endedAt: 200,
      },
    });

    await expect(waiter).resolves.toEqual({
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      error: undefined,
    });
    expect(testing.getWaiterCount(runId)).toBe(0);
  });

  it("preserves structured yield metadata from terminal agent results", () => {
    const dedupe = new Map();
    const runId = "run-yielded";

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      payload: {
        runId,
        status: "ok",
        startedAt: 100,
        endedAt: 200,
        result: {
          meta: {
            stopReason: "end_turn",
            livenessState: "paused",
            yielded: true,
          },
        },
      },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      error: undefined,
      stopReason: "end_turn",
      livenessState: "paused",
      yielded: true,
    });
  });

  it("preserves timeout attribution from terminal agent result metadata", () => {
    const dedupe = new Map();
    const runId = "run-provider-timeout";

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      payload: {
        runId,
        status: "timeout",
        startedAt: 100,
        endedAt: 200,
        result: {
          meta: {
            timeoutPhase: "provider",
            providerStarted: true,
          },
        },
      },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
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

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      payload: {
        runId,
        status: "error",
        startedAt: 100,
        endedAt: 200,
        error: "model timed out",
        result: {
          meta: {
            livenessState: "blocked",
            timeoutPhase: "provider",
            providerStarted: true,
          },
        },
      },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
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

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      payload: {
        runId,
        status: "ok",
        startedAt: 100,
        endedAt: 200,
        error: "Context overflow: prompt too large for the model.",
        result: {
          meta: {
            livenessState: "blocked",
          },
        },
      },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
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

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      payload: {
        runId,
        status: "ok",
        startedAt: 100,
        endedAt: 200,
        result: {
          meta: {
            stopReason: "aborted",
          },
        },
      },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
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
    const waiter = waitForTerminalGatewayDedupe({
      dedupe,
      runId,
      timeoutMs: 1_000,
    });

    await Promise.resolve();
    expect(testing.getWaiterCount(runId)).toBe(1);

    setRunEntry({
      dedupe,
      kind: "agent",
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
    setRunEntry({
      dedupe,
      kind: "chat",
      runId,
      payload: {
        runId,
        status: "ok",
      },
    });
    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      payload: {
        runId,
        status: "accepted",
      },
    });

    const snapshot = readTerminalSnapshotFromGatewayDedupe({
      dedupe,
      runId,
    });
    expect(snapshot).toBeNull();

    const blockedWait = waitForTerminalGatewayDedupe({
      dedupe,
      runId,
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(30);
    await expect(blockedWait).resolves.toBeNull();
    expect(testing.getWaiterCount(runId)).toBe(0);
  });

  it("uses newer terminal chat snapshot when agent entry is non-terminal", () => {
    const dedupe = new Map();
    const runId = "run-nonterminal-agent-with-newer-chat";
    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      ts: 100,
      payload: {
        runId,
        status: "accepted",
      },
    });
    setRunEntry({
      dedupe,
      kind: "chat",
      runId,
      ts: 200,
      payload: {
        runId,
        status: "ok",
        startedAt: 1,
        endedAt: 2,
      },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      status: "ok",
      startedAt: 1,
      endedAt: 2,
      error: undefined,
    });
  });

  it("ignores stale agent snapshots when waiting for an active chat run", async () => {
    const dedupe = new Map();
    const runId = "run-chat-active-ignore-agent";
    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      payload: {
        runId,
        status: "ok",
      },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
        ignoreAgentTerminalSnapshot: true,
      }),
    ).toBeNull();

    const wait = waitForTerminalGatewayDedupe({
      dedupe,
      runId,
      timeoutMs: 1_000,
      ignoreAgentTerminalSnapshot: true,
    });
    await Promise.resolve();
    expect(testing.getWaiterCount(runId)).toBe(1);

    setRunEntry({
      dedupe,
      kind: "chat",
      runId,
      payload: {
        runId,
        status: "ok",
        startedAt: 123,
        endedAt: 456,
      },
    });

    await expect(wait).resolves.toEqual({
      status: "ok",
      startedAt: 123,
      endedAt: 456,
      error: undefined,
    });
  });

  it("prefers the freshest terminal snapshot when agent/chat dedupe keys collide", () => {
    const runId = "run-collision";
    const dedupe = new Map();

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      ts: 100,
      payload: { runId, status: "ok", startedAt: 10, endedAt: 20 },
    });
    setRunEntry({
      dedupe,
      kind: "chat",
      runId,
      ts: 200,
      ok: false,
      payload: { runId, status: "error", startedAt: 30, endedAt: 40, error: "chat failed" },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      status: "error",
      startedAt: 30,
      endedAt: 40,
      error: "chat failed",
    });

    const dedupeReverse = new Map();
    setRunEntry({
      dedupe: dedupeReverse,
      kind: "chat",
      runId,
      ts: 100,
      payload: { runId, status: "ok", startedAt: 1, endedAt: 2 },
    });
    setRunEntry({
      dedupe: dedupeReverse,
      kind: "agent",
      runId,
      ts: 200,
      payload: { runId, status: "timeout", startedAt: 3, endedAt: 4, error: "still running" },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe: dedupeReverse,
        runId,
      }),
    ).toEqual({
      status: "timeout",
      startedAt: 3,
      endedAt: 4,
      error: "still running",
    });
  });

  it("preserves an RPC cancel snapshot when late completion writes the same key", () => {
    const dedupe = new Map();
    const runId = "run-cancel-wins";

    setRpcQueueTimeoutEntry({
      dedupe,
      kind: "agent",
      runId,
    });
    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      ts: 200,
      payload: { runId, status: "ok", endedAt: 200 },
    });

    expectTerminalSnapshot(dedupe, runId, RPC_QUEUE_TIMEOUT_SNAPSHOT);
  });

  it("preserves an RPC cancel snapshot when a later accepted write reuses the key", () => {
    const dedupe = new Map();
    const runId = "run-cancel-wins-over-accepted";

    setRpcQueueTimeoutEntry({
      dedupe,
      kind: "agent",
      runId,
    });
    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      ts: 200,
      payload: { runId, status: "accepted" },
    });

    expectTerminalSnapshot(dedupe, runId, RPC_QUEUE_TIMEOUT_SNAPSHOT);
  });

  it("lets an earlier terminal completion correct a provisional timeout snapshot", () => {
    const dedupe = new Map();
    const runId = "run-earlier-completion-wins";

    setRunEntry({
      dedupe,
      kind: "agent",
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
    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      ts: 250,
      payload: {
        runId,
        status: "ok",
        startedAt: 100,
        endedAt: 190,
      },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      status: "ok",
      startedAt: 100,
      endedAt: 190,
      error: undefined,
    });
  });

  it("does not make bare queue timeouts sticky", () => {
    const dedupe = new Map();
    const runId = "run-queue-timeout-replaced";

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      ts: 100,
      payload: {
        runId,
        status: "timeout",
        timeoutPhase: "queue",
        providerStarted: false,
        endedAt: 100,
      },
    });
    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      ts: 200,
      payload: { runId, status: "ok", endedAt: 200 },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      status: "ok",
      endedAt: 200,
      error: undefined,
    });
  });

  it("preserves an RPC cancel snapshot when late rejection writes the same chat key", () => {
    const dedupe = new Map();
    const runId = "run-cancel-chat-error";

    setRpcQueueTimeoutEntry({
      dedupe,
      kind: "chat",
      runId,
    });
    setRunEntry({
      dedupe,
      kind: "chat",
      runId,
      ts: 200,
      ok: false,
      payload: { runId, status: "error", summary: "late failure", endedAt: 200 },
    });

    expectTerminalSnapshot(dedupe, runId, RPC_QUEUE_TIMEOUT_SNAPSHOT);
  });

  it("resolves multiple waiters for the same run id", async () => {
    const dedupe = new Map();
    const runId = "run-multi";
    const first = waitForTerminalGatewayDedupe({
      dedupe,
      runId,
      timeoutMs: 1_000,
    });
    const second = waitForTerminalGatewayDedupe({
      dedupe,
      runId,
      timeoutMs: 1_000,
    });

    await Promise.resolve();
    expect(testing.getWaiterCount(runId)).toBe(2);

    setRunEntry({
      dedupe,
      kind: "chat",
      runId,
      payload: { runId, status: "ok" },
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
    const dedupe = new Map();
    const runId = "run-timeout";
    const wait = waitForTerminalGatewayDedupe({
      dedupe,
      runId,
      timeoutMs: 20,
    });

    await Promise.resolve();
    expect(testing.getWaiterCount(runId)).toBe(1);

    await vi.advanceTimersByTimeAsync(25);
    await expect(wait).resolves.toBeNull();
    expect(testing.getWaiterCount(runId)).toBe(0);
  });
});
