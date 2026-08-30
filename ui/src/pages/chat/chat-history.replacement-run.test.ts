// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { activeHistory, createState, renderedText } from "./chat-history.inflight.test-support.ts";
import { loadChatHistory, type ChatHistoryResult } from "./chat-history.ts";
import { handleAgentEvent } from "./tool-stream.ts";

describe("chat history replacement-run recovery", () => {
  it.each(
    (["full", "delta"] as const).flatMap((kind) => [
      {
        kind,
        activeRunIds: ["run-next"],
        expectedRunId: "run-next",
        evidence: "replacement",
        liveBeforeSnapshot: false,
      },
      {
        kind,
        activeRunIds: ["run-next"],
        expectedRunId: "run-next",
        evidence: "replacement with live progress",
        liveBeforeSnapshot: true,
      },
      {
        kind,
        activeRunIds: ["run-previous", "run-next"],
        expectedRunId: "run-previous",
        evidence: "both active",
        liveBeforeSnapshot: false,
      },
      {
        kind,
        activeRunIds: undefined,
        expectedRunId: "run-previous",
        evidence: "unknown active identities",
        liveBeforeSnapshot: false,
      },
    ]),
  )(
    "reconciles a retained run from $kind history with $evidence",
    async ({ kind, activeRunIds, expectedRunId, liveBeforeSnapshot }) => {
      const initial = activeHistory("run-previous");
      initial.sessionId = "retained-session";
      initial.sessionInfo!.activeLeafEntryId = "previous-leaf";
      initial.inFlightRun!.text = "Previous run text.";
      initial.deltaCursor = kind === "delta" ? "cursor-previous" : undefined;
      const state = createState(initial);
      state.chatMessagesBySession = new Map();
      const request = vi.fn().mockResolvedValue(initial);
      state.client = { request } as unknown as GatewayBrowserClient;
      await loadChatHistory(state);
      state.chatStreamSegments = [{ runId: "run-previous", text: "Earlier commentary.", ts: 1 }];

      const next = activeHistory("run-next");
      next.sessionId = "retained-session";
      next.sessionInfo!.activeLeafEntryId = kind === "full" ? "next-leaf" : "previous-leaf";
      next.sessionInfo!.activeRunIds = activeRunIds;
      next.inFlightRun!.text = "Next run text.";
      const response = {
        ...next,
        ...(kind === "delta" ? { kind: "delta", deltaCursor: "cursor-next" } : {}),
      };
      const pending = createDeferred<typeof response>();
      request.mockReturnValue(pending.promise);
      const loading = loadChatHistory(state);
      expect(request).toHaveBeenLastCalledWith(
        "chat.history",
        expect.objectContaining(
          kind === "delta" ? { cursor: "cursor-previous" } : { sessionKey: "main" },
        ),
      );
      if (liveBeforeSnapshot) {
        handleChatGatewayEvent(state, {
          runId: "run-next",
          sessionKey: "main",
          state: "delta",
          message: { role: "assistant", content: "Next run text. Earlier live progress." },
        });
      }
      pending.resolve(response);
      await loading;

      expect(state.chatRunId).toBe(expectedRunId);
      if (expectedRunId === "run-previous") {
        expect(state.chatStream).toBe("Previous run text.");
        return;
      }
      expect(state.chatStream).toBe(
        liveBeforeSnapshot ? "Next run text. Earlier live progress." : "Next run text.",
      );
      expect(state.chatStreamSegments).toEqual([]);
      handleChatGatewayEvent(state, {
        runId: "run-next",
        sessionKey: "main",
        state: "delta",
        message: { role: "assistant", content: "Next run text. Continuing live." },
      });
      expect(state.chatStream).toBe("Next run text. Continuing live.");
      expect(renderedText(state)).not.toContain("Earlier commentary.");
    },
  );

  it("does not replace a retained run that progressed while its history was pending", async () => {
    const response = createDeferred<ChatHistoryResult>();
    const state = createState(activeHistory("run-next"));
    state.client = { request: vi.fn(() => response.promise) } as unknown as GatewayBrowserClient;
    handleChatGatewayEvent(state, {
      runId: "run-previous",
      sessionKey: "main",
      state: "delta",
      deltaText: "Still working.",
    });
    const loading = loadChatHistory(state);
    handleChatGatewayEvent(state, {
      runId: "run-previous",
      sessionKey: "main",
      state: "delta",
      message: { role: "assistant", content: "Still working. Newer live progress." },
    });
    response.resolve(activeHistory("run-next"));
    await loading;
    expect(state.chatRunId).toBe("run-previous");
    expect(state.chatStream).toBe("Still working. Newer live progress.");
  });

  it.each(["before", "during"] as const)(
    "does not revive a replacement that completed %s history when its leaf advances",
    async (timing) => {
      const initial = activeHistory("run-previous");
      initial.sessionId = "retained-session";
      initial.sessionInfo!.activeLeafEntryId = "previous-leaf";
      initial.inFlightRun!.text = "Previous run text.";
      const state = createState(initial);
      const request = vi.fn().mockResolvedValue(initial);
      state.client = { request } as unknown as GatewayBrowserClient;
      await loadChatHistory(state);

      const next = activeHistory("run-next");
      next.sessionId = "retained-session";
      next.sessionInfo!.activeLeafEntryId = "next-leaf";
      next.inFlightRun!.text = "Stale replacement progress.";
      const response = createDeferred<ChatHistoryResult>();
      request.mockReturnValue(response.promise);
      const finishReplacement = () =>
        handleChatGatewayEvent(state, {
          runId: "run-next",
          sessionKey: "main",
          state: "final",
          message: { role: "assistant", content: "Replacement completed." },
        });
      if (timing === "before") {
        finishReplacement();
      }
      const loading = loadChatHistory(state);
      if (timing === "during") {
        finishReplacement();
      }
      response.resolve(next);
      await loading;

      expect(state.chatDisplayedLeafEntryId).toBe("next-leaf");
      expect(state.chatRunId).toBe("run-previous");
      expect(state.chatStream).toBe("Previous run text.");

      await loadChatHistory(state);
      expect(state.chatRunId).toBe("run-previous");
      expect(state.chatStream).toBe("Previous run text.");

      const latest = activeHistory("run-latest");
      latest.sessionId = "retained-session";
      latest.sessionInfo!.activeLeafEntryId = "latest-leaf";
      latest.inFlightRun!.text = "Latest run progress.";
      request.mockResolvedValue(latest);
      await loadChatHistory(state);
      expect(state.chatRunId).toBe("run-latest");

      request.mockResolvedValue(next);
      await loadChatHistory(state);
      expect(state.chatRunId).toBe("run-latest");
      expect(state.chatStream).toBe("Latest run progress.");
      finishReplacement();
      handleChatGatewayEvent(state, {
        runId: "run-next",
        sessionKey: "main",
        state: "error",
        errorMessage: "Old branch diagnostic.",
      });
      expect(renderedText(state)).not.toContain("Replacement completed.");
      expect(state.chatRunError).toBeNull();
    },
  );

  it("preserves replacement-run tool progress newer than its recovery snapshot", async () => {
    const response = createDeferred<ChatHistoryResult>();
    const history = activeHistory("run-next");
    const toolEvent = {
      runId: "run-next",
      seq: 1,
      stream: "tool",
      ts: 1,
      sessionKey: "main",
      data: { toolCallId: "next-tool", name: "read", phase: "result", result: "Earlier output" },
    };
    history.inFlightRun!.events = [toolEvent];
    const state = createState(history);
    state.client = { request: vi.fn(() => response.promise) } as unknown as GatewayBrowserClient;
    handleChatGatewayEvent(state, {
      runId: "run-previous",
      sessionKey: "main",
      state: "delta",
      deltaText: "Previous run text.",
    });
    const loading = loadChatHistory(state);
    handleAgentEvent(state, {
      ...toolEvent,
      seq: 2,
      data: { ...toolEvent.data, result: "Newer output" },
    });
    response.resolve(history);
    await loading;
    expect(state.chatRunId).toBe("run-next");
    expect(state.chatToolMessages).toHaveLength(1);
    expect(state.chatToolMessages[0]).toMatchObject({
      runId: "run-next",
      toolCallId: "next-tool",
      content: expect.arrayContaining([expect.objectContaining({ text: "Newer output" })]),
    });
  });

  it.each([
    { runId: "run-previous", phase: "start", retained: false },
    { runId: "run-next", phase: "start", retained: true },
    { runId: "run-next", phase: "end", retained: true },
  ])("scopes pending-history compaction $phase from $runId", async ({ runId, phase, retained }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("window", globalThis);
    try {
      const response = createDeferred<ChatHistoryResult>();
      const history = activeHistory("run-next");
      history.inFlightRun!.events = [];
      const event = {
        runId,
        seq: 1,
        stream: "compaction",
        ts: 1,
        sessionKey: "main",
        data: { phase: "start" },
      };
      const state = createState(history);
      state.client = { request: vi.fn(() => response.promise) } as unknown as GatewayBrowserClient;
      handleChatGatewayEvent(state, {
        runId: "run-previous",
        sessionKey: "main",
        state: "delta",
        deltaText: "Previous run text.",
      });
      const loading = loadChatHistory(state);
      handleAgentEvent(state, { ...event, seq: 2, data: { phase, completed: phase === "end" } });
      const indicator = state.compactionStatus;
      const timer = state.compactionClearTimer;
      expect(indicator?.runId).toBe(runId);
      expect(timer).not.toBeNull();
      response.resolve(history);
      await loading;

      expect(state.chatRunId).toBe("run-next");
      expect(state.compactionStatus).toBe(retained ? indicator : null);
      expect(state.compactionClearTimer).toBe(retained ? timer : null);
      vi.advanceTimersByTime(phase === "end" ? 5_000 : 5 * 60_000);
      expect(state.compactionStatus).toBeNull();
      expect(state.compactionClearTimer).toBeNull();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
