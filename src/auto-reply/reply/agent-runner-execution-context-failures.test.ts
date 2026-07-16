import { describe, expect, it, vi } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import type { SessionEntry } from "../../config/sessions.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import {
  setupAgentRunnerExecutionTestState,
  GENERIC_RUN_FAILURE_TEXT,
  makeTestModel,
  getRunAgentTurnWithFallback,
  createFollowupRun,
  createMockReplyOperation,
  requireRecord,
  expectRecordFields,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = setupAgentRunnerExecutionTestState();

describe("runAgentTurnWithFallback: context failures", () => {
  it("preserves the active session when embedded overflow recovery fails", async () => {
    state.isContextOverflowErrorMock.mockReturnValue(true);
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {
        error: {
          message: "400 The prompt is too long: 203557, model maximum context length: 196607",
        },
      },
    });

    const activeSessionEntry = { sessionId: "session", updatedAt: 1 } as SessionEntry;
    const activeSessionStore = { "agent:main:main": activeSessionEntry };
    const { replyOperation, failMock, updateSessionIdMock } = createMockReplyOperation();
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({
        sessionCtx: {
          Provider: "webchat",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
      replyOperation,
      sessionKey: "agent:main:main",
      getActiveSessionEntry: () => activeSessionEntry,
      activeSessionStore,
      storePath: "/tmp/sessions.json",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("kept this conversation mapped to the current session");
      expect(result.payload.text).toContain("reserveTokensFloor");
      expectRecordFields(requireRecord(getReplyPayloadMetadata(result.payload), "reply metadata"), {
        deliverDespiteSourceReplySuppression: true,
      });
    }
    expect(failMock).toHaveBeenCalledWith(
      "run_failed",
      expect.objectContaining({
        message: "400 The prompt is too long: 203557, model maximum context length: 196607",
      }),
    );
    expect(activeSessionStore["agent:main:main"]?.sessionId).toBe("session");
    expect(updateSessionIdMock).not.toHaveBeenCalled();
    expect(state.updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("preserves the active session when compaction failure is thrown before reply", async () => {
    state.isCompactionFailureErrorMock.mockReturnValue(true);
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error("Auto-compaction failed: nothing to compact"),
    );

    const activeSessionEntry = { sessionId: "session", updatedAt: 1 } as SessionEntry;
    const activeSessionStore = { "agent:main:main": activeSessionEntry };
    const { replyOperation, failMock, updateSessionIdMock } = createMockReplyOperation();
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({
        sessionCtx: {
          Provider: "webchat",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
      replyOperation,
      sessionKey: "agent:main:main",
      getActiveSessionEntry: () => activeSessionEntry,
      activeSessionStore,
      storePath: "/tmp/sessions.json",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("kept this conversation mapped to the current session");
      expect(result.payload.text).toContain("reserveTokensFloor");
      expectRecordFields(requireRecord(getReplyPayloadMetadata(result.payload), "reply metadata"), {
        deliverDespiteSourceReplySuppression: true,
      });
    }
    expect(failMock).toHaveBeenCalledWith(
      "run_failed",
      expect.objectContaining({ message: "Auto-compaction failed: nothing to compact" }),
    );
    expect(activeSessionStore["agent:main:main"]?.sessionId).toBe("session");
    expect(updateSessionIdMock).not.toHaveBeenCalled();
    expect(state.updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      reason: "server_error" as const,
      message: "upstream provider failed briefly",
    },
    {
      reason: "timeout" as const,
      message: "provider request timed out without status token",
    },
  ])(
    "retries once for structured FailoverError $reason without leading HTTP status text",
    async ({ reason, message }) => {
      vi.useFakeTimers();
      state.runEmbeddedAgentMock
        .mockRejectedValueOnce(
          new FailoverError(message, {
            reason,
            provider: "openai",
            model: "gpt-5.5",
          }),
        )
        .mockResolvedValueOnce({
          payloads: [{ text: "recovered after transient failover" }],
          meta: {},
        });

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const resultPromise = runAgentTurnWithFallback(createMinimalRunAgentTurnParams());
      await vi.advanceTimersByTimeAsync(2_500);
      const result = await resultPromise;

      expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
      expect(result.kind).toBe("success");
      if (result.kind === "success") {
        expect(result.runResult.payloads?.[0]?.text).toBe("recovered after transient failover");
      }
    },
  );

  it("uses structured FailoverError context_overflow over non-overflow message text", async () => {
    state.isLikelyContextOverflowErrorMock.mockReturnValue(false);
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new FailoverError("provider rejected the request payload", {
        reason: "context_overflow",
        provider: "anthropic",
        model: "claude",
      }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        sessionCtx: {
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "direct",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model.",
      );
      expect(result.payload.text).not.toBe(GENERIC_RUN_FAILURE_TEXT);
      expect(result.payload.text).not.toContain("provider rejected the request payload");
    }
  });

  it("uses the throwing fallback candidate model for compaction failure hints", async () => {
    state.isCompactionFailureErrorMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params.run("custom", "uncataloged-32k");
      throw new Error("expected fallback candidate to throw");
    });
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error("Auto-compaction failed: nothing to compact"),
    );

    const followupRun = createFollowupRun();
    followupRun.run.provider = "openrouter";
    followupRun.run.model = "qwen3.6-plus";
    followupRun.run.config = {
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.test",
            models: [makeTestModel("qwen3.6-plus", 1_000_000)],
          },
        },
      },
    };

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams({ followupRun }));

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("reserveTokensFloor");
      expect(result.payload.text).toContain("20000");
      expect(result.payload.text).not.toContain("100000");
    }
  });
});
