import { describe, expect, it, vi } from "vitest";
import { formatBillingErrorMessage } from "../../agents/embedded-agent-helpers.js";
import { resolveMaxRunRetryIterations } from "../../agents/embedded-agent-runner/run/helpers.js";
import { FailoverError } from "../../agents/failover-error.js";
import { BILLING_ERROR_USER_MESSAGE } from "../../agents/failover/user-copy.js";
import { ProviderAuthError } from "../../agents/model-auth.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE,
  PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE,
  PROVIDER_INTERNAL_ERROR_USER_MESSAGE,
  setupAgentRunnerExecutionTestState,
  GENERIC_RUN_FAILURE_TEXT,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  createMockReplyOperation,
  createMinimalRunAgentTurnParams,
  NON_DIRECT_FAILURE_SURFACE_CASES,
  createNonDirectFailureSessionCtx,
  type EmbeddedAgentParams,
  type FallbackRunnerParams,
  createTestFallbackSummaryError,
} from "./agent-runner-execution.test-support.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { buildKnownAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";

const state = setupAgentRunnerExecutionTestState();

async function executeTestTurn(
  params?: Parameters<typeof createMinimalRunAgentTurnParams>[0],
  overrides?: Partial<AgentTurnParams>,
) {
  const executeAgentTurn = await getExecuteAgentTurnForTest();
  return executeAgentTurn({ ...createMinimalRunAgentTurnParams(params), ...overrides });
}

function createDirectFailureSessionCtx(provider: "discord" | "telegram" = "discord") {
  return {
    Provider: provider,
    Surface: provider,
    ChatType: "direct",
    MessageSid: "msg",
  } as unknown as TemplateContext;
}

function createOverloadSummaryError() {
  return createTestFallbackSummaryError({
    message: "All models failed (1): anthropic/claude-opus-4-1: overloaded",
    attempts: [
      {
        provider: "anthropic",
        model: "claude-opus-4-1",
        error: "overloaded",
        reason: "overloaded",
        status: 529,
      },
    ],
    soonestCooldownExpiry: null,
  });
}

const OPENAI_SERVICE_UNAVAILABLE_MESSAGE =
  "unexpected status 503 Service Unavailable: Service Unavailable, url: https://chatgpt.com/backend-api/codex/responses, cf-ray: qa-test-AMS, auth error: 503, auth error code: biscuit_baker_service_me_circuit_open";

function createOpenAiServiceUnavailableError() {
  return new FailoverError("LLM request timed out.", {
    reason: "timeout",
    provider: "openai",
    model: "gpt-5.6",
    status: 408,
    rawError: OPENAI_SERVICE_UNAVAILABLE_MESSAGE,
  });
}

