import { describe, expect, it, vi } from "vitest";
import { BILLING_ERROR_USER_MESSAGE } from "../../agents/failover/user-copy.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import * as autoFallback from "./agent-runner-auto-fallback.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  initialFallbackAttemptOptions,
  expectBlockReplyCall,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type {
  FallbackRunnerParams,
  EmbeddedAgentParams,
} from "./agent-runner-execution.test-support.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";

const state = setupAgentRunnerExecutionTestState();

async function executeTestTurn(
  params?: Parameters<typeof createMinimalRunAgentTurnParams>[0],
  overrides?: Partial<AgentTurnParams>,
) {
  const executeAgentTurn = await getExecuteAgentTurnForTest();
  return executeAgentTurn({ ...createMinimalRunAgentTurnParams(params), ...overrides });
}

function createNotifyUserRun() {
  const followupRun = createFollowupRun();
  followupRun.run.config = {
    agents: { defaults: { compaction: { notifyUser: true } } },
  };
  return followupRun;
}

describe("executeAgentTurn: compaction events", () => {
  it("keeps compaction start notices silent by default", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn({ opts: { onBlockReply } }, { commandBody: "hello" });

    expect(result.kind).toBe("success");
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("keeps compaction callbacks active when notices are silent by default", async () => {
    const onBlockReply = vi.fn();
    const onCompactionStart = vi.fn();
    const onCompactionEnd = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", completed: true },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn(
      {
        opts: {
          onBlockReply,
          onCompactionStart,
          onCompactionEnd,
        },
      },
      { commandBody: "hello" },
    );

    expect(result.kind).toBe("success");
    expect(onCompactionStart).toHaveBeenCalledTimes(1);
    expect(onCompactionEnd).toHaveBeenCalledTimes(1);
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("logs Codex app-server compaction completion while notices stay silent by default", async () => {
    const onBlockReply = vi.fn();
    const consoleLog = vi.fn();
    setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "compact" });
    loggingState.rawConsole = {
      log: consoleLog,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    try {
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => ({
          result: await params.run("openai", "gpt-5.5", initialFallbackAttemptOptions(params)),
          provider: "openai",
          model: "gpt-5.5",
          attempts: [{ provider: "anthropic", model: "claude", error: "rate limit" }],
        }),
      );
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        await params.onAgentEvent?.({
          stream: "compaction",
          data: {
            phase: "start",
            backend: "codex-app-server",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "compaction-1",
          },
        });
        await params.onAgentEvent?.({
          stream: "compaction",
          data: {
            phase: "end",
            completed: true,
            backend: "codex-app-server",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "compaction-1",
          },
        });
        return { payloads: [{ text: "final" }], meta: {} };
      });

      const result = await executeTestTurn({ opts: { onBlockReply } });

      expect(result.kind).toBe("success");
      expect(onBlockReply).not.toHaveBeenCalled();
      expect(consoleLog.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
        "codex app-server auto-compaction succeeded for openai/gpt-5.5; refreshed session context",
      );
    } finally {
      loggingState.rawConsole = null;
      setLoggerOverride(null);
      resetLogger();
    }
  });

  it("carries committed compaction through exhausted model failure", async () => {
    state.runEmbeddedAgentMock
      .mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        params.onAutoCompactionSucceeded?.(1);
        throw new Error("LLM request timed out.");
      })
      .mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        params.onExecutionPhase?.({ phase: "model_call_started" });
        return {
          payloads: [{ text: BILLING_ERROR_USER_MESSAGE, isError: true }],
          meta: { error: { kind: "billing", message: "billing unavailable" } },
        };
      });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params
        .run("openai", "gpt-5.5", initialFallbackAttemptOptions(params))
        .catch(() => undefined);
      return {
        outcome: "exhausted",
        result: await params.run(
          "anthropic",
          "claude-sonnet-4-6",
          initialFallbackAttemptOptions(params),
        ),
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        attempts: [
          {
            provider: "openai",
            model: "gpt-5.5",
            error: "LLM request timed out.",
            reason: "timeout",
          },
          {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            error: "billing unavailable",
            reason: "billing",
          },
        ],
      };
    });

    const result = await executeTestTurn();

    expect(result).toMatchObject({
      kind: "success",
      autoCompactionCount: 1,
      postCompactionModelFailure: true,
    });
  });

  it("carries committed compaction into a later CLI fallback failure", async () => {
    state.isCliProviderMock.mockImplementation((provider: unknown) => provider === "claude-cli");
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onAutoCompactionSucceeded?.(1);
      throw new Error("retry transcript preparation failed");
    });
    state.runCliAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onExecutionPhase?.({ phase: "process_spawned" });
      return {
        payloads: [{ text: BILLING_ERROR_USER_MESSAGE, isError: true }],
        meta: { error: { kind: "billing", message: "billing unavailable" } },
      };
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params
        .run("openai", "gpt-5.5", initialFallbackAttemptOptions(params))
        .catch(() => undefined);
      return {
        outcome: "exhausted",
        result: await params.run(
          "claude-cli",
          "claude-sonnet-4-6",
          initialFallbackAttemptOptions(params),
        ),
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
        attempts: [
          {
            provider: "openai",
            model: "gpt-5.5",
            error: "retry transcript preparation failed",
            reason: "unknown",
          },
          {
            provider: "claude-cli",
            model: "claude-sonnet-4-6",
            error: "billing unavailable",
            reason: "billing",
          },
        ],
      };
    });

    const result = await executeTestTurn();

    expect(result).toMatchObject({
      kind: "success",
      autoCompactionCount: 1,
      postCompactionModelFailure: true,
    });
  });

  it("does not create the failure fact before the compacted retry reaches the model", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onAutoCompactionSucceeded?.(1);
      throw new Error("retry transcript preparation failed");
    });

    const result = await executeTestTurn();

    expect(result).toMatchObject({ kind: "final" });
    expect(result.postCompactionModelFailure).toBeUndefined();
  });

  it("keeps successful compacted retries out of the failure fact", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onAutoCompactionSucceeded?.(1);
      params.onExecutionPhase?.({ phase: "model_call_started" });
      return {
        payloads: [{ text: "recovered" }],
        meta: { agentMeta: { compactionCount: 1 } },
      };
    });

    const result = await executeTestTurn();

    expect(result).toMatchObject({
      kind: "success",
      autoCompactionCount: 1,
      runResult: { payloads: [{ text: "recovered" }] },
    });
    expect(result.postCompactionModelFailure).toBeUndefined();
  });

  it("keeps session settlement failures out of the model failure fact", async () => {
    const settleSessionOverride = vi
      .spyOn(autoFallback, "clearRecoveredAutoFallbackPrimaryProbeSelection")
      .mockRejectedValueOnce(new Error("session override settlement failed"));
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onAutoCompactionSucceeded?.(1);
      params.onExecutionPhase?.({ phase: "model_call_started" });
      return { payloads: [{ text: "recovered" }], meta: {} };
    });

    try {
      const result = await executeTestTurn();

      expect(result).toMatchObject({ kind: "final" });
      expect(result.postCompactionModelFailure).toBeUndefined();
    } finally {
      settleSessionOverride.mockRestore();
    }
  });

  it("emits a compaction start notice when notifyUser is enabled", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn(
      { followupRun: createNotifyUserRun(), opts: { onBlockReply } },
      { commandBody: "hello" },
    );

    expect(result.kind).toBe("success");
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expectBlockReplyCall(onBlockReply, 0, {
      text: "🧹 Compacting context...",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
  });

  it("emits a compaction completion notice when notifyUser is enabled", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", completed: true },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn(
      { followupRun: createNotifyUserRun(), opts: { onBlockReply } },
      { commandBody: "hello" },
    );

    expect(result.kind).toBe("success");
    expectBlockReplyCall(onBlockReply, 0, {
      text: "🧹 Compacting context...",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
    expectBlockReplyCall(onBlockReply, 1, {
      text: "🧹 Compaction complete",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
  });

  it("delivers compaction hook messages alongside notifyUser notices (#90185)", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "start", messages: ["Hook before"] },
      });
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", completed: true, messages: ["Hook after"] },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn(
      { followupRun: createNotifyUserRun(), opts: { onBlockReply } },
      { commandBody: "hello" },
    );

    expect(result.kind).toBe("success");
    expect(onBlockReply).toHaveBeenCalledTimes(4);
    expectBlockReplyCall(onBlockReply, 0, {
      text: "Hook before",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
    expectBlockReplyCall(onBlockReply, 1, {
      text: "🧹 Compacting context...",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
    expectBlockReplyCall(onBlockReply, 2, {
      text: "Hook after",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
    expectBlockReplyCall(onBlockReply, 3, {
      text: "🧹 Compaction complete",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
  });

  it("fires both notifyUser notices alongside onCompactionStart / onCompactionEnd callbacks (#87107)", async () => {
    const onBlockReply = vi.fn();
    const onCompactionStart = vi.fn();
    const onCompactionEnd = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", completed: true },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn(
      {
        followupRun: createNotifyUserRun(),
        opts: { onBlockReply, onCompactionStart, onCompactionEnd },
      },
      { commandBody: "hello" },
    );

    expect(result.kind).toBe("success");
    // Internal callbacks (Control UI etc.) and the user-channel notifyUser
    // notices are independent audiences; both must fire when opted in.
    expect(onCompactionStart).toHaveBeenCalledTimes(1);
    expect(onCompactionEnd).toHaveBeenCalledTimes(1);
    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expectBlockReplyCall(onBlockReply, 0, {
      text: "🧹 Compacting context...",
      isCompactionNotice: true,
    });
    expectBlockReplyCall(onBlockReply, 1, {
      text: "🧹 Compaction complete",
      isCompactionNotice: true,
    });
  });

  it("emits an incomplete compaction notice when compaction ends without completing", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", completed: false },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn(
      { followupRun: createNotifyUserRun(), opts: { onBlockReply } },
      { commandBody: "hello" },
    );

    expect(result.kind).toBe("success");
    expectBlockReplyCall(onBlockReply, 0, {
      text: "🧹 Compacting context...",
      isCompactionNotice: true,
    });
    expectBlockReplyCall(onBlockReply, 1, {
      text: "🧹 Compaction incomplete",
      isCompactionNotice: true,
    });
  });

  it("uses the compaction notice fallback when no block-reply dispatcher is wired", async () => {
    const onCompactionNoticePayload = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", completed: true },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn(
      { followupRun: createNotifyUserRun() },
      { commandBody: "hello", onCompactionNoticePayload },
    );

    expect(result.kind).toBe("success");
    expect(onCompactionNoticePayload).toHaveBeenCalledTimes(2);
    expectBlockReplyCall(onCompactionNoticePayload, 0, {
      text: "🧹 Compacting context...",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
    expectBlockReplyCall(onCompactionNoticePayload, 1, {
      text: "🧹 Compaction complete",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
  });
});
