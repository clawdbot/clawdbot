import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { agentHandlers } from "../server-methods/agent.js";
import type { DedupeEntry } from "../server-shared.js";
import { setGatewayDedupeEntry } from "./agent-job.js";

function waitThroughGateway(
  params: { runId: string; timeoutMs: number },
  activeKind?: "agent" | "chat",
) {
  const respond = vi.fn();
  const handler = expectDefined(
    agentHandlers["agent.wait"],
    'agentHandlers["agent.wait"] test invariant',
  );
  const promise = Promise.resolve(
    handler({
      params,
      respond,
      context: {
        chatAbortControllers: activeKind
          ? new Map([[params.runId, { kind: activeKind }]])
          : new Map(),
        chatQueuedTurns: new Map(),
      },
    } as unknown as Parameters<typeof handler>[0]),
  );
  return { promise, respond };
}

function completeRun(
  dedupe: Map<string, DedupeEntry>,
  runId: string,
  source: "agent" | "chat" = "agent",
): void {
  setGatewayDedupeEntry({
    dedupe,
    key: `${source}:${runId}`,
    entry: {
      ts: Date.now(),
      ok: true,
      payload: { runId, status: "ok", startedAt: 100, endedAt: 200 },
    },
  });
}

function terminalReceipt(runId: string) {
  return {
    runId,
    sessionId: "session-1",
    turnId: "turn-1",
    requested: { provider: "openai", model: "gpt-primary" },
    effective: { provider: "openai", model: "gpt-alternate", responseModel: "gpt-alternate" },
    successfulToolNames: ["read"],
    rerouted: true,
    terminalDisposition: "visible",
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("agent.wait gateway dedupe observations", () => {
  it.each([
    ["agent", "timeout"],
    ["chat", "ok"],
  ] as const)("uses the %s abort entry to select the run observation", async (kind, status) => {
    const runId = `run-kind-${kind}`;
    const dedupe = new Map<string, DedupeEntry>();
    setGatewayDedupeEntry({
      dedupe,
      key: `agent:${runId}`,
      entry: {
        ts: 100,
        ok: false,
        payload: { runId, status: "timeout", endedAt: 100, timeoutPhase: "provider" },
      },
    });
    setGatewayDedupeEntry({
      dedupe,
      key: `chat:${runId}`,
      entry: { ts: 200, ok: true, payload: { runId, status: "ok", endedAt: 200 } },
    });

    const waiter = waitThroughGateway({ runId, timeoutMs: 0 }, kind);
    await waiter.promise;
    expect(waiter.respond).toHaveBeenCalledWith(true, expect.objectContaining({ runId, status }));
  });

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

  it.each(
    ([undefined, "agent", "chat"] as const).flatMap((activeKind) =>
      [0, 10].map((timeoutMs) => ({ activeKind, timeoutMs })),
    ),
  )(
    "keeps $activeKind observation timeout after $timeoutMs ms nonterminal",
    async ({ activeKind, timeoutMs }) => {
      vi.useFakeTimers();
      const runId = `run-public-timeout-${activeKind ?? "untracked"}-${timeoutMs}`;
      const dedupe = new Map<string, DedupeEntry>();
      const timedOut = waitThroughGateway({ runId, timeoutMs }, activeKind);

      await vi.advanceTimersByTimeAsync(timeoutMs);
      await timedOut.promise;
      expect(timedOut.respond).toHaveBeenCalledWith(true, {
        runId,
        status: "timeout",
      });

      completeRun(dedupe, runId, activeKind);
      const completed = waitThroughGateway({ runId, timeoutMs: 0 }, activeKind);
      await completed.promise;
      expect(completed.respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ runId, status: "ok", endedAt: 200 }),
      );
    },
  );

  it("attributes lifecycle reset without caching a terminal run outcome", async () => {
    vi.useFakeTimers();
    const runId = "run-public-lifecycle-reset";
    const dedupe = new Map<string, DedupeEntry>();
    const interrupted = waitThroughGateway({ runId, timeoutMs: 1_000 });

    await drainGlobalSingletonLifecycleState("restart");
    await interrupted.promise;
    expect(interrupted.respond).toHaveBeenCalledWith(true, {
      runId,
      status: "timeout",
      timeoutPhase: "gateway_draining",
    });

    const fresh = waitThroughGateway({ runId, timeoutMs: 0 });
    await fresh.promise;
    expect(fresh.respond).toHaveBeenCalledWith(true, { runId, status: "timeout" });

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
    {
      name: "earlier writer supersession",
      payload: { status: "error", startedAt: 100, endedAt: 150, stopReason: "superseded" },
      expected: { status: "error", endedAt: 150, stopReason: "superseded" },
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

  it.each(["lifecycle-first", "dedupe-first"] as const)(
    "keeps terminal evidence when sticky status arrives $0",
    async (order) => {
      const runId = `run-reply-merge-${order}`;
      const dedupe = new Map<string, DedupeEntry>();
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 100 },
      });
      const lifecycleEnd = () =>
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: {
            phase: "end",
            startedAt: 100,
            endedAt: 300,
            terminalDelivery: {
              status: "sent",
              resultCount: 1,
              target: "private-target",
            },
            terminalReceipt: terminalReceipt(runId),
            terminalReply: { disposition: "visible", text: "canonical reply" },
          },
        });
      const dedupeTimeout = () =>
        setGatewayDedupeEntry({
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
        });

      for (const observe of order === "lifecycle-first"
        ? [lifecycleEnd, dedupeTimeout]
        : [dedupeTimeout, lifecycleEnd]) {
        observe();
      }

      const waiter = waitThroughGateway({ runId, timeoutMs: 0 });
      await waiter.promise;
      expect(waiter.respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          runId,
          status: "timeout",
          terminalDelivery: { status: "sent", resultCount: 1 },
          terminalReceipt: terminalReceipt(runId),
          terminalReply: { disposition: "visible", text: "canonical reply" },
        }),
      );
      expect(JSON.stringify(waiter.respond.mock.calls[0]?.[1])).not.toContain("private-target");
    },
  );
});
