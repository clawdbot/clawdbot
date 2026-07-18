/** Tests cron before_agent_reply gating at the CLI runner entrypoint. */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import {
  getAgentEventLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import type { CliOutput } from "./cli-output.js";
import { cliBackendLog } from "./cli-runner/log.js";

// vi.mock factories are hoisted above imports, so any references inside them
// must come from vi.hoisted() so they exist at hoist time (otherwise they'd
// be TDZ-undefined and the mocks would silently misbehave). This test only
// exercises the hook-gate decision at the runCliAgent entry point — we mock
// the prepareCliRunContext + executePreparedCliRun seams so no broader CLI
// runtime needs to load.
type BeforeAgentReplyResult =
  | undefined
  | {
      handled?: boolean;
      reply?: { text?: string };
    };

const {
  hasHooksMock,
  runBeforeAgentReplyMock,
  executePreparedCliRunMock,
  prepareCliRunContextMock,
  closeClaudeLiveSessionForContextMock,
  closeMcpLoopbackServerMock,
} = vi.hoisted(() => ({
  hasHooksMock: vi.fn<(hookName: string) => boolean>(() => false),
  runBeforeAgentReplyMock: vi.fn<(event: unknown, ctx: unknown) => Promise<BeforeAgentReplyResult>>(
    async () => undefined,
  ),
  executePreparedCliRunMock: vi.fn<
    (_context: unknown, _cliSessionIdToUse?: string) => Promise<CliOutput>
  >(async () => ({ text: "" })),
  prepareCliRunContextMock: vi.fn(),
  closeClaudeLiveSessionForContextMock: vi.fn(),
  closeMcpLoopbackServerMock: vi.fn(),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: hasHooksMock,
    runBeforeAgentReply: runBeforeAgentReplyMock,
  })),
}));

vi.mock("./cli-runner/prepare.runtime.js", () => ({
  prepareCliRunContext: prepareCliRunContextMock,
}));

vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: executePreparedCliRunMock,
}));

vi.mock("./cli-runner/claude-live-session.js", () => ({
  closeClaudeLiveSessionForContext: closeClaudeLiveSessionForContextMock,
  getClaudeLiveSessionGenerationForOwner: vi.fn(() => undefined),
  hasClaudeLiveSessionForOwner: vi.fn(() => false),
  shouldUseClaudeLiveSession: vi.fn(() => false),
}));

vi.mock("../gateway/mcp-http.js", () => ({
  closeMcpLoopbackServer: closeMcpLoopbackServerMock,
}));

const baseRunParams = {
  sessionId: "test-session",
  sessionKey: "test-session-key",
  agentId: "main",
  sessionFile: "/tmp/test-session.jsonl",
  workspaceDir: "/tmp/test-workspace",
  prompt: "__openclaw_memory_core_short_term_promotion_dream__",
  provider: "codex-cli",
  model: "gpt-5.5",
  timeoutMs: 30_000,
  runId: "test-run-id",
} as const;

let runCliAgent: typeof import("./cli-runner.js").runCliAgent;

async function captureRejectedClaudeRun(
  params: Parameters<typeof runCliAgent>[0],
): Promise<{ error: unknown; events: DiagnosticEventPayload[] }> {
  const events: DiagnosticEventPayload[] = [];
  const unsubscribe = onTrustedInternalDiagnosticEvent((event) => {
    if ("runId" in event && event.runId === params.runId) {
      events.push(event);
    }
  });
  let error: unknown;
  try {
    await runCliAgent(params);
  } catch (caught) {
    error = caught;
  } finally {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    unsubscribe();
  }
  return { error, events };
}

function makeStubContext(params: typeof baseRunParams & { trigger?: string }) {
  // Stub only the prepared context shape runCliAgent needs after the hook gate.
  return {
    params,
    started: Date.now(),
    workspaceDir: params.workspaceDir,
    modelId: params.model,
    normalizedModel: params.model,
    systemPrompt: "",
    systemPromptReport: {},
    bootstrapPromptWarningLines: [],
    authEpochVersion: 0,
    backendResolved: {},
    preparedBackend: { backend: { sessionMode: "none" } },
    reusableCliSession: { mode: "none" },
  } as unknown;
}

