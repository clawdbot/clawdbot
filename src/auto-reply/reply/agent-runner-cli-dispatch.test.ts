// Tests CLI dispatch arguments and runtime selection for agent runner turns.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { createCliTimeoutError } from "../../agents/cli-runner/no-output-timeout-policy.js";
import { clearCliSessionInStore } from "../../agents/cli-session-store.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  resetAgentEventsForTest,
} from "../../infra/agent-events.js";
import {
  createCliToolSummaryTracker,
  keepCliSessionBindingOnlyWhenReused,
  runCliAgentWithLifecycle as runCliAgentWithLifecycleProduction,
} from "./agent-runner-cli-dispatch.js";

type ProductionLifecycleParams = Parameters<typeof runCliAgentWithLifecycleProduction>[0];
type RunCliAgentWithLifecycleParams = Omit<ProductionLifecycleParams, "runParams"> & {
  runParams: Omit<ProductionLifecycleParams["runParams"], "admittedRunContext">;
};
const runCliAgentWithLifecycle = (params: RunCliAgentWithLifecycleParams) =>
  runCliAgentWithLifecycleProduction({
    ...params,
    runParams: withTestAdmittedRunContext(params.runParams),
  });
type ReasoningTextPayload = Parameters<
  NonNullable<RunCliAgentWithLifecycleParams["onReasoningText"]>
>[0];
type ReasoningProgressPayload = Parameters<
  NonNullable<RunCliAgentWithLifecycleParams["onReasoningProgress"]>
>[0];

const cliDispatchState = vi.hoisted(() => ({
  runCliAgentMock: vi.fn(),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: (...args: unknown[]) => cliDispatchState.runCliAgentMock(...args),
}));

afterEach(() => {
  vi.useRealTimers();
  resetAgentEventsForTest();
  cliDispatchState.runCliAgentMock.mockReset();
});

