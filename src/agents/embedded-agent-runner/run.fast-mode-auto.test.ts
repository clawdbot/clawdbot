import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onAgentEvent,
  resetAgentEventsForTest,
  type AgentEventPayload,
} from "../../infra/agent-events.js";
import { createDeferred } from "../../shared/deferred.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedClassifyFailoverReason,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

function successAttempt(provider: string, model: string): EmbeddedRunAttemptResult {
  return makeAttemptResult({
    assistantTexts: ["done"],
    lastAssistant: {
      stopReason: "stop",
      provider,
      model,
      content: [{ type: "text", text: "done" }],
      usage: { input: 100, output: 5, totalTokens: 105 },
    } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
  });
}

type FastModeAttemptParams = {
  fastMode?: unknown;
  fastModeAutoOnSeconds?: number;
  fastModeAutoProgressState?: {
    offAnnounced: boolean;
    resetAnnounced: boolean;
  };
  onAgentEvent?: (event: { stream: string; data: Record<string, unknown> }) => unknown;
  onRunProgress?: (payload: { reason: string }) => unknown;
  onToolStreamBoundary?: () => unknown;
  onToolResult?: (payload: { text?: string; channelData?: Record<string, unknown> }) => unknown;
};

function resolveAttemptFastMode(params: unknown): void {
  const fastMode = (params as { fastMode?: unknown }).fastMode;
  if (typeof fastMode === "function") {
    fastMode();
  }
}

