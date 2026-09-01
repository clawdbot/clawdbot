import { describe, expect, it } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import type { SessionEntry } from "../../config/sessions.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import {
  setupAgentRunnerExecutionTestState,
  GENERIC_RUN_FAILURE_TEXT,
  makeTestModel,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  initialFallbackAttemptOptions,
  createMockReplyOperation,
  requireRecord,
  expectRecordFields,
  createMinimalRunAgentTurnParams,
  makeTestSessionStorePath,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = setupAgentRunnerExecutionTestState();

describe("executeAgentTurn: context failures", () => {
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
    const followupRun = createFollowupRun();
    followupRun.run.agentId = "main";
    const { replyOperation, failMock, updateSessionIdMock } = createMockReplyOperation();
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: {
          Provider: "webchat",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
      replyOperation,
      sessionKey: "agent:main:main",
      getActiveSessionEntry: () => activeSessionEntry,
      activeSessionStore,
      storePath: makeTestSessionStorePath(),
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("kept this conversation mapped to the current session");
      expect(result.payload.text).toContain("fresh session or using a model");
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
    const followupRun = createFollowupRun();
    followupRun.run.agentId = "main";
    const { replyOperation, failMock, updateSessionIdMock } = createMockReplyOperation();
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: {
          Provider: "webchat",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
      replyOperation,
      sessionKey: "agent:main:main",
      getActiveSessionEntry: () => activeSessionEntry,
      activeSessionStore,
      storePath: makeTestSessionStorePath(),
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("kept this conversation mapped to the current session");
      expect(result.payload.text).toContain("fresh session or using a model");
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

  it("uses structured FailoverError context_overflow over non-overflow message text", async () => {
    state.isLikelyContextOverflowErrorMock.mockReturnValue(false);
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new FailoverError("provider rejected the request payload", {
        reason: "context_overflow",
        provider: "anthropic",
        model: "claude",
      }),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
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

  it("uses the built-in compaction failure hint when the fallback candidate throws", async () => {
    state.isCompactionFailureErrorMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params.run("custom", "uncataloged-32k", initialFallbackAttemptOptions(params));
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

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }));

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("fresh session or using a model");
    }
  });
});
