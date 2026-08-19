// Full-entry coverage for before_agent_reply hook handling before embedded attempts.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

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
} {
  const call = mockedRunEmbeddedAttempt.mock.calls[0] as
    | [
        {
          cleanupBundleMcpOnRunEnd?: boolean;
          disableTrajectory?: boolean;
          modelRun?: boolean;
          promptMode?: string;
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
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetSharedRunIntegrationHarnessMocks();
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
    expect(hookContext?.sessionKey).toBe(overflowBaseRunParams.sessionKey);
    expect(hookContext?.workspaceDir).toBe("/tmp/workspace");
    expect(hookContext?.trigger).toBe("cron");
    expect(hookContext?.senderId).toBeUndefined();
    expect(hookContext?.chatId).toBeUndefined();
    expect(hookContext?.channel).toBeUndefined();
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe("dreaming claimed");
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

  it("forwards one-shot auxiliary-run flags and tool bindings into the embedded attempt", async () => {
    // Auxiliary-run flags are request-scoped; they must pass through to the
    // first attempt without becoming persistent session settings.
    const toolBindings = {
      browser: { kind: "tab", tabId: 7, target: "host", profile: "chrome", targetId: "target-7" },
    };
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "user",
      toolBindings,
      disableTrajectory: true,
      modelRun: true,
      promptMode: "none",
    });

    const attemptParams = firstAttemptParams();
    expect(attemptParams.disableTrajectory).toBe(true);
    expect(attemptParams.modelRun).toBe(true);
    expect(attemptParams.promptMode).toBe("none");
    expect(attemptParams).toMatchObject({ toolBindings });
  });

  it("forwards one-shot bundle MCP cleanup into the embedded attempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      cleanupBundleMcpOnRunEnd: true,
    });

    expect(firstAttemptParams().cleanupBundleMcpOnRunEnd).toBe(true);
  });
});