describe("runCliAgentWithLifecycle", () => {
  it("bridges completed CLI compaction lifecycles to reply callbacks", async () => {
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      emitAgentEvent({
        runId: params.runId,
        stream: "compaction",
        data: { phase: "start", backend: "claude-cli" },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "compaction",
        data: { phase: "end", backend: "claude-cli", completed: false },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "compaction",
        data: { phase: "start", backend: "claude-cli" },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "compaction",
        data: { phase: "end", backend: "claude-cli", completed: true },
      });
      return { payloads: [], meta: { durationMs: 1 } };
    });
    const callbacks: string[] = [];

    await runCliAgentWithLifecycle({
      runId: "run-compaction-bridge",
      provider: "claude-cli",
      onCompactionStart: async () => {
        callbacks.push("start");
      },
      onCompactionEnd: async (payload) => {
        callbacks.push(payload?.completed === false ? "incomplete" : "end");
      },
      runParams: {
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        provider: "claude-cli",
        model: "claude-opus-4-8",
        thinkLevel: "high",
        timeoutMs: 1_000,
        runId: "run-compaction-bridge",
      },
    });

    expect(callbacks).toEqual(["start", "incomplete", "start", "end"]);
  });

  it("bridges typed CLI plan events", async () => {
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      emitAgentEvent({
        runId: params.runId,
        stream: "plan",
        data: {
          phase: "update",
          title: "Plan updated",
          source: "codex-exec",
          steps: [
            { step: "Inspect", status: "completed" },
            { step: "Patch", status: "pending" },
          ],
        },
      });
      return { payloads: [], meta: { durationMs: 1 } };
    });
    const onPlanUpdate = vi.fn(async () => undefined);

    await runCliAgentWithLifecycle({
      runId: "run-plan-bridge",
      provider: "codex-cli",
      onPlanUpdate,
      runParams: {
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        provider: "codex-cli",
        model: "codex",
        thinkLevel: "high",
        timeoutMs: 1_000,
        runId: "run-plan-bridge",
      },
    });

    expect(onPlanUpdate).toHaveBeenCalledWith({
      phase: "update",
      title: "Plan updated",
      explanation: undefined,
      source: "codex-exec",
      steps: [
        { step: "Inspect", status: "completed" },
        { step: "Patch", status: "pending" },
      ],
    });
  });

  it("normalizes shipped string-step plan events to pending typed steps", async () => {
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      emitAgentEvent({
        runId: params.runId,
        stream: "plan",
        data: {
          phase: "update",
          title: "Plan updated",
          source: "codex-exec",
          steps: ["Inspect", "  ", "Patch"],
        },
      });
      return { payloads: [], meta: { durationMs: 1 } };
    });
    const onPlanUpdate = vi.fn(async () => undefined);

    await runCliAgentWithLifecycle({
      runId: "run-plan-legacy",
      provider: "codex-cli",
      onPlanUpdate,
      runParams: {
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        provider: "codex-cli",
        model: "codex",
        thinkLevel: "high",
        timeoutMs: 1_000,
        runId: "run-plan-legacy",
      },
    });

    expect(onPlanUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          { step: "Inspect", status: "pending" },
          { step: "Patch", status: "pending" },
        ],
      }),
    );
  });

  it("bridges thinking events to reasoning text and dedupes identical snapshots", async () => {
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { text: "Thinking", delta: "Thinking", isReasoningSnapshot: true },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { text: "Thinking", delta: "", isReasoningSnapshot: true },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { text: "Thinking more", delta: " more", isReasoningSnapshot: true },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "Visible answer", delta: "Visible answer" },
      });
      return { payloads: [{ text: "Visible answer" }], meta: { durationMs: 1 } };
    });
    const onReasoningText = vi.fn<(payload: ReasoningTextPayload) => Promise<void>>(
      async () => undefined,
    );

    const result = await runCliAgentWithLifecycle({
      runId: "run-thinking-bridge",
      provider: "claude-cli",
      onReasoningText,
      runParams: {
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        provider: "claude-cli",
        model: "claude",
        thinkLevel: "high",
        timeoutMs: 1_000,
        runId: "run-thinking-bridge",
      },
    });

    expect(onReasoningText).toHaveBeenCalledTimes(2);
    expect(onReasoningText.mock.calls.map((call) => call[0])).toEqual([
      { text: "Thinking", isReasoningSnapshot: true },
      { text: "Thinking more", isReasoningSnapshot: true },
    ]);
    expect(result.payloads).toEqual([
      { text: "Thinking more", isReasoning: true },
      { text: "Visible answer" },
    ]);
  });

  it("keeps durable reasoning when the CLI has no visible final answer", async () => {
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { text: "Only thinking", delta: "Only thinking", isReasoningSnapshot: true },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { text: "Only thinking more", delta: " more", isReasoningSnapshot: true },
      });
      return { payloads: [], meta: { durationMs: 1 } };
    });

    const result = await runCliAgentWithLifecycle({
      runId: "run-thinking-without-answer",
      provider: "claude-cli",
      runParams: {
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        provider: "claude-cli",
        model: "claude",
        thinkLevel: "high",
        timeoutMs: 1_000,
        runId: "run-thinking-without-answer",
      },
    });

    expect(result.payloads).toEqual([{ text: "Only thinking more", isReasoning: true }]);
  });

  it("bridges thinking token progress without adding durable reasoning", async () => {
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { progressTokens: 50 },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { progressTokens: 50 },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { progressTokens: 200 },
      });
      return { payloads: [{ text: "Visible answer" }], meta: { durationMs: 1 } };
    });
    const onReasoningProgress = vi.fn<(payload: ReasoningProgressPayload) => Promise<void>>(
      async () => undefined,
    );

    const result = await runCliAgentWithLifecycle({
      runId: "run-thinking-progress",
      provider: "claude-cli",
      onReasoningProgress,
      runParams: {
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        provider: "claude-cli",
        model: "claude",
        thinkLevel: "high",
        timeoutMs: 1_000,
        runId: "run-thinking-progress",
      },
    });

    expect(onReasoningProgress.mock.calls.map((call) => call[0])).toEqual([
      { progressTokens: 50 },
      { progressTokens: 200 },
    ]);
    expect(result.payloads).toEqual([{ text: "Visible answer" }]);
  });

  it("stamps onActivity for every delivered bridge event, including reasoning-only progress", async () => {
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { progressTokens: 50 },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { progressTokens: 50 },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { progressTokens: 200 },
      });
      return { payloads: [], meta: { durationMs: 1 } };
    });
    const onActivity = vi.fn();
    const onReasoningProgress = vi.fn<(payload: ReasoningProgressPayload) => Promise<void>>(
      async () => undefined,
    );

    await runCliAgentWithLifecycle({
      runId: "run-activity-reasoning-progress",
      provider: "claude-cli",
      onActivity,
      onReasoningProgress,
      runParams: {
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        provider: "claude-cli",
        model: "claude",
        thinkLevel: "high",
        timeoutMs: 1_000,
        runId: "run-activity-reasoning-progress",
      },
    });

    // A run in a long pure-reasoning stretch must keep stamping activity, or
    // stale-takeover reclaims it while it is visibly thinking. Stamps are
    // per-event (delivery-independent), so dedupe downstream does not matter.
    expect(onReasoningProgress).toHaveBeenCalledTimes(2);
    expect(onActivity).toHaveBeenCalledTimes(3);
  });

  it("keeps stamping onActivity when bridges are suppressed for silent runs", async () => {
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { progressTokens: 50 },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "Silent answer", delta: "Silent answer" },
      });
      return { payloads: [], meta: { durationMs: 1 } };
    });
    const onActivity = vi.fn();
    const onAssistantText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    const onReasoningProgress = vi.fn<(payload: ReasoningProgressPayload) => Promise<void>>(
      async () => undefined,
    );

    await runCliAgentWithLifecycle({
      runId: "run-activity-suppressed",
      provider: "claude-cli",
      suppressAssistantBridge: true,
      onActivity,
      onAssistantText,
      onReasoningProgress,
      runParams: {
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        provider: "claude-cli",
        model: "claude",
        thinkLevel: "high",
        timeoutMs: 1_000,
        runId: "run-activity-suppressed",
      },
    });

    // silentExpected runs suppress deliveries, but their events are still real
    // liveness evidence — without these stamps a healthy silent run would be
    // reclaimed as run_stalled at the takeover window.
    expect(onAssistantText).not.toHaveBeenCalled();
    expect(onReasoningProgress).not.toHaveBeenCalled();
    expect(onActivity).toHaveBeenCalledTimes(2);
  });

  it("stamps onActivity for assistant text without caller callbacks for that stream", async () => {
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { text: "Deep thought", delta: "Deep thought", isReasoningSnapshot: true },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "Visible answer", delta: "Visible answer" },
      });
      return { payloads: [{ text: "Visible answer" }], meta: { durationMs: 1 } };
    });
    const onActivity = vi.fn();
    const onAssistantText = vi.fn<(text: string) => Promise<void>>(async () => undefined);

    await runCliAgentWithLifecycle({
      runId: "run-activity-assistant",
      provider: "claude-cli",
      onActivity,
      onAssistantText,
      runParams: {
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        provider: "claude-cli",
        model: "claude",
        thinkLevel: "high",
        timeoutMs: 1_000,
        runId: "run-activity-assistant",
      },
    });

    // Every real event stamps, independent of which callbacks are registered.
    expect(onAssistantText).toHaveBeenCalledTimes(1);
    expect(onActivity).toHaveBeenCalledTimes(2);
  });

  it("does not add a durable reasoning payload when the CLI emits no thinking", async () => {
    cliDispatchState.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Visible answer" }],
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    const result = await runCliAgentWithLifecycle({
      runId: "run-no-thinking",
      provider: "claude-cli",
      runParams: {
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        provider: "claude-cli",
        model: "claude",
        thinkLevel: "high",
        timeoutMs: 1_000,
        runId: "run-no-thinking",
      },
    });

    expect(result.payloads).toEqual([{ text: "Visible answer" }]);
  });

  it("keeps the captured lifecycle generation on start and terminal events", async () => {
    const events: Array<{
      stream?: string;
      lifecycleGeneration?: string;
      agentId?: string;
      data?: Record<string, unknown>;
    }> = [];
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const stop = onAgentEvent((event) => {
      if (event.runId === "run-before-restart") {
        events.push(event);
      }
    });
    cliDispatchState.runCliAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    try {
      await runCliAgentWithLifecycle({
        runId: "run-before-restart",
        lifecycleGeneration,
        startedAt: 1_000,
        provider: "claude-cli",
        runParams: {
          sessionId: "session-1",
          agentId: "support",
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/tmp/workspace",
          prompt: "hello",
          provider: "claude-cli",
          model: "claude",
          thinkLevel: "off",
          timeoutMs: 1_000,
          runId: "run-before-restart",
        },
      });
    } finally {
      stop();
    }

    const lifecycleEvents = events.filter((event) => event.stream === "lifecycle");
    expect(lifecycleEvents).toHaveLength(2);
    expect(
      lifecycleEvents.every((event) => event.lifecycleGeneration === lifecycleGeneration),
    ).toBe(true);
    expect(lifecycleEvents.every((event) => event.agentId === "support")).toBe(true);
    expect(lifecycleEvents.every((event) => event.data?.startedAt === 1_000)).toBe(true);
  });

  it("preserves restart ownership when the CLI resolves after cancellation", async () => {
    const events: Array<{ stream?: string; data?: Record<string, unknown> }> = [];
    const stop = onAgentEvent((event) => {
      if (event.runId === "run-restart") {
        events.push(event);
      }
    });
    const controller = new AbortController();
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async () => {
      controller.abort(createAgentRunRestartAbortError());
      return {
        payloads: [{ text: "stale result" }],
        meta: { durationMs: 1 },
      } satisfies EmbeddedAgentRunResult;
    });

    await expect(
      runCliAgentWithLifecycle({
        runId: "run-restart",
        provider: "claude-cli",
        runParams: {
          sessionId: "session-1",
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/tmp/workspace",
          prompt: "hello",
          provider: "claude-cli",
          model: "claude",
          thinkLevel: "off",
          timeoutMs: 1_000,
          runId: "run-restart",
          abortSignal: controller.signal,
        },
      }),
    ).rejects.toThrow("agent run aborted for restart");
    stop();

    const terminal = events.find(
      (event) => event.stream === "lifecycle" && event.data?.phase === "error",
    );
    expect(terminal?.data).toMatchObject({
      aborted: true,
      stopReason: "restart",
    });
    expect(events.some((event) => event.stream === "assistant")).toBe(false);
  });

  it("attributes a structured CLI watchdog timeout on the terminal event", async () => {
    const events: Array<{ stream?: string; data?: Record<string, unknown> }> = [];
    const stop = onAgentEvent((event) => {
      if (event.runId === "run-timeout") {
        events.push(event);
      }
    });
    cliDispatchState.runCliAgentMock.mockRejectedValueOnce(
      createCliTimeoutError(
        { provider: "claude-cli", model: "claude", sessionId: "session-1" },
        {
          mode: "no-output",
          timeoutSeconds: 1,
          observedActivity: false,
          activeToolCount: 0,
          backgroundTaskCount: 0,
        },
      ),
    );

    await expect(
      runCliAgentWithLifecycle({
        runId: "run-timeout",
        provider: "claude-cli",
        runParams: {
          sessionId: "session-1",
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/tmp/workspace",
          prompt: "hello",
          provider: "claude-cli",
          model: "claude",
          thinkLevel: "off",
          timeoutMs: 1_000,
          runId: "run-timeout",
        },
      }),
    ).rejects.toThrow("CLI produced no output");
    stop();

    expect(
      events.find((event) => event.stream === "lifecycle" && event.data?.phase === "error")?.data,
    ).toMatchObject({
      stopReason: "timeout",
      timeoutPhase: "provider",
    });
  });

  it("propagates yielded result metadata on lifecycle end", async () => {
    const events: Array<{ stream?: string; data?: Record<string, unknown> }> = [];
    const stop = onAgentEvent((event) => {
      if (event.runId === "run-yielded") {
        events.push(event);
      }
    });
    cliDispatchState.runCliAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {
        durationMs: 1,
        yielded: true,
        livenessState: "paused",
        stopReason: "end_turn",
      },
    } satisfies EmbeddedAgentRunResult);

    try {
      await runCliAgentWithLifecycle({
        runId: "run-yielded",
        provider: "claude-cli",
        runParams: {
          sessionId: "session-1",
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/tmp/workspace",
          prompt: "hello",
          provider: "claude-cli",
          model: "claude",
          thinkLevel: "off",
          timeoutMs: 1_000,
          runId: "run-yielded",
        },
      });
    } finally {
      stop();
    }

    const terminal = events.find(
      (event) => event.stream === "lifecycle" && event.data?.phase === "end",
    );
    expect(terminal?.data).toMatchObject({
      yielded: true,
      livenessState: "paused",
      stopReason: "end_turn",
    });
  });
});