beforeEach(() => {
  hasHooksMock.mockReset();
  hasHooksMock.mockReturnValue(false);
  runBeforeAgentReplyMock.mockReset();
  runBeforeAgentReplyMock.mockResolvedValue(undefined);
  executePreparedCliRunMock.mockReset();
  executePreparedCliRunMock.mockResolvedValue({ text: "" });
  prepareCliRunContextMock.mockReset();
  prepareCliRunContextMock.mockImplementation(async (params) =>
    makeStubContext(params as typeof baseRunParams & { trigger?: string }),
  );
  closeClaudeLiveSessionForContextMock.mockReset();
  closeMcpLoopbackServerMock.mockReset();
});

beforeAll(async () => {
  ({ runCliAgent } = await import("./cli-runner.js"));
});

afterEach(() => {
  vi.clearAllMocks();
  resetDiagnosticEventsForTest();
});

describe("runCliAgent before_agent_reply seam", () => {
  it("adds Claude CLI harness and run ownership at the runner entrypoint", async () => {
    const events: DiagnosticEventPayload[] = [];
    const unsubscribe = onTrustedInternalDiagnosticEvent((event) => {
      if ("runId" in event && event.runId === "claude-entrypoint-run") {
        events.push(event);
      }
    });
    executePreparedCliRunMock.mockResolvedValue({ text: "real Claude reply" });

    let result: Awaited<ReturnType<typeof runCliAgent>> | undefined;
    try {
      result = await runCliAgent({
        ...baseRunParams,
        provider: "claude-cli",
        modelProvider: "anthropic",
        model: "claude-opus-4-7",
        runId: "claude-entrypoint-run",
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      unsubscribe();
    }

    const harnessStarted = events.find((event) => event.type === "harness.run.started");
    const runStarted = events.find((event) => event.type === "run.started");
    expect(events).toHaveLength(4);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "harness.run.started",
        "run.started",
        "run.completed",
        "harness.run.completed",
      ]),
    );
    expect(harnessStarted).toMatchObject({
      harnessId: "claude-cli",
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(runStarted?.trace?.parentSpanId).toBe(harnessStarted?.trace?.spanId);
    expect(result?.diagnosticTrace).toEqual(harnessStarted?.trace);
  });

  it("bypasses Claude CLI diagnostics when no event listener is active", async () => {
    executePreparedCliRunMock.mockResolvedValue({ text: "real Claude reply" });

    const result = await runCliAgent({
      ...baseRunParams,
      provider: "claude-cli",
      modelProvider: "anthropic",
      model: "claude-opus-4-7",
      runId: "claude-no-diagnostics-listener",
    });

    expect(result.diagnosticTrace).toBeUndefined();
    expect(executePreparedCliRunMock).toHaveBeenCalledOnce();
  });

  it("preserves the send phase when execution fails before successful cleanup", async () => {
    executePreparedCliRunMock.mockRejectedValueOnce(new Error("CLI process failed"));

    const { error, events } = await captureRejectedClaudeRun({
      ...baseRunParams,
      provider: "claude-cli",
      modelProvider: "anthropic",
      model: "claude-opus-4-7",
      runId: "claude-send-error",
      cleanupCliLiveSessionOnRunEnd: true,
    });

    expect(error).toMatchObject({ message: "CLI process failed" });
    expect(closeClaudeLiveSessionForContextMock).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.type === "harness.run.error")).toMatchObject({
      type: "harness.run.error",
      phase: "send",
    });
  });

  it("classifies post-execution response validation failures as resolve", async () => {
    executePreparedCliRunMock.mockResolvedValueOnce({ text: "" });

    const { error, events } = await captureRejectedClaudeRun({
      ...baseRunParams,
      provider: "claude-cli",
      modelProvider: "anthropic",
      model: "claude-opus-4-7",
      runId: "claude-resolve-error",
    });

    expect(error).toMatchObject({ message: "CLI backend returned an empty response." });
    expect(events.find((event) => event.type === "harness.run.error")).toMatchObject({
      type: "harness.run.error",
      phase: "resolve",
    });
  });

  it("classifies a surfaced outer cleanup failure as cleanup", async () => {
    executePreparedCliRunMock.mockResolvedValueOnce({ text: "real Claude reply" });
    closeClaudeLiveSessionForContextMock.mockRejectedValueOnce(
      new Error("managed session cleanup failed"),
    );

    const { error, events } = await captureRejectedClaudeRun({
      ...baseRunParams,
      provider: "claude-cli",
      modelProvider: "anthropic",
      model: "claude-opus-4-7",
      runId: "claude-cleanup-error",
      cleanupCliLiveSessionOnRunEnd: true,
    });

    expect(error).toMatchObject({ message: "managed session cleanup failed" });
    expect(events.find((event) => event.type === "harness.run.error")).toMatchObject({
      type: "harness.run.error",
      phase: "cleanup",
    });
  });

  it("rejects stale lifecycle ownership before CLI preparation", async () => {
    await expect(
      runCliAgent({
        ...baseRunParams,
        lifecycleGeneration: "stale-generation",
      }),
    ).rejects.toMatchObject({
      name: "AbortError",
      message: "Agent run belongs to a stale gateway lifecycle",
    });

    expect(prepareCliRunContextMock).not.toHaveBeenCalled();
    expect(executePreparedCliRunMock).not.toHaveBeenCalled();
  });

  it("lets before_agent_reply claim cron runs before the CLI subprocess is invoked", async () => {
    const logInfoSpy = vi.spyOn(cliBackendLog, "info").mockImplementation(() => undefined);
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue({
      handled: true,
      reply: { text: "dreaming claimed via cli runner" },
    });
    const onExecutionPhase = vi.fn();

    try {
      const result = await runCliAgent({
        ...baseRunParams,
        trigger: "cron",
        jobId: "cron-job-123",
        chatId: "native-chat-123",
        onExecutionPhase,
      });

      expect(runBeforeAgentReplyMock).toHaveBeenCalledTimes(1);
      expect(onExecutionPhase).toHaveBeenCalledWith({
        phase: "before_agent_reply",
        provider: baseRunParams.provider,
        model: baseRunParams.model,
      });
      const [event, context] = runBeforeAgentReplyMock.mock.calls.at(0) ?? [];
      expect(event).toEqual({ cleanedBody: baseRunParams.prompt });
      const hookContext = context as Record<string, unknown> | undefined;
      expect(hookContext?.jobId).toBe("cron-job-123");
      expect(hookContext?.agentId).toBe(baseRunParams.agentId);
      expect(hookContext?.sessionId).toBe(baseRunParams.sessionId);
      expect(hookContext?.sessionKey).toBe(baseRunParams.sessionKey);
      expect(hookContext?.workspaceDir).toBe(baseRunParams.workspaceDir);
      expect(hookContext?.trigger).toBe("cron");
      expect(hookContext?.chatId).toBeUndefined();
      expect(hookContext?.channel).toBeUndefined();
      expect(executePreparedCliRunMock).not.toHaveBeenCalled();
      expect(result.payloads?.[0]?.text).toBe("dreaming claimed via cli runner");
      expect(result.meta.agentMeta?.sessionId).toBe("");
      expect(result.meta.agentMeta?.clearCliSessionBinding).toBeUndefined();

      const syntheticTurnLog = logInfoSpy.mock.calls
        .map(([message]) => message)
        .find((message) => message.startsWith("cli synthetic turn:"));
      // Synthetic turn logs prove the branch without leaking hook reply text.
      expect(syntheticTurnLog).toContain("provider=codex-cli");
      expect(syntheticTurnLog).toContain("model=<synthetic>");
      expect(syntheticTurnLog).toContain("requestedModel=gpt-5.5");
      expect(syntheticTurnLog).toContain("outBytes=31 outHash=96317e453543");
      expect(syntheticTurnLog).not.toContain("dreaming claimed via cli runner");
    } finally {
      logInfoSpy.mockRestore();
    }
  });

  it.each(["manual", "memory", "overflow"] as const)(
    "does not expose internal %s runs to before_agent_reply hooks",
    async (trigger) => {
      hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
      executePreparedCliRunMock.mockResolvedValue({ text: "manual result" });

      await runCliAgent({
        ...baseRunParams,
        trigger,
      });

      expect(runBeforeAgentReplyMock).not.toHaveBeenCalled();
      expect(prepareCliRunContextMock).toHaveBeenCalledTimes(1);
      expect(executePreparedCliRunMock).toHaveBeenCalledTimes(1);
    },
  );

  it("clears stateless CLI bindings when before_agent_reply claims a cron turn", async () => {
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue({ handled: true });

    const result = await runCliAgent({
      ...baseRunParams,
      trigger: "cron",
      config: {
        agents: {
          defaults: {
            cliBackends: {
              "codex-cli": {
                command: "codex",
                args: ["exec"],
                output: "text",
                input: "arg",
                sessionMode: "none",
              },
            },
          },
        },
      },
    });

    expect(result.meta.agentMeta?.sessionId).toBe("");
    expect(result.meta.agentMeta?.clearCliSessionBinding).toBe(true);
    expect(prepareCliRunContextMock).not.toHaveBeenCalled();
    expect(executePreparedCliRunMock).not.toHaveBeenCalled();
  });

  it("does not run prepareCliRunContext when the cron hook claims (no resource allocation, no leak)", async () => {
    // Regression for PR #70950 review (greptile-apps, P1): the gate must fire
    // before any backend resources are allocated, otherwise preparedBackend.cleanup
    // is silently skipped on every claimed cron turn.
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue({ handled: true });

    await runCliAgent({ ...baseRunParams, trigger: "cron", jobId: "cron-job-123" });

    expect(prepareCliRunContextMock).not.toHaveBeenCalled();
    expect(executePreparedCliRunMock).not.toHaveBeenCalled();
  });

  it("re-arms setup progress when a cron hook does not claim", async () => {
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue(undefined);
    executePreparedCliRunMock.mockResolvedValue({ text: "real reply" });
    const onExecutionPhase = vi.fn();

    await runCliAgent({
      ...baseRunParams,
      trigger: "cron",
      jobId: "cron-job-123",
      onExecutionPhase,
    });

    expect(onExecutionPhase).toHaveBeenCalledWith({
      phase: "before_agent_reply",
      provider: baseRunParams.provider,
      model: baseRunParams.model,
    });
    expect(onExecutionPhase).toHaveBeenCalledWith({
      phase: "runtime_plugins",
      provider: baseRunParams.provider,
      model: baseRunParams.model,
    });
    expect(prepareCliRunContextMock).toHaveBeenCalledTimes(1);
    expect(executePreparedCliRunMock).toHaveBeenCalledTimes(1);
  });

  it("treats empty CLI subprocess output as a failover failure, not a green cron run", async () => {
    executePreparedCliRunMock.mockResolvedValue({ text: "   " });

    await expect(runCliAgent({ ...baseRunParams, trigger: "cron" })).rejects.toMatchObject({
      name: "FailoverError",
      reason: "empty_response",
      provider: baseRunParams.provider,
      model: baseRunParams.model,
      sessionId: baseRunParams.sessionId,
    });
  });

  it("returns a silent payload when a cron hook claims without a reply body", async () => {
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue({ handled: true });

    const result = await runCliAgent({ ...baseRunParams, trigger: "cron", jobId: "cron-job-123" });

    expect(executePreparedCliRunMock).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe(SILENT_REPLY_TOKEN);
  });

  it("lets before_agent_reply claim user runs before CLI preparation", async () => {
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue({
      handled: true,
      reply: { text: "user turn claimed" },
    });

    const result = await runCliAgent({ ...baseRunParams, trigger: "user" });

    expect(runBeforeAgentReplyMock).toHaveBeenCalledTimes(1);
    const [, hookContext] = runBeforeAgentReplyMock.mock.calls.at(0) ?? [];
    expect(hookContext).toMatchObject({ trigger: "user" });
    expect(prepareCliRunContextMock).not.toHaveBeenCalled();
    expect(executePreparedCliRunMock).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe("user turn claimed");
  });

  it("lets before_agent_reply claim heartbeat runs before CLI preparation", async () => {
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue({
      handled: true,
      reply: { text: "heartbeat claimed" },
    });

    const result = await runCliAgent({ ...baseRunParams, trigger: "heartbeat" });

    expect(runBeforeAgentReplyMock).toHaveBeenCalledTimes(1);
    const [, hookContext] = runBeforeAgentReplyMock.mock.calls.at(0) ?? [];
    expect(hookContext).toMatchObject({ trigger: "heartbeat" });
    expect(prepareCliRunContextMock).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe("heartbeat claimed");
  });

  it("dispatches a declining hook once when model fallback re-enters the CLI runner", async () => {
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue(undefined);
    executePreparedCliRunMock.mockResolvedValue({ text: "real reply" });
    const onExecutionPhase = vi.fn();

    await withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), async () => {
      await runCliAgent({ ...baseRunParams, trigger: "user", onExecutionPhase });
      await runCliAgent({
        ...baseRunParams,
        trigger: "user",
        model: "fallback-model",
        onExecutionPhase,
      });
    });

    expect(runBeforeAgentReplyMock).toHaveBeenCalledTimes(1);
    expect(
      onExecutionPhase.mock.calls.filter(([event]) => event.phase === "before_agent_reply"),
    ).toHaveLength(1);
    expect(prepareCliRunContextMock).toHaveBeenCalledTimes(2);
    expect(executePreparedCliRunMock).toHaveBeenCalledTimes(2);
  });

  it("falls through to the CLI subprocess when no before_agent_reply hook is registered", async () => {
    hasHooksMock.mockReturnValue(false);
    executePreparedCliRunMock.mockResolvedValue({ text: "real reply" });

    await runCliAgent({ ...baseRunParams, trigger: "cron" });

    expect(runBeforeAgentReplyMock).not.toHaveBeenCalled();
    expect(executePreparedCliRunMock).toHaveBeenCalledTimes(1);
  });

  it("reports confirmed CLI messaging delivery evidence without leaking it to later invocations", async () => {
    executePreparedCliRunMock.mockResolvedValueOnce({
      text: "sent",
      didSendViaMessagingTool: true,
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "telegram",
          to: "chat123",
        },
      ],
    });
    executePreparedCliRunMock.mockResolvedValueOnce({ text: "later" });

    const firstResult = await runCliAgent(baseRunParams);
    expect(firstResult.didSendViaMessagingTool).toBe(true);
    expect(firstResult.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat123",
      }),
    ]);

    const laterResult = await runCliAgent(baseRunParams);
    expect(laterResult.didSendViaMessagingTool).toBeUndefined();
    expect(laterResult.messagingToolSentTargets).toBeUndefined();
  });

  it("can close temporary CLI live sessions after a run", async () => {
    executePreparedCliRunMock.mockResolvedValue({ text: "real reply" });

    await runCliAgent({ ...baseRunParams, cleanupCliLiveSessionOnRunEnd: true });

    expect(executePreparedCliRunMock).toHaveBeenCalledTimes(1);
    expect(closeClaudeLiveSessionForContextMock).toHaveBeenCalledTimes(1);
    expect(closeClaudeLiveSessionForContextMock).toHaveBeenCalledWith(
      await expectDefined(
        prepareCliRunContextMock.mock.results[0],
        "prepareCliRunContextMock.mock.results[0] test invariant",
      ).value,
    );
  });

  it("can close temporary bundle MCP loopback resources after a run", async () => {
    executePreparedCliRunMock.mockResolvedValue({ text: "real reply" });

    await runCliAgent({ ...baseRunParams, cleanupBundleMcpOnRunEnd: true });

    expect(executePreparedCliRunMock).toHaveBeenCalledTimes(1);
    expect(closeMcpLoopbackServerMock).toHaveBeenCalledTimes(1);
  });

  it("preserves confirmed delivery when bundle MCP cleanup fails", async () => {
    executePreparedCliRunMock.mockResolvedValue({
      text: "",
      didSendViaMessagingTool: true,
    });
    closeMcpLoopbackServerMock.mockRejectedValue(new Error("loopback cleanup failed"));

    await expect(
      runCliAgent({ ...baseRunParams, cleanupBundleMcpOnRunEnd: true }),
    ).resolves.toMatchObject({
      didSendViaMessagingTool: true,
    });
  });

  it("surfaces bundle MCP cleanup failures when nothing was delivered", async () => {
    executePreparedCliRunMock.mockResolvedValue({ text: "real reply" });
    closeMcpLoopbackServerMock.mockRejectedValue(new Error("loopback cleanup failed"));

    await expect(runCliAgent({ ...baseRunParams, cleanupBundleMcpOnRunEnd: true })).rejects.toThrow(
      "loopback cleanup failed",
    );
  });
});
