import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionObserverDigestSchema,
  type SessionObserverDigest,
} from "../../packages/gateway-protocol/src/schema/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeSessionObserverModelOutput } from "./session-observer-model.js";
import {
  createHarness,
  declareObserverVisibility,
  event,
  flushObserver,
  modelMessage,
  preparedModel,
  persistedLiveDigest,
  resetSessionObserverEventSequence,
  startAndAddToolNotes,
} from "./session-observer.test-utils.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSessionObserverEventSequence();
});

describe("session observer", () => {
  it("waits for four notes and twelve seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    startAndAddToolNotes(harness.observer);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(11_999);
    expect(harness.completeModel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushObserver();
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.subscribers.get("agent:main:session-1")).toHaveLength(1);
    expect(harness.prepareModel).toHaveBeenCalledOnce();
    expect(harness.completeModel).toHaveBeenCalledOnce();
    harness.observer.dispose();
  });

  it("publishes safe preambles immediately without a model call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const harness = createHarness();
    harness.observer.handleEvent(event({ stream: "lifecycle", data: { phase: "start" } }));

    harness.observer.handleEvent(
      event({
        stream: "item",
        data: {
          kind: "preamble",
          phase: "update",
          progressText: "**Checking** the [gateway](https://example.com) [[reply_to_current]]",
        },
      }),
    );
    await flushObserver();

    expect(harness.completeModel).not.toHaveBeenCalled();
    expect(harness.broadcastToConnIds).toHaveBeenCalledOnce();
    expect(harness.broadcastToConnIds.mock.calls[0]?.[1]).toMatchObject({
      headline: "Checking the gateway",
      health: "on-track",
      revision: 1,
      runId: "run-1",
    });
    expect(harness.persistDigest).toHaveBeenCalledOnce();
    harness.observer.dispose();
  });

  it("publishes preambles to visible session-list subscribers without a utility model", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const harness = createHarness({
      subscribe: false,
      broadSubscribe: true,
      utilityModelRef: null,
    });

    harness.observer.handleEvent(
      event({
        stream: "item",
        data: { kind: "preamble", phase: "update", progressText: "Inspecting mobile rows" },
      }),
    );
    await flushObserver();

    expect(harness.prepareModel).not.toHaveBeenCalled();
    expect(harness.completeModel).not.toHaveBeenCalled();
    expect(harness.broadcastToConnIds).toHaveBeenCalledWith(
      "session.observer",
      expect.objectContaining({ headline: "Inspecting mobile rows", health: "on-track" }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );
    expect(harness.persistDigest).toHaveBeenCalledOnce();
    harness.observer.dispose();
  });

  it("terminalizes a preamble-only digest without a utility model", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness({
      subscribe: false,
      broadSubscribe: true,
      utilityModelRef: null,
    });
    harness.observer.handleEvent(
      event({
        stream: "item",
        data: { kind: "preamble", phase: "update", progressText: "Running tests" },
      }),
    );
    await vi.advanceTimersByTimeAsync(100);
    harness.observer.handleEvent(
      event({
        stream: "item",
        data: { kind: "preamble", phase: "update", progressText: "Wrapping up" },
      }),
    );
    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 40_000 },
      }),
    );
    await flushObserver();

    expect(harness.completeModel).not.toHaveBeenCalled();
    expect(harness.broadcastToConnIds.mock.calls.at(-1)?.[1]).toMatchObject({
      headline: "Wrapping up",
      health: "done",
      revision: 3,
    });
    const terminalCount = harness.broadcastToConnIds.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.broadcastToConnIds).toHaveBeenCalledTimes(terminalCount);
    harness.observer.dispose();
  });

  it("does not cap model-free preamble headlines at six sessions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const harness = createHarness({
      subscribe: false,
      broadSubscribe: true,
      utilityModelRef: null,
    });

    for (let index = 0; index < 7; index += 1) {
      harness.observer.handleEvent(
        event({
          runId: `run-${index}`,
          sessionKey: `agent:main:session-${index}`,
          stream: "item",
          data: { kind: "preamble", phase: "update", progressText: `Session ${index}` },
        }),
      );
    }

    expect(harness.broadcastToConnIds).toHaveBeenCalledTimes(7);
    harness.observer.dispose();
  });

  it("coalesces incremental preamble snapshots behind a trailing update", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const harness = createHarness();
    harness.observer.handleEvent(event({ stream: "lifecycle", data: { phase: "start" } }));

    for (const progressText of ["Checking", "Checking the gateway", "Running tests"]) {
      harness.observer.handleEvent(
        event({
          stream: "item",
          data: { kind: "preamble", phase: "update", progressText },
        }),
      );
    }

    expect(harness.broadcastToConnIds).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.broadcastToConnIds).toHaveBeenCalledTimes(2);
    expect(harness.broadcastToConnIds.mock.calls.at(-1)?.[1]).toMatchObject({
      headline: "Running tests",
      revision: 2,
    });
    harness.observer.dispose();
  });

  it("does not let an older model result overwrite a newer preamble", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let resolveModel: ((value: ReturnType<typeof modelMessage>) => void) | undefined;
    const completeModel = vi.fn(
      () =>
        new Promise<ReturnType<typeof modelMessage>>((resolve) => {
          resolveModel = resolve;
        }),
    );
    const harness = createHarness({ completeModel });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(11_500);
    harness.observer.handleEvent(
      event({
        stream: "item",
        data: { kind: "preamble", phase: "update", progressText: "Checking files" },
      }),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(completeModel).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(100);
    harness.observer.handleEvent(
      event({
        stream: "item",
        data: { kind: "preamble", phase: "update", progressText: "Running focused tests" },
      }),
    );
    resolveModel?.(modelMessage({ headline: "Stale model summary", health: "on-track" }));
    await flushObserver();
    expect(
      harness.broadcastToConnIds.mock.calls.some(
        (call) => (call[1] as SessionObserverDigest).headline === "Stale model summary",
      ),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(1_900);
    expect(harness.broadcastToConnIds.mock.calls.at(-1)?.[1]).toMatchObject({
      headline: "Running focused tests",
    });
    harness.observer.dispose();
  });

  it("aborts a live assessment when the run becomes terminal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let firstCall = true;
    const completeModel = vi.fn(async (params: { options: { signal: AbortSignal } }) => {
      if (firstCall) {
        firstCall = false;
        return await new Promise<ReturnType<typeof modelMessage>>((_resolve, reject) => {
          params.options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }
      return modelMessage({ headline: "Run completed", health: "done" });
    });
    const harness = createHarness({ completeModel });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(completeModel).toHaveBeenCalledOnce();

    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 40_000 },
      }),
    );
    await flushObserver();

    expect(completeModel).toHaveBeenCalledTimes(2);
    expect(harness.broadcastToConnIds.mock.calls.at(-1)?.[1]).toMatchObject({
      headline: "Run completed",
      health: "done",
    });
    harness.observer.dispose();
  });

  it("retires a queued preamble when a richer digest is accepted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let resolveModel: ((value: ReturnType<typeof modelMessage>) => void) | undefined;
    const completeModel = vi.fn(
      () =>
        new Promise<ReturnType<typeof modelMessage>>((resolve) => {
          resolveModel = resolve;
        }),
    );
    const harness = createHarness({ completeModel });
    harness.observer.handleEvent(event({ stream: "lifecycle", data: { phase: "start" } }));
    await vi.advanceTimersByTimeAsync(12_000);
    harness.observer.handleEvent(
      event({
        stream: "item",
        data: { kind: "preamble", phase: "update", progressText: "Checking files" },
      }),
    );
    await vi.advanceTimersByTimeAsync(100);
    harness.observer.handleEvent(
      event({
        stream: "item",
        data: { kind: "preamble", phase: "update", progressText: "Running tests" },
      }),
    );
    for (let index = 0; index < 3; index += 1) {
      harness.observer.handleEvent(
        event({ stream: "tool", data: { phase: "start", name: "read", args: { index } } }),
      );
    }
    await flushObserver();
    expect(completeModel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_900);
    expect(harness.broadcastToConnIds.mock.calls.at(-1)?.[1]).toMatchObject({
      headline: "Running tests",
    });

    resolveModel?.(modelMessage({ headline: "Reviewing test results", health: "on-track" }));
    await flushObserver();
    const acceptedCount = harness.broadcastToConnIds.mock.calls.length;
    expect(harness.broadcastToConnIds.mock.calls.at(-1)?.[1]).toMatchObject({
      headline: "Reviewing test results",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.broadcastToConnIds).toHaveBeenCalledTimes(acceptedCount);
    harness.observer.dispose();
  });

  it("never includes tool results or command output and redacts tool arguments", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    const runtimeDetail = "runtime-detail-that-must-not-leave";
    const commandOutput = "command-output-that-must-not-leave";
    const toolCommand = ["password", "test-password"].join("=");

    harness.observer.handleEvent(event({ stream: "lifecycle", data: { phase: "start" } }));
    harness.observer.handleEvent(
      event({
        stream: "tool",
        data: {
          phase: "start",
          name: "exec",
          args: { token: "test-token", command: toolCommand, content: runtimeDetail },
        },
      }),
    );
    harness.observer.handleEvent(
      event({
        stream: "tool",
        data: { phase: "result", result: { content: "ok", details: runtimeDetail } },
      }),
    );
    harness.observer.handleEvent(
      event({
        stream: "command_output",
        data: {
          phase: "end",
          title: "Command",
          status: "failed",
          exitCode: 1,
          output: commandOutput,
        },
      }),
    );
    harness.observer.handleEvent(
      event({ stream: "tool", data: { phase: "start", name: "read", args: { path: "a" } } }),
    );
    harness.observer.handleEvent(
      event({ stream: "tool", data: { phase: "start", name: "read", args: { path: "b" } } }),
    );

    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    const prompt = String(
      harness.completeModel.mock.calls[0]?.[0]?.context?.messages?.[0]?.content,
    );
    expect(prompt).not.toContain("test-token");
    expect(prompt).not.toContain(runtimeDetail);
    expect(prompt).not.toContain(commandOutput);
    expect(prompt).not.toContain(toolCommand);
    expect(prompt).toContain("***");
    harness.observer.dispose();
  });

  it("coalesces a burst behind one in-flight completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let resolveFirst: ((value: ReturnType<typeof modelMessage>) => void) | undefined;
    const completeModel = vi.fn(
      () =>
        new Promise<ReturnType<typeof modelMessage>>((resolve) => {
          resolveFirst ??= resolve;
          if (completeModel.mock.calls.length > 1) {
            resolve(modelMessage({ headline: "Continuing the work", health: "on-track" }));
          }
        }),
    );
    const harness = createHarness({ completeModel });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(completeModel).toHaveBeenCalledOnce();

    for (let index = 0; index < 4; index += 1) {
      harness.observer.handleEvent(
        event({
          stream: "tool",
          data: { phase: "start", name: "read", args: { path: `burst-${index}` } },
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(9_000);
    expect(completeModel).toHaveBeenCalledOnce();

    resolveFirst?.(modelMessage({ headline: "Starting the work", health: "on-track" }));
    await flushObserver();
    expect(completeModel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushObserver();
    expect(completeModel).toHaveBeenCalledTimes(2);
    harness.observer.dispose();
  });

  it("does not start completion after observation ends during model preparation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let resolvePreparation: ((value: ReturnType<typeof preparedModel>) => void) | undefined;
    const prepareModel = vi.fn(
      () =>
        new Promise<ReturnType<typeof preparedModel>>((resolve) => {
          resolvePreparation = resolve;
        }),
    );
    const harness = createHarness({ prepareModel });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(prepareModel).toHaveBeenCalledOnce();

    harness.subscribers.unsubscribe("conn-1", "agent:main:session-1");
    resolvePreparation?.(preparedModel());
    await flushObserver();

    expect(harness.completeModel).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it("times out stalled model preparation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const prepareModel = vi.fn(
      () =>
        new Promise<never>(() => {
          // Intentionally unresolved: the observer timeout owns this test path.
        }),
    );
    const harness = createHarness({ prepareModel });
    startAndAddToolNotes(harness.observer);

    await vi.advanceTimersByTimeAsync(34_000);
    await flushObserver();

    expect(prepareModel).toHaveBeenCalledOnce();
    expect(harness.completeModel).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it("reserves the fortieth digest for the terminal status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    harness.observer.handleEvent(event({ stream: "lifecycle", data: { phase: "start" } }));

    for (let digest = 0; digest < 40; digest += 1) {
      for (let note = 0; note < 4; note += 1) {
        harness.observer.handleEvent(
          event({
            stream: "tool",
            data: { phase: "start", name: "read", args: { path: `${digest}-${note}` } },
          }),
        );
      }
      await vi.advanceTimersByTimeAsync(12_000);
      await flushObserver();
    }

    expect(harness.completeModel).toHaveBeenCalledTimes(39);
    expect(harness.broadcastToConnIds).toHaveBeenCalledTimes(39);

    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: Date.now() },
      }),
    );
    await flushObserver();

    expect(harness.completeModel).toHaveBeenCalledTimes(40);
    expect(harness.broadcastToConnIds).toHaveBeenCalledTimes(40);
    const finalDigest = harness.broadcastToConnIds.mock.calls.at(-1)?.[1] as
      | SessionObserverDigest
      | undefined;
    expect(finalDigest?.health).toBe("done");
    harness.observer.dispose();
  });

  it("disables a run after two consecutive model failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const completeModel = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const harness = createHarness({ completeModel });
    startAndAddToolNotes(harness.observer);

    await vi.advanceTimersByTimeAsync(24_000);
    await flushObserver();
    expect(completeModel).toHaveBeenCalledTimes(2);

    for (let index = 0; index < 4; index += 1) {
      harness.observer.handleEvent(
        event({ stream: "tool", data: { phase: "start", name: "read", args: { index } } }),
      );
    }
    await vi.advanceTimersByTimeAsync(24_000);
    expect(completeModel).toHaveBeenCalledTimes(2);
    harness.observer.dispose();
  });

  it("does not observe without subscribers and stops after unsubscribe", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const unsubscribed = createHarness({ subscribe: false });
    startAndAddToolNotes(unsubscribed.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(unsubscribed.completeModel).not.toHaveBeenCalled();
    unsubscribed.observer.dispose();

    const subscribed = createHarness();
    startAndAddToolNotes(subscribed.observer);
    subscribed.subscribers.unsubscribe("conn-1", "agent:main:session-1");
    await vi.advanceTimersByTimeAsync(12_000);
    expect(subscribed.completeModel).not.toHaveBeenCalled();
    subscribed.observer.dispose();
  });

  it("does not observe for a subscribed connection that never declares visibility", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness({ visible: false });

    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);

    expect(harness.prepareModel).not.toHaveBeenCalled();
    expect(harness.completeModel).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it("suspends when hidden and resumes on the next event after becoming visible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledOnce();

    harness.observer.setConnectionVisibility("conn-1", false);
    for (let index = 0; index < 4; index += 1) {
      harness.observer.handleEvent(
        event({ stream: "tool", data: { phase: "start", name: "read", args: { index } } }),
      );
    }
    await vi.advanceTimersByTimeAsync(12_000);
    expect(harness.completeModel).toHaveBeenCalledOnce();

    harness.observer.setConnectionVisibility("conn-1", true);
    for (let index = 0; index < 4; index += 1) {
      harness.observer.handleEvent(
        event({ stream: "tool", data: { phase: "start", name: "read", args: { index } } }),
      );
    }
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();

    expect(harness.completeModel).toHaveBeenCalledTimes(2);
    harness.observer.dispose();
  });

  it("suspends when the last visible connection is removed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    startAndAddToolNotes(harness.observer);

    harness.observer.removeConnection("conn-1");
    await vi.advanceTimersByTimeAsync(12_000);

    expect(harness.observer.getSnapshot("agent:main:session-1").notes).toEqual([]);
    expect(harness.completeModel).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it("does not observe when the agent has no utility model", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness({ utilityModelRef: null });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);

    expect(harness.prepareModel).not.toHaveBeenCalled();
    expect(harness.completeModel).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it("drops scheduled work when observation is disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const runtimeCfg = {
      gateway: { controlUi: { sessionObserver: true as boolean } },
      agents: { defaults: { utilityModel: "openai/gpt-test" } },
    } satisfies OpenClawConfig;
    const harness = createHarness({ config: runtimeCfg });
    startAndAddToolNotes(harness.observer);

    runtimeCfg.gateway.controlUi.sessionObserver = false;
    await vi.advanceTimersByTimeAsync(12_000);

    expect(harness.prepareModel).not.toHaveBeenCalled();
    expect(harness.completeModel).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it("drops scheduled work when the utility model is disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let utilityModelRef: string | undefined = "openai/gpt-test";
    const resolveUtilityModelRef = vi.fn(() => utilityModelRef);
    const harness = createHarness({ resolveUtilityModelRef });
    startAndAddToolNotes(harness.observer);
    utilityModelRef = undefined;
    await vi.advanceTimersByTimeAsync(12_000);

    expect(harness.prepareModel).not.toHaveBeenCalled();
    expect(harness.completeModel).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it("retries one unparseable model response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const completeModel = vi
      .fn()
      .mockResolvedValueOnce({ stopReason: "stop", content: [{ type: "text", text: "nope" }] })
      .mockResolvedValueOnce(
        modelMessage({ headline: "Continuing after a retry", health: "on-track" }),
      );
    const harness = createHarness({ completeModel });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();

    expect(completeModel).toHaveBeenCalledTimes(2);
    expect(harness.broadcastToConnIds).toHaveBeenCalledOnce();
    harness.observer.dispose();
  });

  it("demotes the least recently active model while retaining preamble state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    for (let index = 0; index < 7; index += 1) {
      const sessionKey = `agent:main:session-${index}`;
      harness.subscribers.subscribe(`conn-${index}`, sessionKey)?.commit();
      declareObserverVisibility(harness.observer, `conn-${index}`);
      vi.setSystemTime(index);
      startAndAddToolNotes(harness.observer, {
        runId: `run-${index}`,
        sessionKey,
      });
    }

    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    const sessions = harness.broadcastToConnIds.mock.calls.map(
      (call) => (call[1] as SessionObserverDigest).sessionKey,
    );
    expect(sessions).toHaveLength(6);
    expect(sessions).not.toContain("agent:main:session-0");

    const beforePreamble = harness.broadcastToConnIds.mock.calls.length;
    harness.observer.handleEvent(
      event({
        runId: "run-0",
        sessionKey: "agent:main:session-0",
        stream: "item",
        data: { kind: "preamble", phase: "update", progressText: "Checking files" },
      }),
    );
    await vi.advanceTimersByTimeAsync(100);
    harness.observer.handleEvent(
      event({
        runId: "run-0",
        sessionKey: "agent:main:session-0",
        stream: "item",
        data: { kind: "preamble", phase: "update", progressText: "Running tests" },
      }),
    );
    expect(harness.broadcastToConnIds).toHaveBeenCalledTimes(beforePreamble + 1);
    await vi.advanceTimersByTimeAsync(1_900);
    expect(harness.broadcastToConnIds).toHaveBeenCalledTimes(beforePreamble + 2);
    harness.observer.dispose();
  });

  it("preserves revision continuity when a run's model is demoted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    for (let index = 0; index < 4; index += 1) {
      harness.observer.handleEvent(
        event({ stream: "tool", data: { phase: "start", name: "read", args: { index } } }),
      );
    }
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();

    for (let index = 2; index <= 7; index += 1) {
      const sessionKey = `agent:main:session-${index}`;
      harness.subscribers.subscribe(`conn-${index}`, sessionKey)?.commit();
      declareObserverVisibility(harness.observer, `conn-${index}`);
      vi.setSystemTime(24_000 + index);
      harness.observer.handleEvent(
        event({
          runId: `run-${index}`,
          sessionKey,
          stream: "lifecycle",
          data: { phase: "start" },
        }),
      );
    }

    vi.setSystemTime(30_000);
    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 30_000 },
      }),
    );
    await flushObserver();

    const revisions = harness.broadcastToConnIds.mock.calls
      .map((call) => call[1] as SessionObserverDigest)
      .filter((digest) => digest.sessionKey === "agent:main:session-1")
      .map((digest) => digest.revision);
    expect(revisions).toEqual([1, 2, 3]);
    harness.observer.dispose();
  });

  it("preserves revision continuity across run rollover", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    for (let index = 0; index < 4; index += 1) {
      harness.observer.handleEvent(
        event({ stream: "tool", data: { phase: "start", name: "read", args: { index } } }),
      );
    }
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();

    harness.observer.handleEvent(
      event({ runId: "run-2", stream: "lifecycle", data: { phase: "start" } }),
    );
    for (let index = 0; index < 3; index += 1) {
      harness.observer.handleEvent(
        event({
          runId: "run-2",
          stream: "tool",
          data: { phase: "start", name: "read", args: { index } },
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();

    const revisions = harness.broadcastToConnIds.mock.calls.map(
      (call) => (call[1] as SessionObserverDigest).revision,
    );
    expect(revisions).toEqual([1, 2, 3]);
    harness.observer.dispose();
  });

  it("retains the revision floor when a new run starts without subscribers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    for (let index = 0; index < 4; index += 1) {
      harness.observer.handleEvent(
        event({ stream: "tool", data: { phase: "start", name: "read", args: { index } } }),
      );
    }
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();

    harness.subscribers.unsubscribe("conn-1", "agent:main:session-1");
    harness.observer.handleEvent(
      event({ runId: "run-2", stream: "lifecycle", data: { phase: "start" } }),
    );
    harness.subscribers.subscribe("conn-2", "agent:main:session-1")?.commit();
    declareObserverVisibility(harness.observer, "conn-2");
    for (let index = 0; index < 4; index += 1) {
      harness.observer.handleEvent(
        event({
          runId: "run-2",
          stream: "tool",
          data: { phase: "start", name: "read", args: { index } },
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();

    const revisions = harness.broadcastToConnIds.mock.calls.map(
      (call) => (call[1] as SessionObserverDigest).revision,
    );
    expect(revisions).toEqual([1, 2, 3]);
    harness.observer.dispose();
  });

  it("ignores late events from a superseded run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const storedDigest = persistedLiveDigest();
    const readSession = vi.fn(() => ({
      sessionId: "session-id",
      updatedAt: 1_000,
      observerDigest: storedDigest,
    }));
    const harness = createHarness({ readSession });
    harness.observer.handleEvent(event({ stream: "lifecycle", data: { phase: "start" } }));
    harness.observer.handleEvent(
      event({ runId: "run-2", stream: "lifecycle", data: { phase: "start" } }),
    );
    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 30_000 },
      }),
    );
    for (let index = 0; index < 3; index += 1) {
      harness.observer.handleEvent(
        event({
          runId: "run-2",
          stream: "tool",
          data: { phase: "start", name: "read", args: { index } },
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();

    expect(harness.broadcastToConnIds).toHaveBeenCalledOnce();
    const digest = harness.broadcastToConnIds.mock.calls[0]?.[1] as
      | SessionObserverDigest
      | undefined;
    expect(digest?.runId).toBe("run-2");
    expect(digest?.health).toBe("on-track");
    expect(digest?.revision).toBe(storedDigest.revision + 1);
    expect(harness.persistDigest).not.toHaveBeenCalled();
    harness.observer.dispose();
  });
});

describe("session observer schema", () => {
  it("validates protocol digests", () => {
    expect(
      Value.Check(SessionObserverDigestSchema, {
        sessionKey: "agent:main:session-1",
        runId: "run-1",
        revision: 1,
        updatedAt: 1,
        headline: "Checking the implementation",
        health: "on-track",
        planProgress: { completed: 2, total: 4 },
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionObserverDigestSchema, {
        sessionKey: "agent:main:session-1",
        revision: 1,
        updatedAt: 1,
        headline: "x".repeat(121),
        health: "on-track",
      }),
    ).toBe(false);
  });

  it("rejects loose JSON and truncates accepted strings to hard caps", () => {
    expect(normalizeSessionObserverModelOutput("```json\n{}\n```")).toBeNull();
    const normalized = normalizeSessionObserverModelOutput(
      JSON.stringify({
        headline: "h".repeat(140),
        assessment: "a".repeat(400),
        health: "grinding",
      }),
    );
    expect(normalized?.headline).toHaveLength(120);
    expect(normalized?.assessment).toHaveLength(320);
  });
});

describe("session observer run bookkeeping", () => {
  it("bounds dormant runs and preserves revision continuity for evicted entries", async () => {
    const { rememberSessionObserverDormantRun } = await import("./session-observer-model.js");
    const runs = new Map();
    const floors = new Map();
    for (let index = 0; index < 300; index += 1) {
      rememberSessionObserverDormantRun(runs, floors, {
        sessionKey: `agent:main:session-${index}`,
        sessionId: `session-${index}`,
        runId: `run-${index}`,
        agentId: "main",
        utilityModelRef: "openai/gpt-test",
        startedAt: index,
        lastPersistedAt: undefined,
        revision: index + 1,
        digestCount: 1,
        consecutiveFailures: 0,
        planProgress: undefined,
        previousDigest: undefined,
      });
    }
    expect(runs.size).toBe(256);
    expect(runs.has("run-0")).toBe(false);
    expect(runs.has("run-299")).toBe(true);
    expect(floors.get("agent:main:session-0")?.revision).toBe(1);
  });

  it("bounds disabled-run bookkeeping", async () => {
    const { rememberSessionObserverDisabledRun } = await import("./session-observer-model.js");
    const runs = new Set<string>();
    for (let index = 0; index < 600; index += 1) {
      rememberSessionObserverDisabledRun(runs, `run-${index}`);
    }
    expect(runs.size).toBe(512);
    expect(runs.has("run-0")).toBe(false);
    expect(runs.has("run-599")).toBe(true);
  });
});
