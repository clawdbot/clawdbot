import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createHarness as createBaseHarness,
  event,
  flushObserver,
  modelMessage,
  type PersistDigestParams,
  persistedLiveDigest,
  resetSessionObserverEventSequence,
  startAndAddToolNotes,
} from "./session-observer.test-utils.js";

afterEach(() => {
  for (const harness of activeHarnesses) {
    harness.observer.dispose();
  }
  activeHarnesses.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSessionObserverEventSequence();
});

type Harness = ReturnType<typeof createBaseHarness>;
type HarnessOptions = NonNullable<Parameters<typeof createBaseHarness>[0]>;
type EventRoute = { runId?: string; sessionKey?: string; agentId?: string };

const activeHarnesses = new Set<Harness>();

function createHarness(options?: HarnessOptions): Harness {
  const harness = createBaseHarness(options);
  activeHarnesses.add(harness);
  return harness;
}

function useFakeTime(now = 0): void {
  vi.useFakeTimers();
  vi.setSystemTime(now);
}

function createPersistedHarness(
  options: HarnessOptions = {},
  digestOverrides: Partial<SessionObserverDigest> = {},
) {
  const storedDigest = persistedLiveDigest(digestOverrides);
  const readSession = vi.fn(() => ({
    sessionId: "session-id",
    updatedAt: 1_000,
    observerDigest: storedDigest,
  }));
  return { storedDigest, harness: createHarness({ ...options, readSession }) };
}

function lifecycleEvent(data: Record<string, unknown>, route: EventRoute = {}) {
  return event({ ...route, stream: "lifecycle", data });
}

function emitEvent(
  harness: Harness,
  stream: string,
  data: Record<string, unknown>,
  route: EventRoute = {},
): void {
  harness.observer.handleEvent(event({ ...route, stream, data }));
}

async function advanceAndFlush(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flushObserver();
}

async function handleLifecycle(
  harness: Harness,
  data: Record<string, unknown>,
  route: EventRoute = {},
): Promise<void> {
  harness.observer.handleEvent(lifecycleEvent(data, route));
  await flushObserver();
}

function persistedDigest(harness: Harness, index = 0): SessionObserverDigest | undefined {
  return harness.persistDigest.mock.calls.at(index)?.[0]?.digest as
    | SessionObserverDigest
    | undefined;
}

function broadcastDigest(harness: Harness, index = 0): SessionObserverDigest | undefined {
  return harness.broadcastToConnIds.mock.calls.at(index)?.[1] as SessionObserverDigest | undefined;
}

function observerBroadcasts(harness: Harness) {
  return harness.broadcastToConnIds.mock.calls.filter((call) => call[0] === "session.observer");
}

function persistGuard(harness: Harness): (() => boolean) | undefined {
  return harness.persistDigest.mock.calls[0]?.[0]?.stillCurrent as (() => boolean) | undefined;
}

function completionMessages(harness: Harness, index = 0) {
  return harness.completeModel.mock.calls[index]?.[0]?.context?.messages ?? [];
}