describe("executeAgentTurn: provider failures", () => {
  it.each(NON_DIRECT_FAILURE_SURFACE_CASES)(
    "keeps raw runner failure boilerplate out of $label chats",
    async (testCase) => {
      state.runEmbeddedAgentMock.mockRejectedValueOnce(
        new Error("openai/gpt-5.5 ended with an incomplete terminal response"),
      );

      const result = await executeTestTurn({
        sessionCtx: createNonDirectFailureSessionCtx(testCase),
      });

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.text).toBe(SILENT_REPLY_TOKEN);
      }
    },
  );

  it.each(["group", "channel"] as const)(
    "surfaces raw runner failure copy in Discord %s chats when silentReply.group is set to disallow",
    async (chatType) => {
      state.runEmbeddedAgentMock.mockRejectedValueOnce(
        new Error("openai/gpt-5.5 ended with an incomplete terminal response"),
      );

      const followupRun = createFollowupRun();
      followupRun.run.config = {
        agents: {
          defaults: {
            silentReply: { group: "disallow" },
          },
        },
      };

      const result = await executeTestTurn({
        followupRun,
        sessionCtx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: chatType,
          GroupSubject: "agent group",
          GroupChannel: "#general",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      });

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.text).not.toBe(SILENT_REPLY_TOKEN);
        expect(result.payload.text).toBe(GENERIC_RUN_FAILURE_TEXT);
      }
    },
  );

  it("surfaces raw runner failure copy when per-surface silentReply.group is set to disallow", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error("openai/gpt-5.5 ended with an incomplete terminal response"),
    );

    const followupRun = createFollowupRun();
    followupRun.run.config = {
      agents: {
        defaults: {
          silentReply: { group: "allow" },
        },
      },
      surfaces: {
        discord: {
          silentReply: { group: "disallow" },
        },
      },
    };

    const result = await executeTestTurn({
      followupRun,
      sessionCtx: {
        Provider: "discord",
        Surface: "discord",
        ChatType: "group",
        GroupSubject: "agent group",
        GroupChannel: "#general",
        MessageSid: "msg",
      } as unknown as TemplateContext,
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(GENERIC_RUN_FAILURE_TEXT);
    }
  });

  it.each(NON_DIRECT_FAILURE_SURFACE_CASES)(
    "keeps default silent behavior in $label chats when silentReply policy is unset",
    async (testCase) => {
      state.runEmbeddedAgentMock.mockRejectedValueOnce(
        new Error("openai/gpt-5.5 ended with an incomplete terminal response"),
      );

      const followupRun = createFollowupRun();
      followupRun.run.config = {};

      const result = await executeTestTurn({
        followupRun,
        sessionCtx: createNonDirectFailureSessionCtx(testCase),
      });

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.text).toBe(SILENT_REPLY_TOKEN);
      }
    },
  );

  it.each(NON_DIRECT_FAILURE_SURFACE_CASES)(
    "keeps classified non-transient failures visible in $label chats",
    async (testCase) => {
      state.runEmbeddedAgentMock.mockRejectedValueOnce(
        new ProviderAuthError(
          "missing-provider-auth",
          "openai",
          'No API key found for provider "openai"',
        ),
      );

      const result = await executeTestTurn({
        sessionCtx: createNonDirectFailureSessionCtx(testCase),
      });

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.text).not.toBe(SILENT_REPLY_TOKEN);
        expect(result.payload.text).toContain('Missing API key for provider "openai"');
      }
    },
  );

  it.each(["group", "channel"] as const)(
    "surfaces provider HTTP 503 failures in Discord %s chats without replaying after tool execution",
    async (chatType) => {
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        params.onExecutionPhase?.({ phase: "tool_execution_started", tool: "exec" });
        throw createOpenAiServiceUnavailableError();
      });

      const result = await executeTestTurn({
        sessionCtx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: chatType,
          GroupSubject: "agent group",
          GroupChannel: "#general",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      });

      expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.isError).toBe(true);
        expect(result.payload.text).toBe(PROVIDER_INTERNAL_ERROR_USER_MESSAGE);
        expect(result.payload.text).not.toBe(SILENT_REPLY_TOKEN);
        expect(result.payload.text).not.toContain(OPENAI_SERVICE_UNAVAILABLE_MESSAGE);
        expect(getReplyPayloadMetadata(result.payload)).toMatchObject({
          deliverDespiteSourceReplySuppression: true,
        });
      }
    },
  );

  it("retries a provider HTTP 503 before output and delivers the recovered response", async () => {
    vi.useFakeTimers();
    state.runEmbeddedAgentMock
      .mockRejectedValueOnce(createOpenAiServiceUnavailableError())
      .mockResolvedValueOnce({
        payloads: [{ text: "Recovered response" }],
        meta: {},
      });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const resultPromise = executeAgentTurn(
      createMinimalRunAgentTurnParams({
        sessionCtx: createNonDirectFailureSessionCtx(NON_DIRECT_FAILURE_SURFACE_CASES[0]),
      }),
    );
    await vi.advanceTimersByTimeAsync(2_500);
    const result = await resultPromise;

    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.runResult.payloads).toEqual([{ text: "Recovered response" }]);
    }
  });

  it("surfaces a sanitized provider HTTP 503 notice after the safe retry is exhausted", async () => {
    vi.useFakeTimers();
    state.runEmbeddedAgentMock.mockRejectedValue(createOpenAiServiceUnavailableError());

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const resultPromise = executeAgentTurn(
      createMinimalRunAgentTurnParams({
        sessionCtx: createNonDirectFailureSessionCtx(NON_DIRECT_FAILURE_SURFACE_CASES[1]),
      }),
    );
    await vi.advanceTimersByTimeAsync(2_500);
    const result = await resultPromise;

    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.isError).toBe(true);
      expect(result.payload.text).toBe(PROVIDER_INTERNAL_ERROR_USER_MESSAGE);
      expect(result.payload.text).not.toContain(OPENAI_SERVICE_UNAVAILABLE_MESSAGE);
    }
  });

  it.each(NON_DIRECT_FAILURE_SURFACE_CASES)(
    "surfaces provider authentication failures in $label chats",
    async (testCase) => {
      const rawError =
        "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses";
      state.runEmbeddedAgentMock.mockRejectedValueOnce(
        new FailoverError("LLM request unauthorized.", {
          reason: "auth",
          provider: "openai",
          model: "gpt-5.5",
          status: 401,
          rawError,
        }),
      );

      const result = await executeTestTurn({
        sessionCtx: createNonDirectFailureSessionCtx(testCase),
      });

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.isError).toBe(true);
        expect(result.payload.text).toBe(PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE);
        expect(result.payload.text).not.toBe(SILENT_REPLY_TOKEN);
        expect(result.payload.text).not.toContain(rawError);
      }
    },
  );

  it.each(NON_DIRECT_FAILURE_SURFACE_CASES)(
    "surfaces rate-limit fallback copy in $label chats",
    async (testCase) => {
      state.runEmbeddedAgentMock.mockRejectedValueOnce(new Error("429 rate limit exceeded"));

      const result = await executeTestTurn({
        sessionCtx: createNonDirectFailureSessionCtx(testCase),
      });

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.isError).toBe(true);
        expect(result.payload.text).not.toBe(SILENT_REPLY_TOKEN);
        expect(result.payload.text).toBe(
          "⚠️ The model request was rate-limited. Please try again in a few minutes.",
        );
      }
    },
  );

  it.each(NON_DIRECT_FAILURE_SURFACE_CASES)(
    "surfaces typed periodic rate-limit details in $label chats",
    async (testCase) => {
      const periodicLimitMessage = "You've hit your weekly limit · resets 6pm (UTC)";
      state.runEmbeddedAgentMock.mockRejectedValueOnce(
        new FailoverError(periodicLimitMessage, {
          reason: "rate_limit",
          provider: "anthropic",
          model: "claude-opus-4-1",
          rawError: periodicLimitMessage,
        }),
      );

      const result = await executeTestTurn({
        sessionCtx: createNonDirectFailureSessionCtx(testCase),
      });

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.isError).toBe(true);
        expect(result.payload.text).not.toBe(SILENT_REPLY_TOKEN);
        expect(result.payload.text).toContain("weekly limit");
        expect(result.payload.text).toContain("resets 6pm");
        expect(result.payload.text).not.toContain("few minutes");
      }
    },
  );

  it("scopes fallback exhaustion copy to the attempted models", () => {
    const payload = buildKnownAgentRunFailureReplyPayload({
      err: createTestFallbackSummaryError({
        message: "fallback exhausted",
        attempts: [
          {
            provider: "anthropic",
            model: "claude-opus-4-1",
            error: "rate limited",
            reason: "rate_limit",
          },
          {
            provider: "openai",
            model: "gpt-5.5",
            error: "overloaded",
            reason: "overloaded",
          },
        ],
        soonestCooldownExpiry: null,
      }),
      sessionCtx: createMinimalRunAgentTurnParams().sessionCtx,
      resolvedVerboseLevel: "off",
    });

    expect(payload?.text).toBe(
      "⚠️ All attempted models were rate-limited or overloaded. Please try again in a few minutes.",
    );
  });

  it("surfaces typed periodic rate-limit details through known failure payloads in group chats", () => {
    const periodicLimitMessage = "You've hit your weekly limit · resets 6pm (UTC)";
    const payload = buildKnownAgentRunFailureReplyPayload({
      err: new FailoverError(periodicLimitMessage, {
        reason: "rate_limit",
        provider: "anthropic",
        model: "claude-opus-4-1",
        rawError: periodicLimitMessage,
      }),
      sessionCtx: createNonDirectFailureSessionCtx(NON_DIRECT_FAILURE_SURFACE_CASES[0]),
      resolvedVerboseLevel: "off",
    });

    expect(payload).toBeDefined();
    expect(payload?.isError).toBe(true);
    expect(payload?.text).not.toBe(SILENT_REPLY_TOKEN);
    expect(payload?.text).toContain("weekly limit");
    expect(payload?.text).toContain("resets 6pm");
    expect(payload?.text).not.toContain("few minutes");
  });

  it.each(NON_DIRECT_FAILURE_SURFACE_CASES)(
    "surfaces overloaded fallback copy in $label chats",
    async (testCase) => {
      const executeAgentTurn = await getExecuteAgentTurnForTest();
      vi.useFakeTimers();
      state.runEmbeddedAgentMock.mockRejectedValue(new Error("model is overloaded"));

      const resultPromise = executeAgentTurn(
        createMinimalRunAgentTurnParams({
          sessionCtx: createNonDirectFailureSessionCtx(testCase),
        }),
      );
      await vi.advanceTimersByTimeAsync(217_500);
      const result = await resultPromise;

      expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(11);
      const wholeTurnReruns = state.runEmbeddedAgentMock.mock.calls.length - 1;
      expect(wholeTurnReruns * resolveMaxRunRetryIterations(17)).toBe(1_600);
      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.isError).toBe(true);
        expect(result.payload.text).not.toBe(SILENT_REPLY_TOKEN);
        expect(result.payload.text).toContain("overloaded");
      }
    },
  );

  it("retries fallback-wide overloads turn-locally and sends one delayed status notice", async () => {
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    vi.useFakeTimers();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      state.runWithModelFallbackMock.mockRejectedValueOnce(createOverloadSummaryError());
    }
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "recovered" }],
      meta: {},
    });
    const onBlockReply = vi.fn();

    const resultPromise = executeAgentTurn(
      createMinimalRunAgentTurnParams({ opts: { onBlockReply } }),
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(onBlockReply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(7_501);
    const result = await resultPromise;

    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(5);
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("success");
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const notice = onBlockReply.mock.calls[0]?.[0];
    expect(notice).toMatchObject({
      text: "The AI service is temporarily overloaded. I’m still retrying; this may take a few minutes.",
      replyToId: "msg",
      replyToCurrent: true,
      isStatusNotice: true,
    });
    expect(getReplyPayloadMetadata(notice)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
    });
  });

  it.each(["tool_execution_started", "assistant_output_started"] as const)(
    "does not replay an overloaded turn after %s",
    async (phase) => {
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        params.onExecutionPhase?.({ phase });
        throw new Error("model is overloaded");
      });

      const result = await executeTestTurn();

      expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.text).toContain("overloaded");
      }
    },
  );

  it.each(["tool_execution_started", "assistant_output_started"] as const)(
    "does not replay a CLI timeout after %s",
    async (phase) => {
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        params.onExecutionPhase?.({ phase });
        throw new FailoverError("CLI exceeded timeout (600s) and was terminated.", {
          reason: "timeout",
          provider: "claude-cli",
          code: "cli_overall_timeout",
          cliTimeout: {
            mode: "overall",
            timeoutSeconds: 600,
            observedActivity: true,
            activeToolCount: phase === "tool_execution_started" ? 1 : 0,
            backgroundTaskCount: 0,
          },
        });
      });

      const result = await executeTestTurn();

      expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.text).toContain("overall turn limit");
        expect(result.payload.text).toContain("did not replay this turn automatically");
      }
    },
  );

  it("does not retry a CLI timeout whose recorded activity has no execution phase mark", async () => {
    vi.useFakeTimers();
    // FIXED(refactor-02b): the typed CLI activity fact blocks whole-turn replay without a phase mark.
    const timeoutError = new FailoverError("CLI exceeded timeout (600s) and was terminated.", {
      reason: "timeout",
      provider: "claude-cli",
      model: "claude-opus-4-8",
      code: "cli_overall_timeout",
      cliTimeout: {
        mode: "overall",
        timeoutSeconds: 600,
        observedActivity: true,
        activeToolCount: 0,
        backgroundTaskCount: 0,
      },
    });
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => ({
      result: await params.run("claude-cli", "claude-opus-4-8"),
      provider: "claude-cli",
      model: "claude-opus-4-8",
      attempts: [],
    }));
    state.runCliAgentMock.mockRejectedValue(timeoutError);
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-opus-4-8";

    const resultPromise = executeTestTurn({ followupRun });
    await vi.advanceTimersByTimeAsync(2_500);
    const result = await resultPromise;

    expect(state.runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    const wholeTurnRetries = state.runCliAgentMock.mock.calls.length - 1;
    expect(wholeTurnRetries).toBe(0);
    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("overall turn limit");
      expect(result.payload.text).toMatch(/effects may be partial/i);
      expect(result.payload.text).toContain("did not replay this turn automatically");
    }
  });

  it("warns about partial effects when an active CLI tool hits the no-output watchdog", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onExecutionPhase?.({ phase: "tool_execution_started" });
      throw new FailoverError("CLI produced no output for 120s and was terminated.", {
        reason: "timeout",
        provider: "claude-cli",
        code: "cli_no_output_timeout",
        cliTimeout: {
          mode: "no-output",
          timeoutSeconds: 120,
          observedActivity: true,
          activeToolCount: 1,
          backgroundTaskCount: 0,
        },
      });
    });

    const result = await executeTestTurn();

    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("no-output watchdog");
      expect(result.payload.text).toContain("1 active CLI tool call");
      expect(result.payload.text).toMatch(/effects may be partial/i);
      expect(result.payload.text).toContain("did not replay this turn automatically");
    }
  });

  it.each(["tool_execution_started", "assistant_output_started"] as const)(
    "cancels the pending overload notice after %s",
    async (phase) => {
      vi.useFakeTimers();
      let resolveRetry!: (value: unknown) => void;
      const retryResult = new Promise<unknown>((resolve) => {
        resolveRetry = resolve;
      });
      state.runEmbeddedAgentMock
        .mockRejectedValueOnce(new Error("model is overloaded"))
        .mockImplementationOnce((params: EmbeddedAgentParams) => {
          params.onExecutionPhase?.({ phase });
          return retryResult;
        });
      const onBlockReply = vi.fn();

      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const resultPromise = executeAgentTurn(
        createMinimalRunAgentTurnParams({ opts: { onBlockReply } }),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
      expect(onBlockReply).not.toHaveBeenCalled();

      resolveRetry({ payloads: [{ text: "recovered" }], meta: {} });
      await expect(resultPromise).resolves.toMatchObject({ kind: "success" });
    },
  );

  it("sends the delayed overload notice while a retry provider call is still running", async () => {
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    vi.useFakeTimers();
    let resolveRetry!: (value: unknown) => void;
    const retryResult = new Promise<unknown>((resolve) => {
      resolveRetry = resolve;
    });
    state.runWithModelFallbackMock
      .mockRejectedValueOnce(createOverloadSummaryError())
      .mockImplementationOnce(() => retryResult);
    const onBlockReply = vi.fn((..._args: unknown[]) => new Promise<void>(() => {}));

    const resultPromise = executeAgentTurn(
      createMinimalRunAgentTurnParams({ opts: { onBlockReply } }),
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(2);
    expect(onBlockReply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onBlockReply).toHaveBeenCalledTimes(1);

    resolveRetry({
      result: { payloads: [{ text: "recovered" }], meta: {} },
      provider: "anthropic",
      model: "claude-opus-4-1",
      attempts: [],
    });
    await expect(resultPromise).resolves.toMatchObject({ kind: "success" });
    expect(onBlockReply.mock.calls[0]?.[1]).toMatchObject({
      abortSignal: expect.objectContaining({ aborted: true }),
      timeoutMs: 5_000,
    });
  });

  it("does not block retry when a slow first overload makes the status notice immediately due", async () => {
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    vi.useFakeTimers();
    let rejectInitial!: (error: unknown) => void;
    const initialResult = new Promise<unknown>((_resolve, reject) => {
      rejectInitial = reject;
    });
    state.runWithModelFallbackMock
      .mockImplementationOnce(() => initialResult)
      .mockResolvedValueOnce({
        result: { payloads: [{ text: "recovered" }], meta: {} },
        provider: "anthropic",
        model: "claude-opus-4-1",
        attempts: [],
      });
    const onBlockReply = vi.fn((..._args: unknown[]) => new Promise<void>(() => {}));

    const resultPromise = executeAgentTurn(
      createMinimalRunAgentTurnParams({ opts: { onBlockReply } }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    rejectInitial(createOverloadSummaryError());
    await vi.advanceTimersByTimeAsync(2_500);

    await expect(resultPromise).resolves.toMatchObject({ kind: "success" });
    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(2);
    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("interrupts overload backoff on abort and cancels the pending status notice", async () => {
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    vi.useFakeTimers();
    state.runEmbeddedAgentMock.mockRejectedValue(new Error("model is overloaded"));
    const abortController = new AbortController();
    const { replyOperation } = createMockReplyOperation({ abortSignal: abortController.signal });
    const onBlockReply = vi.fn();

    const resultPromise = executeAgentTurn(
      createMinimalRunAgentTurnParams({
        opts: { onBlockReply },
        replyOperation,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    abortController.abort();
    await expect(resultPromise).resolves.toMatchObject({
      kind: "final",
      payload: { text: SILENT_REPLY_TOKEN },
    });
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onBlockReply).not.toHaveBeenCalled();
    const agentEvents = await import("../../infra/agent-events.js");
    expect(vi.mocked(agentEvents.emitAgentEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "lifecycle",
        data: expect.objectContaining({ phase: "error", aborted: true }),
      }),
    );
  });

  it("interrupts the transient HTTP retry backoff on abort", async () => {
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    vi.useFakeTimers();
    state.runEmbeddedAgentMock.mockRejectedValue(
      new FailoverError("provider request timed out", {
        reason: "timeout",
        provider: "anthropic",
        model: "claude-opus-4-1",
      }),
    );
    const abortController = new AbortController();
    const { replyOperation } = createMockReplyOperation({ abortSignal: abortController.signal });

    const resultPromise = executeAgentTurn(createMinimalRunAgentTurnParams({ replyOperation }));
    await vi.advanceTimersByTimeAsync(0);
    abortController.abort();
    await expect(resultPromise).resolves.toMatchObject({
      kind: "final",
      payload: { text: SILENT_REPLY_TOKEN },
    });
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the overload notice immediately when a slow retrying turn is aborted", async () => {
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    vi.useFakeTimers();
    let resolveRetry!: (value: unknown) => void;
    const retryResult = new Promise<unknown>((resolve) => {
      resolveRetry = resolve;
    });
    state.runWithModelFallbackMock
      .mockRejectedValueOnce(createOverloadSummaryError())
      .mockImplementationOnce(() => retryResult);
    const abortController = new AbortController();
    const onBlockReply = vi.fn();

    const resultPromise = executeAgentTurn(
      createMinimalRunAgentTurnParams({
        opts: { abortSignal: abortController.signal, onBlockReply },
      }),
    );
    await vi.advanceTimersByTimeAsync(2_500);
    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(27_499);
    abortController.abort();
    await vi.advanceTimersByTimeAsync(1);
    expect(onBlockReply).not.toHaveBeenCalled();

    resolveRetry({
      result: { payloads: [{ text: "recovered" }], meta: {} },
      provider: "anthropic",
      model: "claude-opus-4-1",
      attempts: [],
    });
    await expect(resultPromise).resolves.toMatchObject({ kind: "success" });
  });

  it("surfaces typed overloaded failures without rate-limit cooldown copy", async () => {
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    vi.useFakeTimers();
    state.runEmbeddedAgentMock.mockRejectedValue(
      new FailoverError("529 Please try again", {
        reason: "overloaded",
        provider: "anthropic",
        model: "claude-opus-4-1",
        status: 529,
      }),
    );

    const resultPromise = executeAgentTurn(
      createMinimalRunAgentTurnParams({
        sessionCtx: createNonDirectFailureSessionCtx(NON_DIRECT_FAILURE_SURFACE_CASES[0]),
      }),
    );
    await vi.advanceTimersByTimeAsync(217_500);
    const result = await resultPromise;

    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(11);
    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.isError).toBe(true);
      expect(result.payload.text).not.toBe(SILENT_REPLY_TOKEN);
      expect(result.payload.text).toContain("overloaded");
      expect(result.payload.text).not.toContain("rate-limited");
      expect(result.payload.text).not.toContain("few minutes");
    }
  });

  it("surfaces rate-limit fallback copy in Discord group chats when silentReply.group is disallow", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(new Error("429 rate limit exceeded"));

    const followupRun = createFollowupRun();
    followupRun.run.config = {
      agents: {
        defaults: {
          silentReply: { group: "disallow" },
        },
      },
    };

    const result = await executeTestTurn({
      followupRun,
      sessionCtx: {
        Provider: "discord",
        Surface: "discord",
        ChatType: "group",
        GroupSubject: "agent group",
        GroupChannel: "#general",
        MessageSid: "msg",
      } as unknown as TemplateContext,
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.isError).toBe(true);
      expect(result.payload.text).not.toBe(SILENT_REPLY_TOKEN);
      expect(result.payload.text).toContain("rate-limited");
    }
  });

  it("uses compact generic copy for raw runner failures in normal Discord direct chats", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error("openai/gpt-5.5 ended with an incomplete terminal response"),
    );

    const result = await executeTestTurn({ sessionCtx: createDirectFailureSessionCtx() });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(GENERIC_RUN_FAILURE_TEXT);
    }
  });

  it("keeps raw runner failure guidance visible in verbose Discord direct chats", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error("openai/gpt-5.5 ended with an incomplete terminal response"),
    );

    const result = await executeTestTurn(
      { sessionCtx: createDirectFailureSessionCtx() },
      { resolvedVerboseLevel: "on" },
    );

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("Agent failed before reply");
      expect(result.payload.text).toContain("incomplete terminal response");
    }
  });

  it("surfaces provider quota guidance for generic HTTP 429 failures before reply", async () => {
    const error = new Error(
      "Something went wrong while processing your request. Please try again.",
    );
    Object.assign(error, { status: 429 });
    state.runEmbeddedAgentMock.mockRejectedValueOnce(error);

    const result = await executeTestTurn({ sessionCtx: createDirectFailureSessionCtx() });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE);
      expect(result.payload.text).not.toBe(GENERIC_RUN_FAILURE_TEXT);
    }
  });

  it("surfaces provider internal errors without session reset guidance before reply", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new FailoverError(
        "The AI service returned an internal error. Please try again in a moment.",
        {
          reason: "server_error",
          provider: "fyapis",
          model: "gpt-5.5",
          status: 500,
        },
      ),
    );

    const result = await executeTestTurn({
      sessionCtx: createDirectFailureSessionCtx("telegram"),
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(PROVIDER_INTERNAL_ERROR_USER_MESSAGE);
      expect(result.payload.text).not.toContain("/new");
      expect(result.payload.text).not.toBe(GENERIC_RUN_FAILURE_TEXT);
    }
  });

  it("surfaces billing guidance for Volcengine Coding Plan subscription failures before reply", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error(
        'HTTP 400 Bad Request: {"error":{"code":"InvalidSubscription","message":"Your account does not have a valid CodingPlan subscription, or your subscription has expired."}}',
      ),
    );

    const result = await executeTestTurn({ sessionCtx: createDirectFailureSessionCtx() });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(BILLING_ERROR_USER_MESSAGE);
      expect(result.payload.text).not.toBe(GENERIC_RUN_FAILURE_TEXT);
    }
  });

  it("preserves neutral billing guidance for OAuth failover errors", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new FailoverError(formatBillingErrorMessage("Anthropic", "claude-sonnet-4-5", "oauth"), {
        reason: "billing",
        provider: "Anthropic",
        model: "claude-sonnet-4-5",
        authMode: "oauth",
      }),
    );

    const result = await executeTestTurn();

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("check your account for subscription or usage limits");
      expect(result.payload.text).not.toContain("API key");
      expect(result.payload.text).not.toContain("top up");
    }
  });

  it("preserves neutral billing guidance after fallback exhaustion", async () => {
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      createTestFallbackSummaryError({
        message: "All models failed (1): openai/gpt-5.5: billing",
        attempts: [
          {
            provider: "openai",
            model: "gpt-5.5",
            error: "billing",
            reason: "billing",
            authMode: "oauth",
          },
        ],
        soonestCooldownExpiry: null,
      }),
    );

    const result = await executeTestTurn();

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("check your account for subscription or usage limits");
      expect(result.payload.text).not.toContain("API key");
      expect(result.payload.text).not.toContain("top up");
    }
  });

  it("formats raw Codex API payloads before forwarding verbose external errors", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error(
        'Codex error: {"type":"error","error":{"type":"server_error","message":"Something exploded"},"sequence_number":2}',
      ),
    );

    const result = await executeTestTurn(undefined, {
      commandBody: "hello",
      resolvedVerboseLevel: "on",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Agent failed before reply: LLM error server_error: Something exploded. Please try again, or use /new to start a fresh session.",
      );
    }
  });
});
