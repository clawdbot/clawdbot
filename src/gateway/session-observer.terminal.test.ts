import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createHarness,
  event,
  flushObserver,
  modelMessage,
  type PersistDigestParams,
  persistedLiveDigest,
  resetSessionObserverEventSequence,
  startAndAddToolNotes,
} from "./session-observer.test-utils.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSessionObserverEventSequence();
});

describe("session observer terminal, persistence, synthesis, and races", () => {
  it("persists and broadcasts terminal synthesis with no visible connections", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const storedDigest = persistedLiveDigest();
    const readSession = vi.fn(() => ({
      sessionId: "session-id",
      updatedAt: 1_000,
      observerDigest: storedDigest,
    }));
    const harness = createHarness({ visible: false, readSession });

    harness.observer.handleEvent(
      event({ stream: "lifecycle", data: { phase: "end", startedAt: 0, endedAt: 30_000 } }),
    );
    await flushObserver();

    expect(harness.completeModel).not.toHaveBeenCalled();
    expect(harness.persistDigest).toHaveBeenCalledOnce();
    expect(harness.broadcastToConnIds).toHaveBeenCalledWith(
      "session.observer",
      expect.objectContaining({ health: "done" }),
      harness.subscribers.get("agent:main:session-1"),
      { dropIfSlow: true },
    );
    harness.observer.dispose();
  });

  it.each([
    { phase: "end", expected: "done" },
    { phase: "error", expected: "failed" },
  ])(
    "synthesizes $expected from a persisted live digest without subscribers",
    async ({ phase, expected }) => {
      vi.useFakeTimers();
      vi.setSystemTime(30_000);
      const storedDigest = persistedLiveDigest();
      const readSession = vi.fn(() => ({
        sessionId: "session-id",
        updatedAt: 1_000,
        observerDigest: storedDigest,
      }));
      const harness = createHarness({ subscribe: false, readSession });

      harness.observer.handleEvent(
        event({
          stream: "lifecycle",
          data: { phase, startedAt: 0, endedAt: 30_000, error: "test failure" },
        }),
      );
      await flushObserver();

      expect(harness.completeModel).not.toHaveBeenCalled();
      expect(harness.persistDigest).toHaveBeenCalledOnce();
      const synthesized = harness.persistDigest.mock.calls[0]?.[0]?.digest as
        | SessionObserverDigest
        | undefined;
      expect(synthesized).toMatchObject({
        headline: storedDigest.headline,
        assessment: storedDigest.assessment,
        planProgress: storedDigest.planProgress,
        runId: "run-1",
        health: expected,
        revision: storedDigest.revision + 1,
        updatedAt: 30_000,
      });
      harness.observer.dispose();
    },
  );

  it("does not synthesize a terminal digest from another run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const readSession = vi.fn(() => ({
      sessionId: "session-id",
      updatedAt: 1_000,
      observerDigest: persistedLiveDigest({ runId: "another-run" }),
    }));
    const harness = createHarness({ subscribe: false, readSession });

    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 30_000 },
      }),
    );
    await flushObserver();

    expect(harness.persistDigest).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it("retries synthesized terminal persistence once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const storedDigest = persistedLiveDigest();
    const readSession = vi.fn(() => ({
      sessionId: "session-id",
      updatedAt: 1_000,
      observerDigest: storedDigest,
    }));
    const persistDigest = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary write failure"))
      .mockResolvedValueOnce(true);
    const harness = createHarness({ subscribe: false, persistDigest, readSession });

    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 30_000 },
      }),
    );
    await flushObserver();

    expect(persistDigest).toHaveBeenCalledTimes(2);
    const synthesized = persistDigest.mock.calls[1]?.[0]?.digest as
      | SessionObserverDigest
      | undefined;
    expect(synthesized?.health).toBe("done");
    harness.observer.dispose();
  });

  it("synthesizes terminal health for a disabled run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const storedDigest = persistedLiveDigest({ health: "waiting-on-user" });
    const readSession = vi.fn(() => ({
      sessionId: "session-id",
      updatedAt: 1_000,
      observerDigest: storedDigest,
    }));
    const completeModel = vi
      .fn()
      .mockResolvedValueOnce(modelMessage({ headline: "Latest live headline", health: "on-track" }))
      .mockRejectedValueOnce(new Error("first model failure"))
      .mockRejectedValueOnce(new Error("second model failure"));
    const harness = createHarness({ completeModel, readSession });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    for (let index = 0; index < 4; index += 1) {
      harness.observer.handleEvent(
        event({ stream: "tool", data: { phase: "start", name: "read", args: { index } } }),
      );
    }
    await vi.advanceTimersByTimeAsync(24_000);
    await flushObserver();

    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "error", startedAt: 0, endedAt: 36_000, error: "run failed" },
      }),
    );
    await flushObserver();

    expect(completeModel).toHaveBeenCalledTimes(3);
    const synthesized = harness.persistDigest.mock.calls[0]?.[0]?.digest as
      | SessionObserverDigest
      | undefined;
    expect(synthesized).toMatchObject({
      headline: "Latest live headline",
      health: "failed",
      revision: storedDigest.revision + 2,
    });
    harness.observer.dispose();
  });

  it("synthesizes terminal health when config disables terminal admission", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const runtimeCfg = {
      gateway: { controlUi: { sessionObserver: true as boolean } },
      agents: { defaults: { utilityModel: "openai/gpt-test" } },
    } satisfies OpenClawConfig;
    const storedDigest = persistedLiveDigest();
    const readSession = vi.fn(() => ({
      sessionId: "session-id",
      updatedAt: 1_000,
      observerDigest: storedDigest,
    }));
    const harness = createHarness({ config: runtimeCfg, readSession });
    harness.observer.handleEvent(event({ stream: "lifecycle", data: { phase: "start" } }));
    runtimeCfg.gateway.controlUi.sessionObserver = false;

    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 30_000 },
      }),
    );
    await flushObserver();

    expect(harness.completeModel).not.toHaveBeenCalled();
    const synthesized = harness.persistDigest.mock.calls[0]?.[0]?.digest as
      | SessionObserverDigest
      | undefined;
    expect(synthesized).toMatchObject({
      headline: storedDigest.headline,
      health: "done",
      revision: storedDigest.revision + 1,
    });
    harness.observer.dispose();
  });

  it("synthesizes before dropping an in-flight terminal state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const storedDigest = persistedLiveDigest();
    const readSession = vi.fn(() => ({
      sessionId: "session-id",
      updatedAt: 1_000,
      observerDigest: storedDigest,
    }));
    const completeModel = vi.fn(
      () =>
        new Promise<never>(() => {
          // Intentionally unresolved until the observer aborts this terminal call.
        }),
    );
    const harness = createHarness({ completeModel, readSession });
    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 30_000 },
      }),
    );
    await flushObserver();
    expect(completeModel).toHaveBeenCalledOnce();

    harness.subscribers.unsubscribe("conn-1", "agent:main:session-1");
    await flushObserver();

    const synthesized = harness.persistDigest.mock.calls[0]?.[0]?.digest as
      | SessionObserverDigest
      | undefined;
    expect(synthesized).toMatchObject({
      headline: storedDigest.headline,
      health: "done",
      revision: storedDigest.revision + 1,
    });
    harness.observer.dispose();
  });

  it("synthesizes terminal health after final model retries fail", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const storedDigest = persistedLiveDigest({ health: "failed" });
    const readSession = vi.fn(() => ({
      sessionId: "session-id",
      updatedAt: 1_000,
      observerDigest: storedDigest,
    }));
    const completeModel = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const harness = createHarness({ completeModel, readSession });

    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 30_000 },
      }),
    );
    await flushObserver();

    expect(completeModel).toHaveBeenCalledTimes(2);
    expect(harness.broadcastToConnIds).not.toHaveBeenCalled();
    const synthesized = harness.persistDigest.mock.calls[0]?.[0]?.digest as
      | SessionObserverDigest
      | undefined;
    expect(synthesized).toMatchObject({
      headline: storedDigest.headline,
      assessment: storedDigest.assessment,
      planProgress: storedDigest.planProgress,
      health: "done",
      revision: storedDigest.revision + 1,
      updatedAt: 30_000,
    });
    harness.observer.dispose();
  });

  it("synthesizes a queued terminal when a live call reaches the failure limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const storedDigest = persistedLiveDigest();
    const readSession = vi.fn(() => ({
      sessionId: "session-id",
      updatedAt: 1_000,
      observerDigest: storedDigest,
    }));
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
    const harness = createHarness({ completeModel, readSession });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(24_000);
    expect(completeModel).toHaveBeenCalledTimes(2);

    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 24_000 },
      }),
    );
    rejectSecond?.(new Error("second failure"));
    await flushObserver();

    const synthesized = harness.persistDigest.mock.calls[0]?.[0]?.digest as
      | SessionObserverDigest
      | undefined;
    expect(synthesized).toMatchObject({
      headline: storedDigest.headline,
      health: "done",
      revision: storedDigest.revision + 1,
    });
    harness.observer.dispose();
  });

  it("produces a terminal digest when subscribing late in a long run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const harness = createHarness();
    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 30_000 },
      }),
    );
    await flushObserver();

    const digest = harness.broadcastToConnIds.mock.calls[0]?.[1] as
      | SessionObserverDigest
      | undefined;
    expect(digest?.health).toBe("done");
    harness.observer.dispose();
  });

  it.each([
    { phase: "end", expected: "done" },
    { phase: "error", expected: "failed" },
  ])("forces $expected health on a terminal lifecycle digest", async ({ phase, expected }) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    harness.observer.handleEvent(event({ stream: "lifecycle", data: { phase: "start" } }));
    await vi.advanceTimersByTimeAsync(30_000);
    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase, startedAt: 0, endedAt: 30_000, error: "test failure" },
      }),
    );
    await flushObserver();

    expect(harness.broadcastToConnIds).toHaveBeenCalledOnce();
    const digest = harness.broadcastToConnIds.mock.calls[0]?.[1] as
      | SessionObserverDigest
      | undefined;
    expect(digest?.health).toBe(expected);
    expect(harness.persistDigest).toHaveBeenCalledOnce();
    harness.observer.dispose();
  });

  it("retries one transient terminal digest failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const completeModel = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(modelMessage({ headline: "Finished the work", health: "on-track" }));
    const harness = createHarness({ completeModel });
    harness.observer.handleEvent(event({ stream: "lifecycle", data: { phase: "start" } }));
    await vi.advanceTimersByTimeAsync(30_000);
    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 30_000 },
      }),
    );
    await flushObserver();

    expect(completeModel).toHaveBeenCalledTimes(2);
    const digest = harness.broadcastToConnIds.mock.calls[0]?.[1] as
      | SessionObserverDigest
      | undefined;
    expect(digest?.health).toBe("done");
    expect(harness.persistDigest).toHaveBeenCalledOnce();
    harness.observer.dispose();
  });

  it("retries failed terminal persistence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const persistDigest = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary write failure"))
      .mockResolvedValueOnce(true);
    const harness = createHarness({ persistDigest });
    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 30_000 },
      }),
    );
    await flushObserver();

    expect(persistDigest).toHaveBeenCalledTimes(2);
    harness.observer.dispose();
  });

  it("does not throttle persistence after a failed live write", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const persistDigest = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary write failure"))
      .mockResolvedValueOnce(true);
    const harness = createHarness({ persistDigest });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    for (let index = 0; index < 4; index += 1) {
      harness.observer.handleEvent(
        event({ stream: "tool", data: { phase: "start", name: "read", args: { index } } }),
      );
    }
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();

    expect(persistDigest).toHaveBeenCalledTimes(2);
    harness.observer.dispose();
  });

  it("redacts secrets split across assistant deltas in the assembled note", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    startAndAddToolNotes(harness.observer);
    harness.observer.handleEvent(
      event({ stream: "assistant", data: { delta: "Calling the API with api_k" } }),
    );
    harness.observer.handleEvent(
      event({ stream: "assistant", data: { delta: "ey=super-secret-value-0123456789 attached." } }),
    );
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledOnce();
    const prompt = JSON.stringify(
      harness.completeModel.mock.calls[0]?.[0]?.context?.messages ?? [],
    );
    expect(prompt).toContain("Assistant:");
    expect(prompt).not.toContain("super-secret-value-0123456789");
    harness.observer.dispose();
  });

  it("does not count assistant fragments toward the note threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    startAndAddToolNotes(harness.observer, { count: 2 });
    for (let index = 0; index < 6; index += 1) {
      harness.observer.handleEvent(
        event({ stream: "assistant", data: { delta: `progress fragment ${index} ` } }),
      );
    }
    await vi.advanceTimersByTimeAsync(20_000);
    await flushObserver();
    expect(harness.completeModel).not.toHaveBeenCalled();

    harness.observer.handleEvent(
      event({
        stream: "tool",
        data: { phase: "start", name: "read", args: { path: "src/final.ts" } },
      }),
    );
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledOnce();
    harness.observer.dispose();
  });

  it("prefers cumulative assistant text and emits a single assembled note", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    startAndAddToolNotes(harness.observer);
    harness.observer.handleEvent(
      event({ stream: "assistant", data: { delta: "Working on the f" } }),
    );
    harness.observer.handleEvent(event({ stream: "assistant", data: { delta: "ix" } }));
    harness.observer.handleEvent(
      event({ stream: "assistant", data: { text: "Working on the fix and verifying it." } }),
    );
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledOnce();
    const prompt = JSON.stringify(
      harness.completeModel.mock.calls[0]?.[0]?.context?.messages ?? [],
    );
    expect(prompt.match(/Assistant:/gu)).toHaveLength(1);
    expect(prompt).toContain("Working on the fix and verifying it.");
    harness.observer.dispose();
  });

  it("broadcasts a synthesized terminal digest when the final model call keeps failing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const completeModel = vi.fn(async () =>
      modelMessage({ headline: "Fixing tests", health: "grinding" }),
    );
    const harness = createHarness({ completeModel });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledOnce();

    completeModel.mockRejectedValue(new Error("model unavailable"));
    harness.observer.handleEvent(
      event({ stream: "lifecycle", data: { phase: "end", endedAt: 60_000 } }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await flushObserver();
    const observerCalls = harness.broadcastToConnIds.mock.calls.filter(
      (call) => call[0] === "session.observer",
    );
    expect(observerCalls).toHaveLength(2);
    const synthesized = observerCalls.at(-1)?.[1] as SessionObserverDigest;
    expect(synthesized.health).toBe("done");
    expect(synthesized.headline).toBe("Fixing tests");
    expect(synthesized.revision).toBe(2);
    expect(harness.persistDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        digest: expect.objectContaining({ health: "done", revision: 2 }),
      }),
    );
    harness.observer.dispose();
  });

  it("does not persist a synthesized terminal digest for a superseded run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const completeModel = vi.fn(async () =>
      modelMessage({ headline: "Fixing tests", health: "grinding" }),
    );
    const harness = createHarness({ completeModel });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledOnce();

    completeModel.mockImplementation(() => new Promise(() => {}));
    harness.observer.handleEvent(
      event({ stream: "lifecycle", data: { phase: "end", endedAt: 30_000 } }),
    );
    harness.observer.handleEvent(
      event({ runId: "run-2", stream: "lifecycle", data: { phase: "start" } }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await flushObserver();
    const persistedTerminal = harness.persistDigest.mock.calls.filter(
      (call) => call[0]?.digest?.runId === "run-1" && call[0]?.digest?.health !== "grinding",
    );
    expect(persistedTerminal).toHaveLength(0);
    const terminalBroadcasts = harness.broadcastToConnIds.mock.calls.filter(
      (call) =>
        call[0] === "session.observer" &&
        (call[1] as SessionObserverDigest | undefined)?.runId === "run-1" &&
        (call[1] as SessionObserverDigest | undefined)?.health === "done",
    );
    expect(terminalBroadcasts).toHaveLength(0);
    harness.observer.dispose();
  });

  it("invalidates the persist-time guard when a newer run replaces the digest's run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const persistDigest = vi.fn(async (_params: PersistDigestParams) => undefined);
    const harness = createHarness({ persistDigest });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(persistDigest).toHaveBeenCalledOnce();
    const guard = persistDigest.mock.calls[0]?.[0]?.stillCurrent as (() => boolean) | undefined;
    expect(guard?.()).toBe(true);

    harness.observer.handleEvent(
      event({ runId: "run-2", stream: "lifecycle", data: { phase: "start" } }),
    );
    expect(guard?.()).toBe(false);
    harness.observer.dispose();
  });

  it("drops a completed digest when the session was reset mid-flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const readSession = vi.fn(() => ({ sessionId: "session-id", updatedAt: 0 }));
    const harness = createHarness({ readSession });
    startAndAddToolNotes(harness.observer);
    readSession.mockReturnValue({ sessionId: "session-id-reset", updatedAt: 0 });
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledOnce();
    const observerBroadcasts = harness.broadcastToConnIds.mock.calls.filter(
      (call) => call[0] === "session.observer",
    );
    expect(observerBroadcasts).toHaveLength(0);
    expect(harness.persistDigest).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it("catches up durable persistence when the live digest already carried terminal health", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const completeModel = vi.fn(async () =>
      modelMessage({ headline: "Finished the fix", health: "done" }),
    );
    const harness = createHarness({ completeModel });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledOnce();
    const liveBroadcasts = harness.broadcastToConnIds.mock.calls.filter(
      (call) => call[0] === "session.observer",
    );
    expect(liveBroadcasts).toHaveLength(1);

    completeModel.mockRejectedValue(new Error("model unavailable"));
    harness.observer.handleEvent(
      event({ stream: "lifecycle", data: { phase: "end", endedAt: 30_000 } }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await flushObserver();
    const persisted = harness.persistDigest.mock.calls.at(-1)?.[0]?.digest as
      | SessionObserverDigest
      | undefined;
    expect(persisted?.health).toBe("done");
    expect(persisted?.revision).toBe(1);
    const observerBroadcasts = harness.broadcastToConnIds.mock.calls.filter(
      (call) => call[0] === "session.observer",
    );
    expect(observerBroadcasts).toHaveLength(1);
    harness.observer.dispose();
  });

  it("does not broadcast a synthesized terminal digest the store rejected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const completeModel = vi.fn(async () =>
      modelMessage({ headline: "Fixing tests", health: "grinding" }),
    );
    const persistDigest = vi.fn(async () => false);
    const harness = createHarness({ completeModel, persistDigest });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledOnce();

    completeModel.mockRejectedValue(new Error("model unavailable"));
    harness.observer.handleEvent(
      event({ stream: "lifecycle", data: { phase: "end", endedAt: 30_000 } }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await flushObserver();
    const terminalBroadcasts = harness.broadcastToConnIds.mock.calls.filter(
      (call) =>
        call[0] === "session.observer" &&
        (call[1] as SessionObserverDigest | undefined)?.health === "done",
    );
    expect(terminalBroadcasts).toHaveLength(0);
    harness.observer.dispose();
  });

  it("suppresses assistant notes while a runtime-context block is still streaming", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    startAndAddToolNotes(harness.observer);
    harness.observer.handleEvent(
      event({
        stream: "assistant",
        data: { delta: "prose before\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n" },
      }),
    );
    harness.observer.handleEvent(
      event({ stream: "assistant", data: { delta: "private-context-body-must-not-leave" } }),
    );
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledOnce();
    const openPrompt = String(
      harness.completeModel.mock.calls[0]?.[0]?.context?.messages?.[0]?.content,
    );
    expect(openPrompt).not.toContain("private-context-body-must-not-leave");
    expect(openPrompt).not.toContain("Assistant:");

    harness.observer.handleEvent(
      event({
        stream: "assistant",
        data: { delta: "\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\nvisible prose after" },
      }),
    );
    startAndAddToolNotes(harness.observer, { count: 4 });
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledTimes(2);
    const closedPrompt = String(
      harness.completeModel.mock.calls[1]?.[0]?.context?.messages?.[0]?.content,
    );
    expect(closedPrompt).not.toContain("private-context-body-must-not-leave");
    expect(closedPrompt).toContain("visible prose after");
    harness.observer.dispose();
  });

  it("invalidates the persist-time guard after disposal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const persistDigest = vi.fn(async (_params: PersistDigestParams) => true);
    const harness = createHarness({ persistDigest });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    const guard = persistDigest.mock.calls[0]?.[0]?.stillCurrent as (() => boolean) | undefined;
    expect(guard?.()).toBe(true);
    harness.observer.dispose();
    expect(guard?.()).toBe(false);
  });

  it("does not throttle the next digest after a rejected persist", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const persistDigest = vi.fn(async () => false);
    const harness = createHarness({ persistDigest });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(persistDigest).toHaveBeenCalledOnce();

    persistDigest.mockResolvedValue(true);
    startAndAddToolNotes(harness.observer, { count: 4 });
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(persistDigest).toHaveBeenCalledTimes(2);
    harness.observer.dispose();
  });
});
