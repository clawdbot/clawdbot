import { describe, expect, it, vi } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import { CommandLaneClearedError, GatewayDrainingError } from "../../process/command-queue.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions } from "../types.js";
import {
  setupAgentRunnerExecutionTestState,
  GENERIC_RUN_FAILURE_TEXT,
  getRunAgentTurnWithFallback,
  createMockTypingSignaler,
  createFollowupRun,
  createMockReplyOperation,
  requireRecord,
  expectRecordFields,
  requireMockCall,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import { HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT } from "./agent-runner-failure-copy.js";
import { buildKnownAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";

const state = setupAgentRunnerExecutionTestState();

describe("runAgentTurnWithFallback: terminal failures", () => {
  it("surfaces billing guidance for mixed-cause fallback exhaustion", async () => {
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "All models failed (2): anthropic/claude: 429 (rate_limit) | openai/gpt-5.4: 402 (billing)",
        ),
        {
          name: "FallbackSummaryError",
          attempts: [
            { provider: "anthropic", model: "claude", error: "429", reason: "rate_limit" },
            { provider: "openai", model: "gpt-5.4", error: "402", reason: "billing" },
          ],
          soonestCooldownExpiry: Date.now() + 60_000,
        },
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe("billing");
      expect(result.payload.text).not.toContain("All models failed");
      expect(result.payload.text).not.toContain("402 (billing)");
      expect(result.payload.text).not.toContain("Rate-limited");
    }
  });

  it("surfaces Codex usage-limit reset details for pure fallback exhaustion", async () => {
    const codexMessage =
      "You've reached your Codex subscription usage limit. Next reset in 42 minutes (2026-05-04T21:34:00.000Z). Run /codex account for current usage details.";
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      Object.assign(new Error(`All models failed (1): openai/gpt-5.5: ${codexMessage}`), {
        name: "FallbackSummaryError",
        attempts: [
          {
            provider: "openai",
            model: "gpt-5.5",
            error: codexMessage,
            reason: "rate_limit",
          },
        ],
        soonestCooldownExpiry: null,
      }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "telegram",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(`⚠️ ${codexMessage}`);
      expect(result.payload.text).not.toContain("All models failed");
      expectRecordFields(requireRecord(getReplyPayloadMetadata(result.payload), "reply metadata"), {
        deliverDespiteSourceReplySuppression: true,
      });
    }
  });

  it("surfaces direct Codex usage-limit errors when fallback does not wrap one attempt", async () => {
    const codexMessage =
      "You've reached your Codex subscription usage limit. Codex did not return a reset time for this limit. Run /codex account for current usage details.";
    state.runWithModelFallbackMock.mockRejectedValueOnce(new Error(codexMessage));

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "telegram",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(`⚠️ ${codexMessage}`);
      expectRecordFields(requireRecord(getReplyPayloadMetadata(result.payload), "reply metadata"), {
        deliverDespiteSourceReplySuppression: true,
      });
    }
  });

  it("surfaces billing guidance for pure billing cooldown fallback exhaustion", async () => {
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "All models failed (2): anthropic/claude-opus-4-6: Provider anthropic has billing issue (skipping all models) (billing) | anthropic/claude-sonnet-4-6: Provider anthropic has billing issue (skipping all models) (billing)",
        ),
        {
          name: "FallbackSummaryError",
          attempts: [
            {
              provider: "anthropic",
              model: "claude-opus-4-6",
              error: "Provider anthropic has billing issue (skipping all models)",
              reason: "billing",
            },
            {
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              error: "Provider anthropic has billing issue (skipping all models)",
              reason: "billing",
            },
          ],
          soonestCooldownExpiry: Date.now() + 60_000,
        },
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe("billing");
    }
  });

  it("surfaces restart text when fallback exhaustion wraps a drain error, keeping fail bookkeeping", async () => {
    const { replyOperation, failMock } = createMockReplyOperation();
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      Object.assign(new Error("fallback exhausted"), {
        name: "FallbackSummaryError",
        attempts: [
          {
            provider: "anthropic",
            model: "claude",
            error: new GatewayDrainingError(),
          },
        ],
        soonestCooldownExpiry: null,
        cause: new GatewayDrainingError(),
      }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      replyOperation,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
      );
    }
    const failCall = requireMockCall(failMock, 0, "reply operation fail");
    expect(failCall[0]).toBe("gateway_draining");
    expect(failCall[1]).toBeInstanceOf(GatewayDrainingError);
  });

  it("surfaces restart text when fallback exhaustion wraps a cleared lane error, keeping fail bookkeeping", async () => {
    const { replyOperation, failMock } = createMockReplyOperation();
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      Object.assign(new Error("fallback exhausted"), {
        name: "FallbackSummaryError",
        attempts: [
          {
            provider: "anthropic",
            model: "claude",
            error: new CommandLaneClearedError("session:main"),
          },
        ],
        soonestCooldownExpiry: null,
        cause: new CommandLaneClearedError("session:main"),
      }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      replyOperation,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
      );
    }
    const failCall = requireMockCall(failMock, 0, "reply operation fail");
    expect(failCall[0]).toBe("command_lane_cleared");
    expect(failCall[1]).toBeInstanceOf(CommandLaneClearedError);
  });

  it("stays silent (NO_REPLY) when the reply operation was aborted for restart", async () => {
    const agentEvents = await import("../../infra/agent-events.js");
    const emitAgentEvent = vi.mocked(agentEvents.emitAgentEvent);
    const { replyOperation, failMock } = createMockReplyOperation();
    Object.defineProperty(replyOperation, "result", {
      value: { kind: "aborted", code: "aborted_for_restart" } as const,
      configurable: true,
    });
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      replyOperation,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
      isRestartRecoveryArmed: () => true,
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(SILENT_REPLY_TOKEN);
    }
    expect(failMock).not.toHaveBeenCalled();
    expect(
      emitAgentEvent.mock.calls.some(
        ([event]) =>
          event.stream === "lifecycle" &&
          event.data.phase === "end" &&
          event.data.aborted === true &&
          event.data.stopReason === "restart",
      ),
    ).toBe(true);
  });

  it("preserves restart ownership when an aborted embedded runner resolves normally", async () => {
    const agentEvents = await import("../../infra/agent-events.js");
    const emitAgentEvent = vi.mocked(agentEvents.emitAgentEvent);
    const { replyOperation } = createMockReplyOperation();
    Object.defineProperty(replyOperation, "result", {
      value: { kind: "aborted", code: "aborted_for_restart" } as const,
      configurable: true,
    });
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      replyOperation,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
      isRestartRecoveryArmed: () => true,
    });

    expect(result).toEqual({
      kind: "final",
      payload: expect.objectContaining({
        text: SILENT_REPLY_TOKEN,
      }),
    });
    expect(
      emitAgentEvent.mock.calls.some(
        ([event]) =>
          event.stream === "lifecycle" &&
          event.data.phase === "end" &&
          event.data.aborted === true &&
          event.data.stopReason === "restart",
      ),
    ).toBe(true);
  });

  it("uses compact generic copy for raw external chat errors when verbose is off", async () => {
    const agentEvents = await import("../../infra/agent-events.js");
    const emitAgentEvent = vi.mocked(agentEvents.emitAgentEvent);
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error("INVALID_ARGUMENT: some other failure"),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { runId: "run-provider-failure" } as GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(GENERIC_RUN_FAILURE_TEXT);
    }
    const terminalFailureEvent = emitAgentEvent.mock.calls
      .map((call) => call[0])
      .find((event) => {
        if (!event || typeof event !== "object") {
          return false;
        }
        const data = (event as { data?: Record<string, unknown> }).data;
        return (
          (event as { runId?: unknown }).runId === "run-provider-failure" &&
          (event as { stream?: unknown }).stream === "lifecycle" &&
          data?.phase === "error" &&
          data.fallbackExhaustedFailure === true
        );
      });
    expect(terminalFailureEvent).toBeDefined();
  });

  it("surfaces CLI max-turn recovery context at normal verbosity", async () => {
    const recoveryText =
      "Claude CLI stopped after reaching the maximum number of turns (limit: 1). " +
      "OpenClaw run: run-max-turns. OpenClaw session: session-1. Claude session: claude-session-1. " +
      "Tool actions may already have run; verify their effects before retrying. " +
      "Retry with a higher --max-turns value or a narrower task.";
    const maxTurns = new FailoverError(recoveryText, {
      reason: "unknown",
      code: "cli_max_turns",
      provider: "claude-cli",
      model: "sonnet",
    });
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new AggregateError(
        [maxTurns, new Error("fork successor persistence failed")],
        "CLI turn failed and its fork successor could not be persisted",
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.isError).toBe(true);
      expect(result.payload.text).toBe(recoveryText);
      expect(result.payload.text).not.toBe(GENERIC_RUN_FAILURE_TEXT);
    }
  });

  it("uses heartbeat failure copy for raw external errors during heartbeat runs", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error('Command lane "main" task timed out after 120000ms'),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams(),
      isHeartbeat: true,
    });

    expect(result.kind).toBe("final");
    if (result.kind !== "final") {
      throw new Error("expected final reply");
    }
    expect(result.payload.text).toBe(HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT);
    expect(result.payload.text).not.toBe(GENERIC_RUN_FAILURE_TEXT);
    expect(result.payload.text).not.toContain("/new");
  });

  it.each([
    {
      rejection: new Error("CLI exceeded timeout (300s) and was terminated."),
      mode: "overall" as const,
      routingSubstring: undefined as string | undefined,
    },
    {
      rejection: new Error("CLI produced no output for 120s and was terminated."),
      mode: "no-output" as const,
      routingSubstring: undefined,
    },
    {
      rejection: new Error(
        "All models failed (2): anthropic/claude-opus-4-7: CLI exceeded timeout (300s) and was terminated. | anthropic/foo: bar",
      ),
      mode: "overall" as const,
      routingSubstring: "(routing anthropic/claude-opus-4-7)",
    },
    {
      rejection: new Error("codex-cli/gpt-5.5: CLI exceeded timeout (60s) and was terminated."),
      mode: "overall" as const,
      routingSubstring: "(routing codex-cli/gpt-5.5)",
    },
  ])(
    "surfaces CLI subprocess timeout copy instead of generic failure when verbose is off ($mode)",
    async ({ rejection, mode, routingSubstring }) => {
      state.runWithModelFallbackMock.mockRejectedValueOnce(rejection);

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback({
        ...createMinimalRunAgentTurnParams(),
      });

      expect(result.kind).toBe("final");
      if (result.kind !== "final") {
        throw new Error("expected final reply");
      }
      expect(result.payload.text).not.toBe(GENERIC_RUN_FAILURE_TEXT);
      expect(result.payload.text).not.toContain("Claude CLI");
      expect(result.payload.text).toContain("gateway is unaffected");
      if (mode === "overall") {
        expect(result.payload.text).toContain("overall turn limit");
        expect(result.payload.text).toContain("detached OpenClaw sub-agent");
        expect(result.payload.text).toContain("agents.defaults.timeoutSeconds");
        expect(result.payload.text).not.toContain("noOutputTimeoutMs");
      } else {
        expect(result.payload.text).toContain("CLI subprocess");
        expect(result.payload.text).toContain("no-output watchdog");
        expect(result.payload.text).toContain("separate from the overall agent timeout");
        expect(result.payload.text).toContain(
          "agents.defaults.cliBackends.<id>.reliability.watchdog.{fresh,resume}.noOutputTimeoutMs",
        );
        expect(result.payload.text).not.toContain("agents.defaults.timeoutSeconds");
      }
      expect(result.payload.text).not.toContain("/new");
      if (routingSubstring) {
        expect(result.payload.text).toContain(routingSubstring);
      }
    },
  );

  it("explains that CLI background tasks share the timed-out parent process", () => {
    const payload = buildKnownAgentRunFailureReplyPayload({
      err: new FailoverError("CLI exceeded timeout (600s) and was terminated.", {
        reason: "timeout",
        provider: "claude-cli",
        code: "cli_overall_timeout",
        cliTimeout: {
          mode: "overall",
          timeoutSeconds: 600,
          observedActivity: true,
          activeToolCount: 1,
          backgroundTaskCount: 1,
        },
      }),
      sessionCtx: createMinimalRunAgentTurnParams().sessionCtx,
      resolvedVerboseLevel: "off",
    });

    expect(payload?.text).toContain("1 CLI background task");
    expect(payload?.text).toContain("1 active CLI tool call");
    expect(payload?.text).toContain("shares the parent CLI process");
    expect(payload?.text).toContain("Effects may be partial");
    expect(payload?.text).toContain("no run timeout by default");
  });

  it.each([
    {
      rejection: new Error("codex app-server client closed before turn completed"),
      expected: "connection closed",
    },
    {
      rejection: new Error("codex app-server turn idle timed out waiting for turn/completed"),
      expected: "did not replay the turn automatically",
    },
  ])(
    "surfaces Codex app-server bridge failures instead of generic copy",
    async ({ rejection, expected }) => {
      state.runWithModelFallbackMock.mockRejectedValueOnce(rejection);

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback({
        ...createMinimalRunAgentTurnParams(),
      });

      expect(result.kind).toBe("final");
      if (result.kind !== "final") {
        throw new Error("expected final reply");
      }
      expect(result.payload.text).not.toBe(GENERIC_RUN_FAILURE_TEXT);
      expect(result.payload.text).toContain("Codex app-server");
      expect(result.payload.text).toContain(expected);
    },
  );

  it("forwards sanitized generic errors on external chat channels when verbose is on", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error("INVALID_ARGUMENT: some other failure"),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "on",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Agent failed before reply: INVALID_ARGUMENT: some other failure. Please try again, or use /new to start a fresh session.",
      );
    }
  });
});