describe("runEmbeddedAgent fast auto progress", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
    mockedClassifyFailoverReason.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAgentEventsForTest();
  });

  it("uses the selected model's auto cutoff when the caller omits one", async () => {
    let attemptParams: FastModeAttemptParams | undefined;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params) => {
      attemptParams = params as FastModeAttemptParams;
      resolveAttemptFastMode(params);
      return successAttempt("ollama", "glm-5.1:cloud");
    });

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "ollama",
      model: "glm-5.1:cloud",
      config: {
        agents: {
          defaults: {
            models: {
              "ollama/glm-5.1:cloud": { params: { fastAutoOnSeconds: 23 } },
            },
          },
        },
      },
      fastMode: "auto",
    });

    expect(attemptParams?.fastModeAutoOnSeconds).toBe(23);
  });

  it("emits auto-off after a tool execution boundary crosses the threshold", async () => {
    vi.useFakeTimers();

    const events: Array<{
      data?: { summary?: unknown };
    }> = [];
    const toolResults: Array<{
      text?: string;
      channelData?: Record<string, unknown>;
    }> = [];
    const globalSummaries: string[] = [];
    const stopGlobalCapture = onAgentEvent((event: AgentEventPayload) => {
      if (event.runId !== "run-fast-auto-retry" || event.stream !== "item") {
        return;
      }
      const summary = event.data.summary;
      if (typeof summary === "string") {
        globalSummaries.push(summary);
      }
    });
    let attemptParams: FastModeAttemptParams | undefined;
    let completeAttempt: (() => void) | undefined;
    const attemptDone = new Promise<EmbeddedRunAttemptResult>((resolve) => {
      completeAttempt = () => {
        resolve(successAttempt("ollama", "glm-5.1:cloud"));
      };
    });
    const attemptStarted = createDeferred();
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params) => {
      attemptParams = params as FastModeAttemptParams;
      resolveAttemptFastMode(params);
      attemptStarted.resolve();
      return attemptDone;
    });

    const resultPromise = runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "ollama",
      model: "glm-5.1:cloud",
      runId: "run-fast-auto-retry",
      fastMode: "auto",
      fastModeAutoOnSeconds: 30,
      onAgentEvent: (event) => {
        events.push(event);
      },
      onToolResult: (payload) => {
        toolResults.push(payload);
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    await attemptStarted.promise;
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31_000);

    expect(events.map((event) => event.data?.summary).filter(Boolean)).toHaveLength(0);
    expect(toolResults).toHaveLength(0);
    expect(globalSummaries).toHaveLength(0);

    attemptParams?.onRunProgress?.({ reason: "model-progress" });
    await vi.advanceTimersByTimeAsync(2);
    expect(events).toHaveLength(0);
    expect(toolResults).toHaveLength(0);
    expect(globalSummaries).toHaveLength(0);

    await attemptParams?.onToolResult?.({ text: "🛠️ Exec: still running" });
    await vi.advanceTimersByTimeAsync(2);
    expect(events.map((event) => event.data?.summary).filter(Boolean)).toHaveLength(0);
    expect(toolResults.map((payload) => payload.text)).toEqual(["🛠️ Exec: still running"]);
    expect(globalSummaries).toHaveLength(0);

    await attemptParams?.onAgentEvent?.({
      stream: "tool",
      data: { phase: "start", name: "exec" },
    });
    await vi.advanceTimersByTimeAsync(2);

    expect(events.map((event) => event.data?.summary).filter(Boolean)).toHaveLength(0);
    expect(toolResults.map((payload) => payload.text)).toEqual(["🛠️ Exec: still running"]);
    expect(globalSummaries).toHaveLength(0);

    await attemptParams?.onAgentEvent?.({
      stream: "tool",
      data: { phase: "result", name: "exec" },
    });
    await vi.advanceTimersByTimeAsync(2);

    expect(events.map((event) => event.data?.summary).filter(Boolean)).toHaveLength(0);
    expect(globalSummaries).toHaveLength(0);

    await attemptParams?.onToolStreamBoundary?.();
    await vi.advanceTimersByTimeAsync(2);

    const summaries = events.map((event) => event.data?.summary).filter(Boolean);
    expect(summaries).toContain("💨Fast: auto-off(31s>=30s)");
    expect(globalSummaries).toContain("💨Fast: auto-off(31s>=30s)");
    expect(toolResults.some((payload) => payload.text === "💨Fast: auto-off(31s>=30s)")).toBe(true);
    expect(toolResults.at(-1)?.channelData?.openclawProgressKind).toBe("fast-mode-auto");

    completeAttempt?.();
    await resultPromise;

    expect(events.map((event) => event.data?.summary)).toContain("💨Fast: auto-on");
    expect(toolResults.map((payload) => payload.text)).toContain("💨Fast: auto-on");
    expect(globalSummaries).toContain("💨Fast: auto-on");
    stopGlobalCapture();
  });

  it("emits one auto-off notice at the first completed boundary past the threshold", async () => {
    vi.useFakeTimers();

    const events: Array<{
      data?: { summary?: unknown };
    }> = [];
    const toolResults: Array<{
      text?: string;
      channelData?: Record<string, unknown>;
    }> = [];
    let attemptParams: FastModeAttemptParams | undefined;
    let completeAttempt: (() => void) | undefined;
    const attemptDone = new Promise<EmbeddedRunAttemptResult>((resolve) => {
      completeAttempt = () => {
        resolve(successAttempt("ollama", "glm-5.1:cloud"));
      };
    });
    const attemptStarted = createDeferred();
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params) => {
      attemptParams = params as FastModeAttemptParams;
      resolveAttemptFastMode(params);
      attemptStarted.resolve();
      return attemptDone;
    });

    const resultPromise = runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "ollama",
      model: "glm-5.1:cloud",
      runId: "run-fast-auto-single-off",
      fastMode: "auto",
      fastModeAutoOnSeconds: 30,
      onAgentEvent: (event) => {
        events.push(event);
      },
      onToolResult: (payload) => {
        toolResults.push(payload);
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    await attemptStarted.promise;
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31_000);
    await attemptParams?.onAgentEvent?.({
      stream: "tool",
      data: { phase: "result", name: "exec" },
    });
    await attemptParams?.onToolStreamBoundary?.();

    await vi.advanceTimersByTimeAsync(14_000);
    await attemptParams?.onAgentEvent?.({
      stream: "tool",
      data: { phase: "result", name: "exec" },
    });
    await attemptParams?.onToolStreamBoundary?.();
    await attemptParams?.onToolResult?.({ text: "🛠️ Exec: later tool summary" });

    completeAttempt?.();
    await resultPromise;

    const autoOffEvents = events
      .map((event) => event.data?.summary)
      .filter((summary) => typeof summary === "string" && summary.includes("Fast: auto-off"));
    const autoOffToolResults = toolResults
      .map((payload) => payload.text)
      .filter((text) => typeof text === "string" && text.includes("Fast: auto-off"));

    expect(autoOffEvents).toEqual(["💨Fast: auto-off(31s>=30s)"]);
    expect(autoOffToolResults).toEqual(["💨Fast: auto-off(31s>=30s)"]);
    expect(attemptParams?.fastModeAutoProgressState).toMatchObject({
      offAnnounced: true,
      resetAnnounced: true,
    });
  });

  it.each(["agent-event", "tool-result"] as const)(
    "keeps successful runs when fast auto-off %s delivery fails",
    async (failureTarget) => {
      vi.useFakeTimers();

      const events: Array<{
        data?: { summary?: unknown };
      }> = [];
      const toolResults: Array<{
        text?: string;
        channelData?: Record<string, unknown>;
      }> = [];
      let attemptParams: FastModeAttemptParams | undefined;
      let completeAttempt: (() => void) | undefined;
      const attemptDone = new Promise<EmbeddedRunAttemptResult>((resolve) => {
        completeAttempt = () => {
          resolve(successAttempt("ollama", "glm-5.1:cloud"));
        };
      });
      const attemptStarted = createDeferred();
      mockedRunEmbeddedAttempt.mockImplementationOnce(async (params) => {
        attemptParams = params as FastModeAttemptParams;
        resolveAttemptFastMode(params);
        attemptStarted.resolve();
        return attemptDone;
      });

      const resultPromise = runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "ollama",
        model: "glm-5.1:cloud",
        runId: `run-fast-auto-off-${failureTarget}`,
        fastMode: "auto",
        timeoutMs: 120_000,
        onAgentEvent: (event) => {
          events.push(event);
          const summary = event.data?.summary;
          if (
            failureTarget === "agent-event" &&
            typeof summary === "string" &&
            summary.startsWith("💨Fast: auto-off")
          ) {
            throw new Error("auto-off event delivery failed");
          }
        },
        onToolResult: (payload) => {
          toolResults.push(payload);
          if (failureTarget === "tool-result" && payload.text?.startsWith("💨Fast: auto-off")) {
            throw new Error("auto-off tool delivery failed");
          }
        },
      });

      await vi.advanceTimersByTimeAsync(0);
      await attemptStarted.promise;
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(61_000);
      await attemptParams?.onAgentEvent?.({
        stream: "tool",
        data: { phase: "result", name: "exec" },
      });
      await attemptParams?.onToolStreamBoundary?.();

      completeAttempt?.();
      await expect(resultPromise).resolves.toBeTruthy();

      expect(events.map((event) => event.data?.summary).filter(Boolean)).toContainEqual(
        expect.stringMatching(/^💨Fast: auto-off\(/u),
      );
      if (failureTarget === "tool-result") {
        expect(toolResults.map((payload) => payload.text)).toContainEqual(
          expect.stringMatching(/^💨Fast: auto-off\(/u),
        );
      }
    },
  );

  it.each(["agent-event", "tool-result"] as const)(
    "keeps successful runs when fast auto reset %s delivery fails",
    async (failureTarget) => {
      vi.useFakeTimers();

      const events: Array<{
        data?: { summary?: unknown };
      }> = [];
      const toolResults: Array<{
        text?: string;
        channelData?: Record<string, unknown>;
      }> = [];
      let attemptParams: FastModeAttemptParams | undefined;
      let completeAttempt: (() => void) | undefined;
      const attemptDone = new Promise<EmbeddedRunAttemptResult>((resolve) => {
        completeAttempt = () => {
          resolve(successAttempt("ollama", "glm-5.1:cloud"));
        };
      });
      const attemptStarted = createDeferred();
      mockedRunEmbeddedAttempt.mockImplementationOnce(async (params) => {
        attemptParams = params as FastModeAttemptParams;
        resolveAttemptFastMode(params);
        attemptStarted.resolve();
        return attemptDone;
      });

      const resultPromise = runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "ollama",
        model: "glm-5.1:cloud",
        runId: `run-fast-auto-reset-${failureTarget}`,
        fastMode: "auto",
        timeoutMs: 120_000,
        onAgentEvent: (event) => {
          events.push(event);
          if (failureTarget === "agent-event" && event.data?.summary === "💨Fast: auto-on") {
            throw new Error("reset event delivery failed");
          }
        },
        onToolResult: (payload) => {
          toolResults.push(payload);
          if (failureTarget === "tool-result" && payload.text === "💨Fast: auto-on") {
            throw new Error("reset tool delivery failed");
          }
        },
      });

      await vi.advanceTimersByTimeAsync(0);
      await attemptStarted.promise;
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(61_000);
      await attemptParams?.onAgentEvent?.({
        stream: "tool",
        data: { phase: "result", name: "exec" },
      });
      await attemptParams?.onToolStreamBoundary?.();

      expect(events.map((event) => event.data?.summary).filter(Boolean)).toContainEqual(
        expect.stringMatching(/^💨Fast: auto-off\(/u),
      );

      completeAttempt?.();
      await expect(resultPromise).resolves.toBeTruthy();

      expect(events.map((event) => event.data?.summary)).toContain("💨Fast: auto-on");
      if (failureTarget === "tool-result") {
        expect(toolResults.map((payload) => payload.text)).toContain("💨Fast: auto-on");
      }
    },
  );
});
