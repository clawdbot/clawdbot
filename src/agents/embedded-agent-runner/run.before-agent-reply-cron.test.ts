// Coverage for before_agent_reply hook handling before embedded attempts.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

function firstBeforeAgentReplyCall() {
  // Helper keeps assertions on the hook payload and context close to the tests
  // without leaking mock tuple details into every case.
  const call = mockedGlobalHookRunner.runBeforeAgentReply.mock.calls[0];
  if (!call) {
    throw new Error("expected before_agent_reply hook call");
  }
  return call;
}

function firstAttemptParams(): {
  cleanupBundleMcpOnRunEnd?: boolean;
  disableTrajectory?: boolean;
  modelRun?: boolean;
  promptMode?: string;
  promptCacheKey?: string;
  suppressLiveStreamOutput?: boolean;
} {
  const call = mockedRunEmbeddedAttempt.mock.calls[0] as
    | [
        {
          cleanupBundleMcpOnRunEnd?: boolean;
          disableTrajectory?: boolean;
          modelRun?: boolean;
          promptMode?: string;
          promptCacheKey?: string;
          suppressLiveStreamOutput?: boolean;
        },
      ]
    | undefined;
  if (!call) {
    throw new Error("expected embedded attempt call");
  }
  return call[0];
}

describe("runEmbeddedAgent before_agent_reply seam", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  it("lets before_agent_reply claim cron runs before the embedded attempt starts", async () => {
    // Cron hooks can fully handle maintenance prompts before the model is
    // invoked, which avoids unnecessary prompt-cache and setup work.
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "dreaming claimed" },
    });
    const onExecutionPhase = vi.fn();

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
      jobId: "cron-job-123",
      prompt: "__openclaw_memory_core_short_term_promotion_dream__",
      onExecutionPhase,
    });

    expect(mockedGlobalHookRunner.runBeforeAgentReply).toHaveBeenCalledTimes(1);
    expect(onExecutionPhase).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "before_agent_reply" }),
    );
    const [hookPayload, hookContext] = firstBeforeAgentReplyCall();
    expect(hookPayload).toEqual({
      cleanedBody: "__openclaw_memory_core_short_term_promotion_dream__",
    });
    expect(hookContext?.jobId).toBe("cron-job-123");
    expect(hookContext?.agentId).toBe("main");
    expect(hookContext?.sessionId).toBe("test-session");
    expect(hookContext?.sessionKey).toBe("test-key");
    expect(hookContext?.workspaceDir).toBe("/tmp/workspace");
    expect(hookContext?.trigger).toBe("cron");
    expect(hookContext?.senderId).toBeUndefined();
    expect(hookContext?.chatId).toBeUndefined();
    expect(hookContext?.channel).toBeUndefined();
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe("dreaming claimed");
  });

  it("returns a silent payload when a cron hook claims without a reply body", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({
      handled: true,
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
    });

    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe(SILENT_REPLY_TOKEN);
  });

  it("re-arms setup progress when a cron hook does not claim", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue(undefined);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());
    const onExecutionPhase = vi.fn();

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
      onExecutionPhase,
    });

    expect(onExecutionPhase).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "before_agent_reply" }),
    );
    expect(onExecutionPhase).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "runtime_plugins" }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("lets before_agent_reply claim user runs before the embedded attempt starts", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: {
        text: "user turn claimed",
        channelData: { testPayload: true },
        sensitiveMedia: true,
        videoAsNote: true,
      },
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "user",
    });

    expect(mockedGlobalHookRunner.runBeforeAgentReply).toHaveBeenCalledTimes(1);
    const [, hookContext] = firstBeforeAgentReplyCall();
    expect(hookContext?.trigger).toBe("user");
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    expect(result.payloads?.[0]).toMatchObject({
      text: "user turn claimed",
      channelData: { testPayload: true },
      sensitiveMedia: true,
      videoAsNote: true,
    });
  });

  it("lets before_agent_reply claim heartbeat runs before the embedded attempt starts", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "heartbeat claimed" },
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "heartbeat",
    });

    expect(mockedGlobalHookRunner.runBeforeAgentReply).toHaveBeenCalledTimes(1);
    const [, hookContext] = firstBeforeAgentReplyCall();
    expect(hookContext?.trigger).toBe("heartbeat");
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe("heartbeat claimed");
  });

  it("preserves native user identity in the before_agent_reply context", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({ handled: true });

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "user",
      senderId: "sender-123",
      chatId: "chat-456",
      channelContext: { sender: { id: "sender-123" }, chat: { id: "chat-456" } },
    });

    const [, hookContext] = firstBeforeAgentReplyCall();
    expect(hookContext).toEqual(
      expect.objectContaining({
        senderId: "sender-123",
        chatId: "chat-456",
        channelContext: expect.objectContaining({
          sender: { id: "sender-123" },
          chat: { id: "chat-456" },
        }),
      }),
    );
  });

  it.each(["manual", "memory", "overflow"] as const)(
    "does not expose internal %s runs to before_agent_reply hooks",
    async (trigger) => {
      mockedGlobalHookRunner.hasHooks.mockImplementation(
        (hookName: string) => hookName === "before_agent_reply",
      );
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());

      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        trigger,
      });

      expect(mockedGlobalHookRunner.runBeforeAgentReply).not.toHaveBeenCalled();
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    },
  );

  it("forwards one-shot auxiliary-run flags into the embedded attempt", async () => {
    // Auxiliary-run flags are request-scoped; they must pass through to the
    // first attempt without becoming persistent session settings.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "user",
      disableTrajectory: true,
      modelRun: true,
      promptMode: "none",
    });

    const attemptParams = firstAttemptParams();
    expect(attemptParams.disableTrajectory).toBe(true);
    expect(attemptParams.modelRun).toBe(true);
    expect(attemptParams.promptMode).toBe("none");
  });

  it("forwards one-shot bundle MCP cleanup into the embedded attempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      cleanupBundleMcpOnRunEnd: true,
    });

    expect(firstAttemptParams().cleanupBundleMcpOnRunEnd).toBe(true);
  });

  it("forwards prompt cache identity into the embedded attempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      promptCacheKey: "cron-cache-key",
    });

    expect(firstAttemptParams().promptCacheKey).toBe("cron-cache-key");
  });

  it("forwards suppressed live stream output into the embedded attempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      suppressLiveStreamOutput: true,
    });

    expect(firstAttemptParams().suppressLiveStreamOutput).toBe(true);
  });
});