describe("session observer terminal, persistence, synthesis, and races", () => {
  it("persists and broadcasts terminal synthesis with no visible connections", async () => {
    useFakeTime(30_000);
    const { harness } = createPersistedHarness({ visible: false });

    await handleLifecycle(harness, { phase: "end", startedAt: 0, endedAt: 30_000 });

    expect(harness.completeModel).not.toHaveBeenCalled();
    expect(harness.persistDigest).toHaveBeenCalledOnce();
    expect(harness.broadcastToConnIds).toHaveBeenCalledWith(
      "session.observer",
      expect.objectContaining({ health: "done" }),
      harness.subscribers.get("agent:main:session-1"),
      expect.objectContaining({
        agentId: "main",
        dropIfSlow: true,
        sessionKeys: ["agent:main:session-1"],
        sessionSubscriptionVerified: true,
      }),
    );
  });

  it("accepts a routed terminal event after a contextless duplicate", async () => {
    useFakeTime(30_000);
    const { harness } = createPersistedHarness({ subscribe: false });
    const contextlessTerminal = lifecycleEvent({
      phase: "end",
      startedAt: 0,
      endedAt: 30_000,
    });
    delete contextlessTerminal.sessionKey;
    delete contextlessTerminal.agentId;

    harness.observer.handleEvent(contextlessTerminal);
    harness.observer.handleEvent(lifecycleEvent({ phase: "end", startedAt: 0, endedAt: 30_000 }));
    await flushObserver();

    expect(harness.persistDigest).toHaveBeenCalledOnce();
    expect(harness.persistDigest.mock.calls[0]?.[0]?.digest).toMatchObject({ health: "done" });
  });

  it("finalizes an active run from a contextless terminal", async () => {
    useFakeTime();
    const harness = createHarness();
    harness.observer.handleEvent(lifecycleEvent({ phase: "start" }));
    vi.setSystemTime(30_000);
    const contextlessTerminal = lifecycleEvent({ phase: "end", startedAt: 0, endedAt: 30_000 });
    delete contextlessTerminal.sessionKey;
    delete contextlessTerminal.agentId;

    harness.observer.handleEvent(contextlessTerminal);
    await flushObserver();

    const digest = broadcastDigest(harness, -1);
    expect(digest?.health).toBe("done");
    expect(harness.persistDigest).toHaveBeenCalledOnce();
  });

  it("finalizes an active run when the terminal omits only its agent owner", async () => {
    useFakeTime();
    const harness = createHarness();
    harness.observer.handleEvent(lifecycleEvent({ phase: "start" }));
    vi.setSystemTime(30_000);
    const terminal = lifecycleEvent({ phase: "end", startedAt: 0, endedAt: 30_000 });
    delete terminal.agentId;

    harness.observer.handleEvent(terminal);
    await flushObserver();

    const digest = broadcastDigest(harness, -1);
    expect(digest).toMatchObject({ agentId: "main", health: "done" });
    expect(harness.persistDigest).toHaveBeenCalledOnce();
  });

  it("finalizes a dormant run from a contextless terminal", async () => {
    useFakeTime();
    const { harness } = createPersistedHarness();
    harness.observer.handleEvent(lifecycleEvent({ phase: "start" }));
    harness.observer.removeConnection("conn-1");
    vi.setSystemTime(30_000);
    const contextlessTerminal = lifecycleEvent({ phase: "end", startedAt: 0, endedAt: 30_000 });
    delete contextlessTerminal.sessionKey;
    delete contextlessTerminal.agentId;

    harness.observer.handleEvent(contextlessTerminal);
    await flushObserver();

    expect(harness.persistDigest).toHaveBeenCalledOnce();
    expect(harness.persistDigest.mock.calls[0]?.[0]?.digest).toMatchObject({
      runId: "run-1",
      health: "done",
    });
  });

  it("suppresses live events after a contextless terminal", () => {
    const harness = createHarness();
    const contextlessTerminal = lifecycleEvent({ phase: "end" });
    delete contextlessTerminal.sessionKey;

    harness.observer.handleEvent(contextlessTerminal);
    emitEvent(harness, "item", {
      kind: "preamble",
      phase: "update",
      progressText: "Late progress",
    });

    expect(harness.broadcastToConnIds).not.toHaveBeenCalled();
    expect(harness.persistDigest).not.toHaveBeenCalled();
  });

  it.each([
    { phase: "end", expected: "done" },
    { phase: "error", expected: "failed" },
  ])(
    "synthesizes $expected from a persisted live digest without subscribers",
    async ({ phase, expected }) => {
      useFakeTime(30_000);
      const { storedDigest, harness } = createPersistedHarness({ subscribe: false });

      await handleLifecycle(harness, {
        phase,
        startedAt: 0,
        endedAt: 30_000,
        error: "test failure",
        ...(phase === "error" ? { fallbackExhaustedFailure: true } : {}),
      });

      expect(harness.completeModel).not.toHaveBeenCalled();
      expect(harness.persistDigest).toHaveBeenCalledOnce();
      const synthesized = persistedDigest(harness);
      expect(synthesized).toMatchObject({
        headline: storedDigest.headline,
        assessment: storedDigest.assessment,
        planProgress: storedDigest.planProgress,
        runId: "run-1",
        health: expected,
        revision: storedDigest.revision + 1,
        updatedAt: 30_000,
      });
    },
  );

  it("does not synthesize a terminal digest from another run", async () => {
    useFakeTime(30_000);
    const { harness } = createPersistedHarness({ subscribe: false }, { runId: "another-run" });

    await handleLifecycle(harness, { phase: "end", startedAt: 0, endedAt: 30_000 });

    expect(harness.persistDigest).not.toHaveBeenCalled();
  });

  it("retries synthesized terminal persistence once", async () => {
    useFakeTime(30_000);
    const persistDigest = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary write failure"))
      .mockResolvedValueOnce(true);
    const { harness } = createPersistedHarness({ subscribe: false, persistDigest });

    await handleLifecycle(harness, { phase: "end", startedAt: 0, endedAt: 30_000 });

    expect(persistDigest).toHaveBeenCalledTimes(2);
    const synthesized = persistedDigest(harness, 1);
    expect(synthesized?.health).toBe("done");
  });

  it("synthesizes terminal health for a disabled run", async () => {
    useFakeTime();
    const completeModel = vi
      .fn()
      .mockResolvedValueOnce(modelMessage({ headline: "Latest live headline", health: "on-track" }))
      .mockRejectedValueOnce(new Error("first model failure"))
      .mockRejectedValueOnce(new Error("second model failure"));
    const { storedDigest, harness } = createPersistedHarness(
      { completeModel },
      { health: "waiting-on-user" },
    );
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    for (let index = 0; index < 4; index += 1) {
      emitEvent(harness, "tool", { phase: "start", name: "read", args: { index } });
    }
    await advanceAndFlush(24_000);

    await handleLifecycle(harness, {
      phase: "error",
      startedAt: 0,
      endedAt: 36_000,
      error: "run failed",
      fallbackExhaustedFailure: true,
    });

    expect(completeModel).toHaveBeenCalledTimes(3);
    const synthesized = persistedDigest(harness);
    expect(synthesized).toMatchObject({
      headline: "Latest live headline",
      health: "failed",
      revision: storedDigest.revision + 2,
    });
  });

  it("synthesizes terminal health when config disables terminal admission", async () => {
    useFakeTime();
    const runtimeCfg = {
      gateway: { controlUi: { sessionObserver: true as boolean } },
      agents: { defaults: { utilityModel: "openai/gpt-test" } },
    } satisfies OpenClawConfig;
    const { storedDigest, harness } = createPersistedHarness({ config: runtimeCfg });
    harness.observer.handleEvent(lifecycleEvent({ phase: "start" }));
    runtimeCfg.gateway.controlUi.sessionObserver = false;

    await handleLifecycle(harness, { phase: "end", startedAt: 0, endedAt: 30_000 });

    expect(harness.completeModel).not.toHaveBeenCalled();
    const synthesized = persistedDigest(harness);
    expect(synthesized).toMatchObject({
      headline: storedDigest.headline,
      health: "done",
      revision: storedDigest.revision + 1,
    });
  });

  it("synthesizes before dropping an in-flight terminal state", async () => {
    useFakeTime(30_000);
    const completeModel = vi.fn(
      () =>
        new Promise<never>(() => {
          // Intentionally unresolved until the observer aborts this terminal call.
        }),
    );
    const { storedDigest, harness } = createPersistedHarness({ completeModel });
    await handleLifecycle(harness, { phase: "end", startedAt: 0, endedAt: 30_000 });
    expect(completeModel).toHaveBeenCalledOnce();

    harness.subscribers.unsubscribe("conn-1", "agent:main:session-1");
    await flushObserver();

    const synthesized = persistedDigest(harness);
    expect(synthesized).toMatchObject({
      headline: storedDigest.headline,
      health: "done",
      revision: storedDigest.revision + 1,
    });
  });

  it("synthesizes terminal health after final model retries fail", async () => {
    useFakeTime(30_000);
    const completeModel = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const { storedDigest, harness } = createPersistedHarness(
      { completeModel },
      { health: "failed" },
    );

    await handleLifecycle(harness, { phase: "end", startedAt: 0, endedAt: 30_000 });

    expect(completeModel).toHaveBeenCalledTimes(2);
    expect(harness.broadcastToConnIds).not.toHaveBeenCalled();
    const synthesized = persistedDigest(harness);
    expect(synthesized).toMatchObject({
      headline: storedDigest.headline,
      assessment: storedDigest.assessment,
      planProgress: storedDigest.planProgress,
      health: "done",
      revision: storedDigest.revision + 1,
      updatedAt: 30_000,
    });
  });

  it("synthesizes a queued terminal when a live call reaches the failure limit", async () => {
    useFakeTime();
    let rejectSecond: ((error: Error) => void) | undefined;
    const completeModel = vi
      .fn()
      .mockRejectedValueOnce(new Error("first failure"))
      .mockImplementationOnce(
        () =>
          new Promise<never>((_resolve, reject) => {
            rejectSecond = reject;
          }),
      );
    const { storedDigest, harness } = createPersistedHarness({ completeModel });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(24_000);
    expect(completeModel).toHaveBeenCalledTimes(2);

    harness.observer.handleEvent(lifecycleEvent({ phase: "end", startedAt: 0, endedAt: 24_000 }));
    rejectSecond?.(new Error("second failure"));
    await flushObserver();

    const synthesized = persistedDigest(harness);
    expect(synthesized).toMatchObject({
      headline: storedDigest.headline,
      health: "done",
      revision: storedDigest.revision + 1,
    });
  });

  it("produces a terminal digest when subscribing late in a long run", async () => {
    useFakeTime(30_000);
    const harness = createHarness();
    await handleLifecycle(harness, { phase: "end", startedAt: 0, endedAt: 30_000 });

    const digest = broadcastDigest(harness);
    expect(digest?.health).toBe("done");
  });

  it.each([
    { phase: "end", expected: "done" },
    { phase: "error", expected: "failed" },
  ])("forces $expected health on a terminal lifecycle digest", async ({ phase, expected }) => {
    useFakeTime();
    const harness = createHarness();
    harness.observer.handleEvent(lifecycleEvent({ phase: "start" }));
    await vi.advanceTimersByTimeAsync(30_000);
    await handleLifecycle(harness, {
      phase,
      startedAt: 0,
      endedAt: 30_000,
      error: "test failure",
      ...(phase === "error" ? { fallbackExhaustedFailure: true } : {}),
    });

    expect(harness.broadcastToConnIds).toHaveBeenCalledOnce();
    const digest = broadcastDigest(harness);
    expect(digest?.health).toBe(expected);
    expect(harness.persistDigest).toHaveBeenCalledOnce();
  });

  it("does not finalize a retryable attempt error before same-run fallback succeeds", async () => {
    useFakeTime();
    const harness = createHarness();
    harness.observer.handleEvent(lifecycleEvent({ phase: "start", startedAt: 0 }));
    await vi.advanceTimersByTimeAsync(30_000);

    harness.observer.handleEvent(
      lifecycleEvent({ phase: "error", endedAt: 30_000, error: "retryable provider failure" }),
    );
    await flushObserver();
    expect(vi.getTimerCount()).toBe(1);
    harness.observer.handleEvent(lifecycleEvent({ phase: "start", startedAt: 30_000 }));
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(60_000);
    await handleLifecycle(harness, { phase: "end", endedAt: 60_000 });

    expect(observerBroadcasts(harness).map((call) => call[1])).toEqual([
      expect.objectContaining({ health: "done" }),
    ]);
    expect(harness.persistDigest).toHaveBeenCalledOnce();
  });

  it("finalizes an unrecovered attempt error after the retry grace", async () => {
    useFakeTime();
    const harness = createHarness();
    harness.observer.handleEvent(lifecycleEvent({ phase: "start", startedAt: 0 }));
    await vi.advanceTimersByTimeAsync(30_000);

    harness.observer.handleEvent(
      lifecycleEvent({ phase: "error", endedAt: 30_000, error: "provider failed" }),
    );
    await flushObserver();
    expect(observerBroadcasts(harness)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);

    await advanceAndFlush(15_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(broadcastDigest(harness)).toMatchObject({ health: "failed" });
    expect(harness.persistDigest).toHaveBeenCalledOnce();
  });

  it("retries one transient terminal digest failure", async () => {
    useFakeTime();
    const completeModel = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(modelMessage({ headline: "Finished the work", health: "on-track" }));
    const harness = createHarness({ completeModel });
    harness.observer.handleEvent(lifecycleEvent({ phase: "start" }));
    await vi.advanceTimersByTimeAsync(30_000);
    await handleLifecycle(harness, { phase: "end", startedAt: 0, endedAt: 30_000 });

    expect(completeModel).toHaveBeenCalledTimes(2);
    const digest = broadcastDigest(harness);
    expect(digest?.health).toBe("done");
    expect(harness.persistDigest).toHaveBeenCalledOnce();
  });

  it("retries failed terminal persistence", async () => {
    useFakeTime(30_000);
    const persistDigest = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary write failure"))
      .mockResolvedValueOnce(true);
    const harness = createHarness({ persistDigest });
    await handleLifecycle(harness, { phase: "end", startedAt: 0, endedAt: 30_000 });

    expect(persistDigest).toHaveBeenCalledTimes(2);
  });

  it("does not throttle persistence after a failed live write", async () => {
    useFakeTime();
    const persistDigest = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary write failure"))
      .mockResolvedValueOnce(true);
    const harness = createHarness({ persistDigest });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    for (let index = 0; index < 4; index += 1) {
      emitEvent(harness, "tool", { phase: "start", name: "read", args: { index } });
    }
    await advanceAndFlush(12_000);

    expect(persistDigest).toHaveBeenCalledTimes(2);
  });

  it("redacts secrets split across assistant deltas in the assembled note", async () => {
    useFakeTime();
    const harness = createHarness();
    startAndAddToolNotes(harness.observer);
    emitEvent(harness, "assistant", { delta: "Calling the API with api_k" });
    emitEvent(harness, "assistant", { delta: "ey=super-secret-value-0123456789 attached." });
    await advanceAndFlush(12_000);
    expect(harness.completeModel).toHaveBeenCalledOnce();
    const prompt = JSON.stringify(completionMessages(harness));
    expect(prompt).toContain("Assistant:");
    expect(prompt).not.toContain("super-secret-value-0123456789");
  });

  it("does not count assistant fragments toward the note threshold", async () => {
    useFakeTime();
    const harness = createHarness();
    startAndAddToolNotes(harness.observer, { count: 2 });
    for (let index = 0; index < 6; index += 1) {
      emitEvent(harness, "assistant", { delta: `progress fragment ${index} ` });
    }
    await advanceAndFlush(20_000);
    expect(harness.completeModel).not.toHaveBeenCalled();

    emitEvent(harness, "tool", {
      phase: "start",
      name: "read",
      args: { path: "src/final.ts" },
    });
    await advanceAndFlush(12_000);
    expect(harness.completeModel).toHaveBeenCalledOnce();
  });

  it("prefers cumulative assistant text and emits a single assembled note", async () => {
    useFakeTime();
    const harness = createHarness();
    startAndAddToolNotes(harness.observer);
    emitEvent(harness, "assistant", { delta: "Working on the f" });
    emitEvent(harness, "assistant", { delta: "ix" });
    emitEvent(harness, "assistant", { text: "Working on the fix and verifying it." });
    await advanceAndFlush(12_000);
    expect(harness.completeModel).toHaveBeenCalledOnce();
    const prompt = JSON.stringify(completionMessages(harness));
    expect(prompt.match(/Assistant:/gu)).toHaveLength(1);
    expect(prompt).toContain("Working on the fix and verifying it.");
  });

  it("broadcasts a synthesized terminal digest when the final model call keeps failing", async () => {
    useFakeTime();
    const completeModel = vi.fn(async () =>
      modelMessage({ headline: "Fixing tests", health: "grinding" }),
    );
    const harness = createHarness({ completeModel });
    startAndAddToolNotes(harness.observer);
    await advanceAndFlush(12_000);
    expect(harness.completeModel).toHaveBeenCalledOnce();

    completeModel.mockRejectedValue(new Error("model unavailable"));
    harness.observer.handleEvent(
      lifecycleEvent({
        phase: "end",
        endedAt: 60_000,
        terminalReply: { disposition: "visible", text: "The repaired tests now pass." },
      }),
    );
    await advanceAndFlush(0);
    const observerCalls = observerBroadcasts(harness);
    expect(observerCalls).toHaveLength(2);
    const synthesized = observerCalls.at(-1)?.[1] as SessionObserverDigest;
    expect(synthesized.health).toBe("done");
    expect(synthesized.headline).toBe("The repaired tests now pass.");
    expect(synthesized.revision).toBe(2);
    expect(harness.persistDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        digest: expect.objectContaining({ health: "done", revision: 2 }),
      }),
    );
  });

  it.each(["silent", "empty"] as const)(
    "does not invent a terminal headline for a %s reply",
    async (disposition) => {
      useFakeTime();
      const completeModel = vi.fn(async () =>
        modelMessage({ headline: "Fixing tests", health: "grinding" }),
      );
      const harness = createHarness({ completeModel });
      startAndAddToolNotes(harness.observer);
      await advanceAndFlush(12_000);

      completeModel.mockRejectedValue(new Error("model unavailable"));
      harness.observer.handleEvent(
        lifecycleEvent({ phase: "end", endedAt: 60_000, terminalReply: { disposition } }),
      );
      await advanceAndFlush(0);

      const synthesized = observerBroadcasts(harness).at(-1)?.[1] as SessionObserverDigest;
      expect(synthesized.headline).toBe("Fixing tests");
    },
  );

  it("does not persist a synthesized terminal digest for a superseded run", async () => {
    useFakeTime();
    const completeModel = vi.fn(async () =>
      modelMessage({ headline: "Fixing tests", health: "grinding" }),
    );
    const harness = createHarness({ completeModel });
    startAndAddToolNotes(harness.observer);
    await advanceAndFlush(12_000);
    expect(harness.completeModel).toHaveBeenCalledOnce();

    completeModel.mockImplementation(() => new Promise(() => {}));
    harness.observer.handleEvent(lifecycleEvent({ phase: "end", endedAt: 30_000 }));
    harness.observer.handleEvent(lifecycleEvent({ phase: "start" }, { runId: "run-2" }));
    await advanceAndFlush(0);
    const persistedTerminal = harness.persistDigest.mock.calls.filter(
      (call) => call[0]?.digest?.runId === "run-1" && call[0]?.digest?.health !== "grinding",
    );
    expect(persistedTerminal).toHaveLength(0);
    const terminalBroadcasts = observerBroadcasts(harness).filter(
      (call) =>
        (call[1] as SessionObserverDigest | undefined)?.runId === "run-1" &&
        (call[1] as SessionObserverDigest | undefined)?.health === "done",
    );
    expect(terminalBroadcasts).toHaveLength(0);
  });

  it("invalidates the persist-time guard when a newer run replaces a dormant run", async () => {
    useFakeTime();
    const persistDigest = vi.fn(async (_params: PersistDigestParams) => undefined);
    const harness = createHarness({ persistDigest });
    startAndAddToolNotes(harness.observer);
    await advanceAndFlush(12_000);
    expect(persistDigest).toHaveBeenCalledOnce();
    const guard = persistGuard(harness);
    expect(guard?.()).toBe(true);
    harness.observer.setConnectionVisibility("conn-1", false);

    harness.observer.handleEvent(
      lifecycleEvent({ phase: "error", error: "retryable provider failure" }),
    );
    expect(vi.getTimerCount()).toBe(1);
    harness.observer.handleEvent(lifecycleEvent({ phase: "start" }, { runId: "run-2" }));
    expect(vi.getTimerCount()).toBe(0);
    expect(guard?.()).toBe(false);
  });

  it("drops a completed digest when the session was reset mid-flight", async () => {
    useFakeTime();
    const readSession = vi.fn(() => ({ sessionId: "session-id", updatedAt: 0 }));
    const harness = createHarness({ readSession });
    startAndAddToolNotes(harness.observer);
    readSession.mockReturnValue({ sessionId: "session-id-reset", updatedAt: 0 });
    await advanceAndFlush(12_000);
    expect(harness.completeModel).toHaveBeenCalledOnce();
    const broadcasts = observerBroadcasts(harness);
    expect(broadcasts).toHaveLength(0);
    expect(harness.persistDigest).not.toHaveBeenCalled();
  });

  it("catches up durable persistence when the live digest already carried terminal health", async () => {
    useFakeTime();
    const completeModel = vi.fn(async () =>
      modelMessage({ headline: "Finished the fix", health: "done" }),
    );
    const harness = createHarness({ completeModel });
    startAndAddToolNotes(harness.observer);
    await advanceAndFlush(12_000);
    expect(harness.completeModel).toHaveBeenCalledOnce();
    const liveBroadcasts = observerBroadcasts(harness);
    expect(liveBroadcasts).toHaveLength(1);

    completeModel.mockRejectedValue(new Error("model unavailable"));
    harness.observer.handleEvent(lifecycleEvent({ phase: "end", endedAt: 30_000 }));
    await advanceAndFlush(0);
    const persisted = persistedDigest(harness, -1);
    expect(persisted?.health).toBe("done");
    expect(persisted?.revision).toBe(1);
    const broadcasts = observerBroadcasts(harness);
    expect(broadcasts).toHaveLength(1);
  });

  it("does not broadcast a synthesized terminal digest the store rejected", async () => {
    useFakeTime();
    const completeModel = vi.fn(async () =>
      modelMessage({ headline: "Fixing tests", health: "grinding" }),
    );
    const persistDigest = vi.fn(async () => false);
    const harness = createHarness({ completeModel, persistDigest });
    startAndAddToolNotes(harness.observer);
    await advanceAndFlush(12_000);
    expect(harness.completeModel).toHaveBeenCalledOnce();

    completeModel.mockRejectedValue(new Error("model unavailable"));
    harness.observer.handleEvent(lifecycleEvent({ phase: "end", endedAt: 30_000 }));
    await advanceAndFlush(0);
    const terminalBroadcasts = observerBroadcasts(harness).filter(
      (call) => (call[1] as SessionObserverDigest | undefined)?.health === "done",
    );
    expect(terminalBroadcasts).toHaveLength(0);
  });

  it("suppresses assistant notes while a runtime-context block is still streaming", async () => {
    useFakeTime();
    const harness = createHarness();
    startAndAddToolNotes(harness.observer);
    emitEvent(harness, "assistant", {
      delta: "prose before\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n",
    });
    emitEvent(harness, "assistant", { delta: "private-context-body-must-not-leave" });
    await advanceAndFlush(12_000);
    expect(harness.completeModel).toHaveBeenCalledOnce();
    const openPrompt = String(completionMessages(harness)[0]?.content);
    expect(openPrompt).not.toContain("private-context-body-must-not-leave");
    expect(openPrompt).not.toContain("Assistant:");

    emitEvent(harness, "assistant", {
      delta: "\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\nvisible prose after",
    });
    startAndAddToolNotes(harness.observer, { count: 4 });
    await advanceAndFlush(12_000);
    expect(harness.completeModel).toHaveBeenCalledTimes(2);
    const closedPrompt = String(completionMessages(harness, 1)[0]?.content);
    expect(closedPrompt).not.toContain("private-context-body-must-not-leave");
    expect(closedPrompt).toContain("visible prose after");
  });

  it("invalidates the persist-time guard after disposal", async () => {
    useFakeTime();
    const persistDigest = vi.fn(async (_params: PersistDigestParams) => true);
    const harness = createHarness({ persistDigest });
    startAndAddToolNotes(harness.observer);
    await advanceAndFlush(12_000);
    const guard = persistGuard(harness);
    expect(guard?.()).toBe(true);
    harness.observer.handleEvent(
      lifecycleEvent({ phase: "error", error: "retryable provider failure" }),
    );
    expect(vi.getTimerCount()).toBe(1);
    harness.observer.dispose();
    activeHarnesses.delete(harness);
    expect(vi.getTimerCount()).toBe(0);
    expect(guard?.()).toBe(false);
  });

  it("does not throttle the next digest after a rejected persist", async () => {
    useFakeTime();
    const persistDigest = vi.fn(async () => false);
    const harness = createHarness({ persistDigest });
    startAndAddToolNotes(harness.observer);
    await advanceAndFlush(12_000);
    expect(persistDigest).toHaveBeenCalledOnce();

    persistDigest.mockResolvedValue(true);
    startAndAddToolNotes(harness.observer, { count: 4 });
    await advanceAndFlush(12_000);
    expect(persistDigest).toHaveBeenCalledTimes(2);
  });
});
