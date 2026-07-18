import { describe, expect, it, vi } from "vitest";
import { formatBillingErrorMessage } from "../../agents/embedded-agent-helpers.js";
import { FailoverError } from "../../agents/failover-error.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE,
  PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE,
  PROVIDER_INTERNAL_ERROR_USER_MESSAGE,
  setupAgentRunnerExecutionTestState,
  GENERIC_RUN_FAILURE_TEXT,
  getRunAgentTurnWithFallback,
  createMockTypingSignaler,
  createFollowupRun,
  createMockReplyOperation,
  createMinimalRunAgentTurnParams,
  NON_DIRECT_FAILURE_SURFACE_CASES,
  createNonDirectFailureSessionCtx,
  type EmbeddedAgentParams,
} from "./agent-runner-execution.test-support.js";
import { buildKnownAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";

const state = setupAgentRunnerExecutionTestState();

function createOverloadSummaryError() {
  return Object.assign(new Error("All models failed (1): anthropic/claude-opus-4-1: overloaded"), {
    name: "FallbackSummaryError",
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

describe("runAgentTurnWithFallback: provider failures", () => {
  it.each(NON_DIRECT_FAILURE_SURFACE_CASES)(
    "keeps raw runner failure boilerplate out of $label chats",
    async (testCase) => {
      state.runEmbeddedAgentMock.mockRejectedValueOnce(
        new Error("openai/gpt-5.5 ended with an incomplete terminal response"),
      );

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback(
        createMinimalRunAgentTurnParams({
          sessionCtx: createNonDirectFailureSessionCtx(testCase),
        }),
      );

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

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback(
        createMinimalRunAgentTurnParams({
          followupRun,
          sessionCtx: {
            Provider: "discord",
            Surface: "discord",
            ChatType: chatType,
            GroupSubject: "agent group",
            GroupChannel: "#general",
            MessageSid: "msg",
          } as unknown as TemplateContext,
        }),
      );

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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: "group",
          GroupSubject: "agent group",
          GroupChannel: "#general",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
    );

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

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback(
        createMinimalRunAgentTurnParams({
          followupRun,
          sessionCtx: createNonDirectFailureSessionCtx(testCase),
        }),
      );

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
        new Error('No API key found for provider "openai"'),
      );

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback(
        createMinimalRunAgentTurnParams({
          sessionCtx: createNonDirectFailureSessionCtx(testCase),
        }),
      );

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.text).not.toBe(SILENT_REPLY_TOKEN);
        expect(result.payload.text).toContain('Missing API key for provider "openai"');
      }
    },
  );

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

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback(
        createMinimalRunAgentTurnParams({
          sessionCtx: createNonDirectFailureSessionCtx(testCase),
        }),
      );

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

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback(
        createMinimalRunAgentTurnParams({
          sessionCtx: createNonDirectFailureSessionCtx(testCase),
        }),
      );

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.isError).toBe(true);
        expect(result.payload.text).not.toBe(SILENT_REPLY_TOKEN);
        expect(result.payload.text).toContain("rate-limited");
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

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback(
        createMinimalRunAgentTurnParams({
          sessionCtx: createNonDirectFailureSessionCtx(testCase),
        }),
      );

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
      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      vi.useFakeTimers();
      state.runEmbeddedAgentMock.mockRejectedValue(new Error("model is overloaded"));

      const resultPromise = runAgentTurnWithFallback(
        createMinimalRunAgentTurnParams({
          sessionCtx: createNonDirectFailureSessionCtx(testCase),
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
      }
    },
  );

  it("retries fallback-wide overloads turn-locally and sends one delayed status notice", async () => {
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    vi.useFakeTimers();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      state.runWithModelFallbackMock.mockRejectedValueOnce(createOverloadSummaryError());
    }
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "recovered" }],
      meta: {},
    });
    const onBlockReply = vi.fn();

    const resultPromise = runAgentTurnWithFallback(
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

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

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

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

      expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.text).toContain("overall turn limit");
        expect(result.payload.text).toContain("did not replay this turn automatically");
      }
    },
  );

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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

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

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const resultPromise = runAgentTurnWithFallback(
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
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    vi.useFakeTimers();
    let resolveRetry!: (value: unknown) => void;
    const retryResult = new Promise<unknown>((resolve) => {
      resolveRetry = resolve;
    });
    state.runWithModelFallbackMock
      .mockRejectedValueOnce(createOverloadSummaryError())
      .mockImplementationOnce(() => retryResult);
    const onBlockReply = vi.fn((..._args: unknown[]) => new Promise<void>(() => {}));

    const resultPromise = runAgentTurnWithFallback(
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
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
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

    const resultPromise = runAgentTurnWithFallback(
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
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    vi.useFakeTimers();
    state.runEmbeddedAgentMock.mockRejectedValue(new Error("model is overloaded"));
    const abortController = new AbortController();
    const { replyOperation } = createMockReplyOperation({ abortSignal: abortController.signal });
    const onBlockReply = vi.fn();

    const resultPromise = runAgentTurnWithFallback(
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
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
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

    const resultPromise = runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({ replyOperation }),
    );
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
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
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

    const resultPromise = runAgentTurnWithFallback(
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
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    vi.useFakeTimers();
    state.runEmbeddedAgentMock.mockRejectedValue(
      new FailoverError("529 Please try again", {
        reason: "overloaded",
        provider: "anthropic",
        model: "claude-opus-4-1",
        status: 529,
      }),
    );

    const resultPromise = runAgentTurnWithFallback(
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: "group",
          GroupSubject: "agent group",
          GroupChannel: "#general",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
    );

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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        sessionCtx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: "direct",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(GENERIC_RUN_FAILURE_TEXT);
    }
  });

  it("keeps raw runner failure guidance visible in verbose Discord direct chats", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error("openai/gpt-5.5 ended with an incomplete terminal response"),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({
        sessionCtx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: "direct",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
      resolvedVerboseLevel: "on",
    });

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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        sessionCtx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: "direct",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
    );

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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        sessionCtx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: "direct",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe("billing");
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("check your account for subscription or usage limits");
      expect(result.payload.text).not.toContain("API key");
      expect(result.payload.text).not.toContain("top up");
    }
  });

  it("preserves neutral billing guidance after fallback exhaustion", async () => {
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      Object.assign(new Error("All models failed (1): openai/gpt-5.5: billing"), {
        name: "FallbackSummaryError",
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

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
        "⚠️ Agent failed before reply: LLM error server_error: Something exploded. Please try again, or use /new to start a fresh session.",
      );
    }
  });
});
