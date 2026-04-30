import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DedupeEntry } from "../server-shared.js";
import {
  __testing,
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

  beforeEach(() => {
    __testing.resetWaiters();
    vi.useFakeTimers();
  });

  afterEach(() => {
    __testing.resetWaiters();
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
    expect(__testing.getWaiterCount(runId)).toBe(1);

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
    expect(__testing.getWaiterCount(runId)).toBe(0);
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
    expect(__testing.getWaiterCount(runId)).toBe(0);
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
    expect(__testing.getWaiterCount(runId)).toBe(1);

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

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      ts: 100,
      payload: { runId, status: "timeout", stopReason: "rpc", endedAt: 100 },
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
      status: "timeout",
      endedAt: 100,
      error: undefined,
      stopReason: "rpc",
    });
  });

  it("preserves an RPC cancel snapshot when late rejection writes the same chat key", () => {
    const dedupe = new Map();
    const runId = "run-cancel-chat-error";

    setRunEntry({
      dedupe,
      kind: "chat",
      runId,
      ts: 100,
      payload: { runId, status: "timeout", stopReason: "rpc", endedAt: 100 },
    });
    setRunEntry({
      dedupe,
      kind: "chat",
      runId,
      ts: 200,
      ok: false,
      payload: { runId, status: "error", summary: "late failure", endedAt: 200 },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      status: "timeout",
      endedAt: 100,
      error: undefined,
      stopReason: "rpc",
    });
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
    expect(__testing.getWaiterCount(runId)).toBe(2);

    setRunEntry({
      dedupe,
      kind: "chat",
      runId,
      payload: { runId, status: "ok" },
    });

    await expect(first).resolves.toEqual(
      expect.objectContaining({
        status: "ok",
      }),
    );
    await expect(second).resolves.toEqual(
      expect.objectContaining({
        status: "ok",
      }),
    );
    expect(__testing.getWaiterCount(runId)).toBe(0);
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
    expect(__testing.getWaiterCount(runId)).toBe(1);

    await vi.advanceTimersByTimeAsync(25);
    await expect(wait).resolves.toBeNull();
    expect(__testing.getWaiterCount(runId)).toBe(0);
  });
});