describe("keepCliSessionBindingOnlyWhenReused", () => {
  it("keeps the first room-event CLI binding when no binding exists yet", () => {
    const result = {
      payloads: [],
      meta: {
        durationMs: 1,
        agentMeta: {
          sessionId: "new-cli-session",
          provider: "claude-cli",
          model: "claude-opus-4-8",
          cliSessionBinding: {
            sessionId: "new-cli-session",
            authProfileId: "profile",
          },
        },
      },
    } satisfies EmbeddedAgentRunResult;

    expect(keepCliSessionBindingOnlyWhenReused({ result })).toBe(result);
  });

  it("drops a replacement room-event CLI binding when an existing binding was reused", () => {
    const onDroppedReplacement = vi.fn();
    const result = keepCliSessionBindingOnlyWhenReused({
      existingSessionId: "existing-cli-session",
      onDroppedReplacement,
      result: {
        payloads: [],
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId: "replacement-cli-session",
            provider: "claude-cli",
            model: "claude-opus-4-8",
            cliSessionBinding: {
              sessionId: "replacement-cli-session",
              authProfileId: "profile",
            },
          },
        },
      } satisfies EmbeddedAgentRunResult,
    });

    expect(onDroppedReplacement).toHaveBeenCalledOnce();
    expect(result.meta.agentMeta?.sessionId).toBe("");
    expect(result.meta.agentMeta?.cliSessionBinding).toBeUndefined();
  });
});

