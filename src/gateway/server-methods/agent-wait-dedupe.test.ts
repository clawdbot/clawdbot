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
});
