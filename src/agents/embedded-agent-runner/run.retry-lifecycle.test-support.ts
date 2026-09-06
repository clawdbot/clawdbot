import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedClassifyAssistantFailoverReason,
  mockedClassifyFailoverReason,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import {
  createSharedRunIntegrationSession,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";

describe("direct embedded retry lifecycle", () => {
  let run: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;
  let session: Awaited<ReturnType<typeof createSharedRunIntegrationSession>>;
  beforeAll(async () => {
    run = await loadSharedRunIntegrationHarness();
  });
  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockReturnValue(false);
    mockedClassifyAssistantFailoverReason.mockReturnValue(null);
    mockedClassifyFailoverReason.mockReturnValue(null);
    session = await createSharedRunIntegrationSession();
  });
  afterEach(async () => {
    await session?.cleanup();
  });

  it("cancels a long retry wait when its lane expires without aborting the caller", async () => {
    const { sleepWithAbort } = await import("../../infra/backoff.js");
    const { sleepWithAbort: sleep } = await import("../../../packages/retry/src/index.js");
    const mockedSleep = vi.mocked(sleepWithAbort);
    const previousSleep = mockedSleep.getMockImplementation();
    const caller = new AbortController();
    let sleepSignal: AbortSignal | undefined;
    let wait: Promise<void> | undefined;
    let waitSettled = false;
    let pending: ReturnType<typeof run> | undefined;
    vi.useFakeTimers();
    try {
      mockedSleep.mockImplementation((delayMs, signal) => {
        sleepSignal = signal;
        wait = sleep(delayMs, signal).finally(() => {
          waitSettled = true;
        });
        return wait;
      });
      const assistant = makeAssistantMessageFixture({
        stopReason: "error",
        content: [],
        errorMessage: "429 rate limit exceeded; Retry-After: 3600",
      });
      mockedRunEmbeddedAttempt.mockResolvedValue(
        makeAttemptResult({
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
        }),
      );
      pending = run({
        ...session.runParams,
        runId: "run-retry-lane-expiry",
        provider: "mock",
        model: "model",
        timeoutMs: 30_000,
        abortSignal: caller.signal,
      });
      const outcome = pending.catch((error: unknown) => error);
      await vi.waitFor(() => expect(mockedSleep).toHaveBeenCalled(), { timeout: 10_000 });
      expect(mockedSleep).toHaveBeenCalledWith(3_600_000, expect.any(AbortSignal));
      expect(waitSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(60_001);
      expect(await outcome).toMatchObject({ name: "CommandLaneTaskTimeoutError" });
      expect(caller.signal.aborted).toBe(false);
      expect(sleepSignal?.aborted).toBe(true);
      expect(waitSettled).toBe(true);
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    } finally {
      caller.abort();
      await wait?.catch(() => undefined);
      await pending?.catch(() => undefined);
      mockedSleep.mockImplementation(previousSleep ?? (async () => {}));
      vi.useRealTimers();
    }
  });

  it.each(["recovered", "exhausted", "caller-deferred"] as const)(
    "publishes only the owning terminal after %s attempts",
    async (outcome) => {
      let attempts = 0;
      const onAgentEvent = vi.fn();
      mockedRunEmbeddedAttempt.mockImplementation(async (params) => {
        const failed = ++attempts === 1 || outcome === "exhausted";
        const assistant = makeAssistantMessageFixture({
          provider: "mock",
          model: "model",
          stopReason: failed ? "error" : "stop",
          content: failed ? [] : [{ type: "text", text: "Recovered reply" }],
          errorMessage: failed ? "provider failure" : undefined,
        });
        await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
        // Harnesses defer their attempt terminal when the logical-run owner requests it.
        await params.onAgentEvent?.({
          stream: "lifecycle",
          data: {
            phase: params.deferTerminalLifecycle ? "finishing" : failed ? "error" : "end",
            ...(failed ? { error: "provider failure" } : {}),
          },
        });
        return makeAttemptResult({
          assistantTexts: failed ? [] : ["Recovered reply"],
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
        });
      });
      await run({
        ...session.runParams,
        provider: "mock",
        model: "model",
        onAgentEvent,
        deferTerminalLifecycle: outcome === "caller-deferred",
      });
      const terminals = onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter(
          (event) => event.stream === "lifecycle" && ["end", "error"].includes(event.data.phase),
        );
      expect(attempts).toBe(outcome === "exhausted" ? 4 : 2);
      expect(terminals).toEqual(
        outcome === "caller-deferred"
          ? []
          : [
              expect.objectContaining({
                stream: "lifecycle",
                data: expect.objectContaining({
                  phase: outcome === "exhausted" ? "error" : "end",
                  executionSettled: true,
                }),
              }),
            ],
      );
    },
  );
});