describe("clearCliSessionInStore", () => {
  it.each(["current", "closed"])(
    "clears active and stored entries only for a %s owner",
    async (owner) => {
      const activeEntry = {
        sessionId: "openclaw-active",
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": { sessionId: "stale-session" } },
        cliSessionIds: { "claude-cli": "stale-session" },
        claudeCliSessionId: "stale-session",
      };
      const storedEntry = structuredClone(activeEntry);
      const storePath = path.join(tempDirs.make("cli-session-cleanup-"), "sessions.json");
      await replaceSessionEntry({ storePath, sessionKey: "main" }, structuredClone(activeEntry));

      let open = true;
      const clear = clearCliSessionInStore({
        provider: "claude-cli",
        expectedCliSessionId: "stale-session",
        expectedSessionId: activeEntry.sessionId,
        sessionKey: "main",
        sessionStore: { main: storedEntry },
        storePath,
        activeSessionEntry: activeEntry,
        assertCommitAllowed: () => {
          if (!open) {
            throw new Error("owner closed");
          }
        },
      });
      if (owner === "closed") {
        open = false;
        await expect(clear).rejects.toThrow("owner closed");
        for (const entry of [
          activeEntry,
          storedEntry,
          loadSessionEntry({ storePath, sessionKey: "main" }),
        ]) {
          expect(entry?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe("stale-session");
        }
        return;
      }
      await clear;

      for (const entry of [activeEntry, storedEntry]) {
        expect(entry.cliSessionBindings?.["claude-cli"]).toBeUndefined();
        expect(entry.cliSessionIds?.["claude-cli"]).toBeUndefined();
        expect(entry.claudeCliSessionId).toBeUndefined();
        expect(entry.updatedAt).toBeGreaterThan(1);
      }
      const persisted = loadSessionEntry({ storePath, sessionKey: "main" });
      expect(persisted?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
      expect(persisted?.cliSessionIds?.["claude-cli"]).toBeUndefined();
      expect(persisted?.claudeCliSessionId).toBeUndefined();
    },
  );

  it("does not clear a replacement binding adopted by another turn", async () => {
    const entry = {
      sessionId: "openclaw-active",
      updatedAt: 1,
      cliSessionBindings: { "claude-cli": { sessionId: "replacement-session" } },
      cliSessionIds: { "claude-cli": "replacement-session" },
      claudeCliSessionId: "replacement-session",
    };

    await clearCliSessionInStore({
      provider: "claude-cli",
      expectedCliSessionId: "stale-session",
      activeSessionEntry: entry,
    });

    expect(entry.cliSessionBindings["claude-cli"].sessionId).toBe("replacement-session");
    expect(entry.cliSessionIds["claude-cli"]).toBe("replacement-session");
    expect(entry.claudeCliSessionId).toBe("replacement-session");
    expect(entry.updatedAt).toBe(1);
  });
});

describe("createCliToolSummaryTracker", () => {
  const startEvent = {
    name: "exec",
    phase: "start" as const,
    args: { command: "date -u" },
    toolCallId: "tool-1",
  };
  const resultEvent = {
    name: "exec",
    phase: "result" as const,
    args: undefined,
    toolCallId: "tool-1",
    isError: false,
    result: { content: [{ type: "text", text: "Wed Jun 10 2026" }] },
  };

  it.each(["exec", "server.exec"])(
    "delivers a safe %s summary using metadata captured at start",
    async (name) => {
      const deliver = vi.fn();
      const tracker = createCliToolSummaryTracker({
        commandDetailsVisible: false,
        shouldEmitToolResult: () => true,
        shouldEmitToolOutput: () => false,
        deliver,
      });
      await tracker.noteToolEvent({ ...startEvent, name });
      const commandBearing = await tracker.noteToolEvent({ ...resultEvent, name });
      expect(commandBearing).toBe(true);
      expect(deliver).toHaveBeenCalledTimes(1);
      const payload = deliver.mock.calls[0]?.[0] as { text: string; isError?: boolean };
      expect(payload.text).toContain(name === "exec" ? "Exec" : "Server.exec");
      expect(payload.text).not.toContain("date -u");
      expect(payload.text).not.toContain("Wed Jun 10 2026");
      expect(payload.isError).toBeUndefined();
    },
  );

  it("appends the tool output block when full verbose output is enabled", async () => {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      commandDetailsVisible: true,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => true,
      deliver,
    });
    await tracker.noteToolEvent(startEvent);
    await tracker.noteToolEvent(resultEvent);
    const payload = deliver.mock.calls[0]?.[0] as { text: string };
    expect(payload.text).toContain("```txt");
    expect(payload.text).toContain("Wed Jun 10 2026");
  });

  it("renders top-level structured CLI results in full verbose output", async () => {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      commandDetailsVisible: true,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => true,
      deliver,
    });
    await tracker.noteToolEvent(startEvent);
    await tracker.noteToolEvent({
      ...resultEvent,
      result: [{ type: "web_search_result", title: "OpenClaw", url: "https://example.com" }],
    });

    const payload = deliver.mock.calls[0]?.[0] as { text: string };
    expect(payload.text).toContain('"type":"web_search_result"');
    expect(payload.text).toContain('"title":"OpenClaw"');
  });

  it("emits nothing while tool summaries are disabled", async () => {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      commandDetailsVisible: false,
      shouldEmitToolResult: () => false,
      shouldEmitToolOutput: () => false,
      deliver,
    });
    await tracker.noteToolEvent(startEvent);
    await tracker.noteToolEvent(resultEvent);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("leaves plan tools to the authoritative plan event instead of summarizing arguments", async () => {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      commandDetailsVisible: true,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => true,
      deliver,
    });
    await tracker.noteToolEvent({
      name: "progress_card",
      phase: "start",
      args: {
        markdown: '<progress aria-label="CI · 2/3" value="2" max="3"></progress>',
      },
      toolCallId: "plan-1",
    });
    await tracker.noteToolEvent({
      name: "progress_card",
      phase: "result",
      args: undefined,
      toolCallId: "plan-1",
      isError: false,
      result: { content: [{ type: "text", text: "Progress card updated" }] },
    });

    expect(deliver).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps card errors visible without arguments (full output: %s)",
    async (fullOutput) => {
      const deliver = vi.fn();
      const tracker = createCliToolSummaryTracker({
        commandDetailsVisible: false,
        shouldEmitToolResult: () => true,
        shouldEmitToolOutput: () => fullOutput,
        deliver,
      });
      await tracker.noteToolEvent({
        name: "progress_card",
        phase: "start",
        args: { markdown: '<progress aria-label="private" value="1" max="2"></progress>' },
        toolCallId: "plan-error",
      });
      await tracker.noteToolEvent({
        name: undefined,
        phase: "result",
        args: undefined,
        toolCallId: "plan-error",
        isError: true,
        result: { content: [{ type: "text", text: "write failed" }] },
      });

      expect(deliver).toHaveBeenCalledWith({
        text: fullOutput ? "🗺️ Progress Card\n```txt\nwrite failed\n```" : "🗺️ Progress Card",
        isError: true,
      });
    },
  );

  it("propagates tool errors on the summary payload", async () => {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      commandDetailsVisible: false,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      deliver,
    });
    await tracker.noteToolEvent(startEvent);
    await tracker.noteToolEvent({ ...resultEvent, isError: true });
    const payload = deliver.mock.calls[0]?.[0] as { isError?: boolean };
    expect(payload.isError).toBe(true);
  });

  it("summarizes results without a tracked start event", async () => {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      commandDetailsVisible: false,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      deliver,
    });
    await tracker.noteToolEvent({ ...resultEvent, toolCallId: "unseen" });
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe("runCliAgentWithLifecycle fast auto progress", () => {
  it("emits auto-off after the first CLI tool boundary past the threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const stop = onAgentEvent((evt) => {
      if (evt.runId === "run-fast-cli") {
        events.push({ stream: evt.stream, data: evt.data });
      }
    });
    const progressPayloads: string[] = [];
    cliDispatchState.runCliAgentMock.mockImplementation(async () => {
      emitAgentEvent({
        runId: "run-fast-cli",
        stream: "tool",
        data: { phase: "start", name: "bash", toolCallId: "call-1" },
      });
      vi.setSystemTime(7_100);
      emitAgentEvent({
        runId: "run-fast-cli",
        stream: "tool",
        data: { phase: "result", name: "bash", toolCallId: "call-1" },
      });
      return {
        payloads: [{ text: "done" }],
        meta: {
          durationMs: 7_100,
          agentMeta: { sessionId: "session-1", provider: "codex-cli", model: "gpt-5.5" },
        },
      } satisfies EmbeddedAgentRunResult;
    });

    await runCliAgentWithLifecycle({
      runId: "run-fast-cli",
      provider: "codex-cli",
      runParams: {
        sessionId: "session-1",
        sessionKey: "agent:main:cli-fast",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "run one tool",
        provider: "codex-cli",
        model: "gpt-5.5",
        timeoutMs: 60_000,
        runId: "run-fast-cli",
        fastMode: "auto",
        fastModeStartedAtMs: 1_000,
        fastModeAutoOnSeconds: 5,
      },
      onFastModeAutoProgress: async (payload) => {
        if (payload.text) {
          progressPayloads.push(payload.text);
        }
      },
    });
    stop();

    const summaries = events
      .filter((event) => event.stream === "item")
      .map((event) => event.data.summary);
    expect(summaries).toContain("💨Fast: auto-off(6s>=5s)");
    expect(summaries).toContain("💨Fast: auto-on");
    expect(progressPayloads).toEqual(["💨Fast: auto-off(6s>=5s)", "💨Fast: auto-on"]);
  });
});
