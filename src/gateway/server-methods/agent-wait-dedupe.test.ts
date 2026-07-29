import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DedupeEntry } from "../server-shared.js";
import { setGatewayDedupeEntry } from "./agent-job.js";
import { agentHandlers } from "./agent.js";

function waitThroughGateway(params: { runId: string; timeoutMs: number }) {
  const respond = vi.fn();
  const handler = expectDefined(
    agentHandlers["agent.wait"],
    'agentHandlers["agent.wait"] test invariant',
  );
  const promise = Promise.resolve(
    handler({
      params,
      respond,
      context: { chatAbortControllers: new Map() },
    } as unknown as Parameters<typeof handler>[0]),
  );
  return { promise, respond };
}

function completeRun(dedupe: Map<string, DedupeEntry>, runId: string): void {
  setGatewayDedupeEntry({
    dedupe,
    key: `agent:${runId}`,
    entry: {
      ts: Date.now(),
      ok: true,
      payload: { runId, status: "ok", startedAt: 100, endedAt: 200 },
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("agent.wait gateway dedupe observations", () => {
  it("resolves concurrent waiters when the terminal dedupe entry lands", async () => {
    const runId = "run-public-concurrent-waiters";
    const dedupe = new Map<string, DedupeEntry>();
    const first = waitThroughGateway({ runId, timeoutMs: 1_000 });
    const second = waitThroughGateway({ runId, timeoutMs: 1_000 });

    await Promise.resolve();
    completeRun(dedupe, runId);
    await Promise.all([first.promise, second.promise]);

    const expected = {
      runId,
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      error: undefined,
      stopReason: undefined,
      livenessState: undefined,
      yielded: undefined,
      pendingError: undefined,
      timeoutPhase: undefined,
      providerStarted: undefined,
    };
    expect(first.respond).toHaveBeenCalledWith(true, expected);
    expect(second.respond).toHaveBeenCalledWith(true, expected);
  });

  it("lets a fresh wait observe completion after an earlier waiter times out", async () => {
    vi.useFakeTimers();
    const runId = "run-public-timeout-cleanup";
    const dedupe = new Map<string, DedupeEntry>();
    const timedOut = waitThroughGateway({ runId, timeoutMs: 10 });

    await vi.advanceTimersByTimeAsync(11);
    await timedOut.promise;
    expect(timedOut.respond).toHaveBeenCalledWith(true, {
      runId,
      status: "timeout",
      timeoutPhase: "queue",
      providerStarted: false,
    });

    completeRun(dedupe, runId);
    const completed = waitThroughGateway({ runId, timeoutMs: 0 });
    await completed.promise;
    expect(completed.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId, status: "ok", endedAt: 200 }),
    );
  });

  it.each([
    {
      name: "late completion",
      payload: { status: "ok", startedAt: 100, endedAt: 300 },
      expected: { status: "timeout", endedAt: 200, timeoutPhase: "provider" },
    },
    {
      name: "late restart cancellation",
      payload: { status: "error", startedAt: 100, endedAt: 300, stopReason: "restart" },
      expected: { status: "timeout", endedAt: 200, timeoutPhase: "provider" },
    },
    {
      name: "earlier user cancellation",
      payload: { status: "error", startedAt: 100, endedAt: 150, stopReason: "rpc" },
      expected: { status: "error", endedAt: 150, stopReason: "rpc" },
    },
  ])("merges $name across agent and chat observations", async ({ name, payload, expected }) => {
    for (const timeoutFirst of [true, false]) {
      const runId = `run-cross-source-${name.replaceAll(" ", "-")}-${timeoutFirst}`;
      const dedupe = new Map<string, DedupeEntry>();
      const timeout = {
        dedupe,
        key: `agent:${runId}`,
        entry: {
          ts: 200,
          ok: false,
          payload: {
            runId,
            status: "timeout",
            startedAt: 100,
            endedAt: 200,
            timeoutPhase: "provider",
          },
        },
      };
      const other = {
        dedupe,
        key: `chat:${runId}`,
        entry: { ts: 300, ok: payload.status === "ok", payload: { runId, ...payload } },
      };

      for (const observation of timeoutFirst ? [timeout, other] : [other, timeout]) {
        setGatewayDedupeEntry(observation);
      }

      const waiter = waitThroughGateway({ runId, timeoutMs: 0 });
      await waiter.promise;
      expect(waiter.respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ runId, ...expected }),
      );
    }
  });
});
