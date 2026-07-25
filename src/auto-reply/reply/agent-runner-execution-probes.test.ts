import { describe, expect, it, vi } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveFallbackCandidateRun } from "./agent-runner-auth-profile.js";
import { resolveRunAfterAutoFallbackPrimaryProbeRecheck } from "./agent-runner-auto-fallback.js";
import {
  setupAgentRunnerExecutionTestState,
  GENERIC_RUN_FAILURE_TEXT,
  getRunAgentTurnWithFallback,
  createFollowupRun,
  createMockReplyOperation,
  expectRecordFields,
  expectMockCallArgFields,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type {
  FallbackRunnerParams,
  EmbeddedAgentParams,
} from "./agent-runner-execution.test-support.js";
import { HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT } from "./agent-runner-failure-copy.js";

const state = setupAgentRunnerExecutionTestState();

describe("runAgentTurnWithFallback: primary probe routing", () => {
  it("rechecks queued auto fallback primary probes before running", async () => {
    const { markAutoFallbackPrimaryProbe } = await import("../../agents/agent-scope.js");
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "google",
      fallbackModel: "gemini-3-pro",
      fallbackAuthProfileId: "google:fallback",
      fallbackAuthProfileIdSource: "auto" as const,
    };
    markAutoFallbackPrimaryProbe({
      probe,
      sessionKey: "main",
      now: Date.now(),
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: "google",
      modelOverride: "gemini-3-pro",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
      authProfileOverride: "google:fallback",
      authProfileOverrideSource: "auto",
    };
    const run = createFollowupRun().run;
    run.provider = "anthropic";
    run.model = "claude-sonnet-4-6";
    run.authProfileId = "anthropic:primary";
    run.authProfileIdSource = "auto";
    run.autoFallbackPrimaryProbe = probe;

    expect(
      resolveRunAfterAutoFallbackPrimaryProbeRecheck({
        run,
        entry: sessionEntry,
        sessionKey: "main",
      }),
    ).toMatchObject({
      provider: "google",
      model: "gemini-3.1-pro-preview",
      authProfileId: "google:fallback",
      authProfileIdSource: "auto",
      autoFallbackPrimaryProbe: undefined,
    });
  });

  it("drops stale queued primary probes after a user model switch", async () => {
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "google",
      fallbackModel: "gemini-3-pro",
    };
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      modelOverride: "openai/gpt-5.4",
      modelOverrideSource: "user",
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
    };
    const run = createFollowupRun().run;
    run.provider = "anthropic";
    run.model = "claude-sonnet-4-6";
    run.autoFallbackPrimaryProbe = probe;

    expect(
      resolveRunAfterAutoFallbackPrimaryProbeRecheck({
        run,
        entry: sessionEntry,
        sessionKey: "main",
      }),
    ).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
      modelOverrideSource: "user",
      autoFallbackPrimaryProbe: undefined,
    });
  });

  it("propagates rechecked user selections to post-run state", async () => {
    const sessionKey = "rechecked-user-selection";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "user",
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
    };
    const activeSessionStore = { [sessionKey]: sessionEntry };
    const staleAutoEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: "google",
      modelOverride: "gemini-3-pro",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
    };
    const followupRun = createFollowupRun();
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude-sonnet-4-6";
    followupRun.run.autoFallbackPrimaryProbe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "google",
      fallbackModel: "gemini-3-pro",
    };
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run(params.provider, params.model),
      provider: params.provider,
      model: params.model,
      attempts: [],
    }));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "user model" }],
      meta: {
        agentMeta: {
          provider: "openai",
          model: "gpt-5.4",
        },
      },
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      sessionKey,
      activeSessionStore,
      getActiveSessionEntry: () => staleAutoEntry,
    });

    expectRecordFields(followupRun.run as unknown as Record<string, unknown>, {
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
      modelOverrideSource: "user",
    });
    expect(followupRun.run.autoFallbackPrimaryProbe).toBeUndefined();
    expectRecordFields(activeSessionStore[sessionKey] as unknown as Record<string, unknown>, {
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "user",
    });
  });

  it("drops stale queued probe metadata after the auto fallback pin is cleared", () => {
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "google",
      fallbackModel: "gemini-3-pro",
    };
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      authProfileOverride: "google:fallback",
      authProfileOverrideSource: "user",
    };
    const run = createFollowupRun().run;
    run.provider = "anthropic";
    run.model = "claude-sonnet-4-6";
    run.hasSessionModelOverride = true;
    run.modelOverrideSource = "auto";
    run.hasAutoFallbackProvenance = true;
    run.autoFallbackPrimaryProbe = probe;

    expect(
      resolveRunAfterAutoFallbackPrimaryProbeRecheck({
        run,
        entry: sessionEntry,
        sessionKey: "main",
      }),
    ).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      autoFallbackPrimaryProbe: undefined,
    });
    const rechecked = resolveRunAfterAutoFallbackPrimaryProbeRecheck({
      run,
      entry: sessionEntry,
      sessionKey: "main",
    });
    expect(rechecked.authProfileId).toBeUndefined();
    expect(rechecked.authProfileIdSource).toBeUndefined();
    expect(rechecked.hasSessionModelOverride).toBeUndefined();
    expect(rechecked.modelOverrideSource).toBeUndefined();
    expect(rechecked.hasAutoFallbackProvenance).toBeUndefined();
  });

  it("keeps fallback auth available when a primary probe falls back", () => {
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "google",
      fallbackModel: "gemini-3-pro",
      fallbackAuthProfileId: "google:fallback",
      fallbackAuthProfileIdSource: "auto" as const,
    };
    const followupRun = createFollowupRun();
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude-sonnet-4-6";
    followupRun.run.authProfileId = "anthropic:primary";
    followupRun.run.authProfileIdSource = "auto";
    followupRun.run.autoFallbackPrimaryProbe = probe;
    expect(resolveFallbackCandidateRun(followupRun.run, "google", "gemini-3-pro")).toMatchObject({
      provider: "google",
      model: "gemini-3-pro",
      authProfileId: "google:fallback",
      authProfileIdSource: "auto",
    });
  });

  it("does not clear an auto-fallback pin for an exhausted preserved result", async () => {
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "google",
      fallbackModel: "gemini-3-pro",
      fallbackAuthProfileId: "google:fallback",
      fallbackAuthProfileIdSource: "auto" as const,
    };
    const followupRun = createFollowupRun();
    followupRun.run.provider = probe.provider;
    followupRun.run.model = probe.model;
    followupRun.run.autoFallbackPrimaryProbe = probe;
    const sessionKey = "exhausted-primary-probe";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: probe.fallbackProvider,
      modelOverride: probe.fallbackModel,
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: probe.provider,
      modelOverrideFallbackOriginModel: probe.model,
      authProfileOverride: probe.fallbackAuthProfileId,
      authProfileOverrideSource: "auto",
    };
    const activeSessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    const exhaustedResult = {
      payloads: [{ text: "Terminal tool summary", isError: true }],
      meta: {
        error: {
          kind: "incomplete_turn",
          message: "All fallback candidates ended incomplete",
          fallbackSafe: true,
          terminalPresentation: true,
        },
      },
    };
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "lifecycle",
        data: {
          phase: "finishing",
          error: "All fallback candidates ended incomplete",
          livenessState: "blocked",
          providerStarted: true,
          replayInvalid: true,
          timeoutPhase: "provider",
        },
      });
      return exhaustedResult;
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "exhausted",
      result: await params.run(probe.provider, probe.model),
      provider: probe.provider,
      model: probe.model,
      attempts: [
        { provider: probe.provider, model: probe.model, error: "incomplete" },
        {
          provider: probe.fallbackProvider,
          model: probe.fallbackModel,
          error: "incomplete",
        },
      ],
    }));
    const { replyOperation, failMock, retainFailureUntilCompleteMock } = createMockReplyOperation();
    const emitAgentEvent = vi.mocked((await import("../../infra/agent-events.js")).emitAgentEvent);

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ followupRun, replyOperation }),
      sessionKey,
      activeSessionStore,
      getActiveSessionEntry: () => activeSessionStore[sessionKey],
    });

    expect(result).toMatchObject({
      kind: "success",
      fallbackExhausted: true,
      fallbackProvider: probe.provider,
      fallbackModel: probe.model,
      runResult: exhaustedResult,
    });
    expect(activeSessionStore[sessionKey]).toMatchObject({
      providerOverride: probe.fallbackProvider,
      modelOverride: probe.fallbackModel,
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: probe.provider,
      modelOverrideFallbackOriginModel: probe.model,
    });
    expect(retainFailureUntilCompleteMock).toHaveBeenCalledTimes(1);
    expect(failMock).toHaveBeenCalledWith("run_failed", expect.any(Error));
    expect(
      emitAgentEvent.mock.calls
        .map((call) => call[0])
        .find(
          (event) =>
            event.stream === "lifecycle" &&
            event.data.phase === "error" &&
            event.data.fallbackExhaustedFailure === true &&
            event.data.livenessState === "blocked" &&
            event.data.providerStarted === true &&
            event.data.replayInvalid === true &&
            event.data.timeoutPhase === "provider",
        ),
    ).toBeDefined();
  });

  it("reports a completed non-fallbackable error result as a failure terminal", async () => {
    const terminalErrorResult = {
      payloads: [{ text: "Command may have changed state", isError: true }],
      meta: {
        replayInvalid: true,
        error: {
          kind: "incomplete_turn",
          message: "raw provider detail should stay private",
          fallbackSafe: false,
        },
      },
    };
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "lifecycle",
        data: {
          phase: "finishing",
          error: "Command may have changed state",
          replayInvalid: true,
        },
      });
      return terminalErrorResult;
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "completed",
      result: await params.run("anthropic", "claude"),
      provider: "anthropic",
      model: "claude",
      attempts: [],
    }));
    const { replyOperation, failMock, retainFailureUntilCompleteMock } = createMockReplyOperation();
    const emitAgentEvent = vi.mocked((await import("../../infra/agent-events.js")).emitAgentEvent);

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        replyOperation,
        opts: { runId: "run-non-fallbackable-error" },
      }),
    );

    expect(result).toMatchObject({ kind: "success", runResult: terminalErrorResult });
    expect(retainFailureUntilCompleteMock).toHaveBeenCalledTimes(1);
    expect(failMock).toHaveBeenCalledWith("run_failed", expect.any(Error));
    const lifecycleEvents = emitAgentEvent.mock.calls
      .map((call) => call[0])
      .filter(
        (event) => event.runId === "run-non-fallbackable-error" && event.stream === "lifecycle",
      );
    expect(lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            phase: "error",
            error: "Command may have changed state",
            replayInvalid: true,
          }),
        }),
      ]),
    );
    expect(
      lifecycleEvents.some(
        (event) => event.data.phase === "end" || event.data.fallbackExhaustedFailure === true,
      ),
    ).toBe(false);
    expect(JSON.stringify(lifecycleEvents)).not.toContain("raw provider detail");
  });

  it.each([
    {
      label: "exhausted",
      outcome: "exhausted" as const,
      attempts: [{ error: "missing tool result" }],
      isHeartbeat: false,
      expectedText: GENERIC_RUN_FAILURE_TEXT,
    },
    {
      label: "completed",
      outcome: "completed" as const,
      attempts: [],
      isHeartbeat: false,
      expectedText: GENERIC_RUN_FAILURE_TEXT,
    },
    {
      label: "heartbeat",
      outcome: "completed" as const,
      attempts: [],
      isHeartbeat: true,
      expectedText: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
    },
  ])("surfaces an empty $label terminal result through the normal reply path", async (testCase) => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {
        error: {
          kind: "tool_result_mismatch",
          message: "Agent run reached a terminal error before reply delivery.",
        },
      },
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: testCase.outcome,
      result: await params.run("anthropic", "claude"),
      provider: "anthropic",
      model: "claude",
      attempts: testCase.attempts,
    }));
    const { replyOperation, failMock } = createMockReplyOperation();

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ replyOperation }),
      isHeartbeat: testCase.isHeartbeat,
    });

    expect(result).toMatchObject({
      kind: "success",
      terminalFailurePayload: {
        text: testCase.expectedText,
        isError: true,
      },
      runResult: {
        payloads: [],
      },
    });
    expect(failMock).toHaveBeenCalledWith("run_failed", expect.any(Error));
  });

  it("reports exhausted CLI results without a success lifecycle terminal", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "exhausted",
      result: await params.run("codex-cli", "gpt-5.4"),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [{ provider: "codex-cli", model: "gpt-5.4", error: "incomplete" }],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Terminal tool summary", isError: true }],
      meta: {
        error: {
          kind: "incomplete_turn",
          message: "CLI turn ended incomplete",
        },
      },
    });
    const followupRun = createFollowupRun();
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";
    const { replyOperation, failMock, retainFailureUntilCompleteMock } = createMockReplyOperation();
    const emitAgentEvent = vi.mocked((await import("../../infra/agent-events.js")).emitAgentEvent);

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        followupRun,
        replyOperation,
        opts: { runId: "run-cli-exhausted" },
      }),
    );

    expect(result).toMatchObject({
      kind: "success",
      fallbackExhausted: true,
      fallbackProvider: "codex-cli",
      fallbackModel: "gpt-5.4",
    });
    expect(retainFailureUntilCompleteMock).toHaveBeenCalledTimes(1);
    expect(failMock).toHaveBeenCalledWith("run_failed", expect.any(Error));
    const lifecycleEvents = emitAgentEvent.mock.calls
      .map((call) => call[0])
      .filter((event) => event.runId === "run-cli-exhausted" && event.stream === "lifecycle");
    expect(lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            phase: "error",
            fallbackExhaustedFailure: true,
          }),
        }),
      ]),
    );
    expect(lifecycleEvents.some((event) => event.data.phase === "end")).toBe(false);
  });

  it("preserves a CLI watchdog timeout through the lifecycle backstop", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      try {
        return await params.run("codex-cli", "gpt-5.4");
      } catch (cause) {
        throw new Error("All model fallback candidates failed", { cause });
      }
    });
    state.runCliAgentMock.mockRejectedValueOnce(
      new FailoverError("CLI produced no output", { reason: "timeout" }),
    );
    const followupRun = createFollowupRun();
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";
    const emitAgentEvent = vi.mocked((await import("../../infra/agent-events.js")).emitAgentEvent);

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        followupRun,
        opts: { runId: "run-cli-timeout" },
      }),
    );

    expect(
      emitAgentEvent.mock.calls
        .map((call) => call[0])
        .find(
          (event) =>
            event.runId === "run-cli-timeout" &&
            event.stream === "lifecycle" &&
            event.data.phase === "error",
        )?.data,
    ).toMatchObject({
      stopReason: "timeout",
      timeoutPhase: "provider",
      fallbackExhaustedFailure: true,
    });
  });

  it("keeps primary auth on same-provider primary probes", async () => {
    const probe = {
      provider: "openai",
      model: "gpt-5.5",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5.4",
      fallbackAuthProfileId: "openai:fallback",
      fallbackAuthProfileIdSource: "auto" as const,
    };
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.5";
    followupRun.run.authProfileId = "openai:primary";
    followupRun.run.authProfileIdSource = "auto";
    followupRun.run.autoFallbackPrimaryProbe = probe;
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params.run("openai", "gpt-5.5");
      return {
        result: await params.run("openai", "gpt-5.4"),
        provider: "openai",
        model: "gpt-5.4",
        attempts: [{ provider: "openai", model: "gpt-5.5", error: "rate limit" }],
      };
    });
    state.runEmbeddedAgentMock
      .mockResolvedValueOnce({ payloads: [], meta: {} })
      .mockResolvedValueOnce({ payloads: [{ text: "fallback" }], meta: {} });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    await runAgentTurnWithFallback(createMinimalRunAgentTurnParams({ followupRun }));

    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "primary run", {
      provider: "openai",
      model: "gpt-5.5",
      authProfileId: "openai:primary",
      authProfileIdSource: "auto",
    });
    expectMockCallArgFields(state.runEmbeddedAgentMock, 1, "fallback run", {
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: "openai:fallback",
      authProfileIdSource: "auto",
    });
  });

  it("does not clear a concurrent user selection after primary probe success", async () => {
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "google",
      fallbackModel: "gemini-3-pro",
    };
    const sessionKey = "concurrent-user-switch-during-probe";
    const staleAutoEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: "google",
      modelOverride: "gemini-3-pro",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
    };
    const activeSessionStore = { [sessionKey]: staleAutoEntry };
    const followupRun = createFollowupRun();
    followupRun.run.sessionKey = sessionKey;
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude-sonnet-4-6";
    followupRun.run.autoFallbackPrimaryProbe = probe;
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await params.run(params.provider, params.model);
      activeSessionStore[sessionKey] = {
        sessionId: "session",
        updatedAt: 2,
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
        modelOverrideSource: "user",
      };
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "primary recovered" }],
      meta: {
        agentMeta: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
      },
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      sessionKey,
      activeSessionStore,
      getActiveSessionEntry: () => staleAutoEntry,
    });

    expectRecordFields(activeSessionStore[sessionKey] as unknown as Record<string, unknown>, {
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "user",
    });
  });

  it("keeps rechecked primary probe runs in sync after live model switches", async () => {
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5.5",
      fallbackAuthProfileId: "openai:fallback",
      fallbackAuthProfileIdSource: "auto" as const,
    };
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
    };
    const sessionKey = "live-switch-probe";
    const activeSessionStore = { [sessionKey]: sessionEntry };
    const followupRun = createFollowupRun();
    followupRun.run.sessionKey = sessionKey;
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude-sonnet-4-6";
    followupRun.run.autoFallbackPrimaryProbe = probe;
    const attemptedProviders: Array<string | undefined> = [];
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      attemptedProviders.push(params.provider);
      const provider = params.provider ?? "anthropic";
      const model = params.model ?? "claude-sonnet-4-6";
      return {
        result: await params.run(provider, model),
        provider,
        model,
        attempts: [],
      };
    });
    state.runEmbeddedAgentMock
      .mockImplementationOnce(async () => {
        throw new LiveSessionModelSwitchError({
          provider: "openai",
          model: "gpt-5.4",
          authProfileId: "openai:primary",
          authProfileIdSource: "auto",
        });
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "switched" }],
        meta: {
          agentMeta: {
            provider: "openai",
            model: "gpt-5.4",
          },
        },
      });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      sessionKey,
      activeSessionStore,
      getActiveSessionEntry: () => activeSessionStore[sessionKey],
    });

    expect(result.kind).toBe("success");
    expect(attemptedProviders).toEqual(["anthropic", "openai"]);
    expectMockCallArgFields(state.runEmbeddedAgentMock, 1, "embedded run", {
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: "openai:primary",
      authProfileIdSource: "auto",
    });
  });
});
