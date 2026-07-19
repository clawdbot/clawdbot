import { describe, expect, it, vi } from "vitest";
import type { SessionMcpRuntime } from "../../agents/agent-bundle-mcp-types.js";
import { updateMcpAppModelContext } from "../../agents/mcp-app-model-context.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { HEARTBEAT_RUN_SCOPE } from "../../infra/heartbeat-run-scope.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions } from "../types.js";
import {
  setupAgentRunnerExecutionTestState,
  getRunAgentTurnWithFallback,
  createMockTypingSignaler,
  createFollowupRun,
  createMockReplyOperation,
  requireRecord,
  expectMockCallArgFields,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type {
  FallbackRunnerParams,
  EmbeddedAgentParams,
} from "./agent-runner-execution.test-support.js";
import { createReplyOperation, type ReplyOperation } from "./reply-run-registry.js";

const state = setupAgentRunnerExecutionTestState();

describe("runAgentTurnWithFallback: run lifecycle and ownership", () => {
  it("passes the reply abort signal to fallback orchestration and candidates", async () => {
    const { replyOperation } = createMockReplyOperation();
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams(),
      replyOperation,
    });

    const fallbackCall = requireRecord(
      state.runWithModelFallbackMock.mock.calls[0]?.[0],
      "runWithModelFallback params",
    );
    const embeddedCall = requireRecord(
      state.runEmbeddedAgentMock.mock.calls[0]?.[0],
      "runEmbeddedAgent params",
    );
    expect(fallbackCall.abortSignal).toBe(replyOperation.abortSignal);
    expect(fallbackCall.sessionId).toBe("session");
    expect(embeddedCall.abortSignal).toBe(replyOperation.abortSignal);
  });

  it("revalidates thinking for each main-chat fallback candidate without mutating the run", async () => {
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.6-sol";
    followupRun.run.thinkLevel = "ultra";
    followupRun.run.config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
            "demo/basic": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
    };
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params.run("openai", "gpt-5.6-sol");
      const result = await params.run("demo", "basic");
      return { result, provider: "demo", model: "basic", attempts: [] };
    });
    state.runEmbeddedAgentMock.mockResolvedValue({ payloads: [{ text: "ok" }], meta: {} });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ followupRun }),
    });

    expect(state.runEmbeddedAgentMock.mock.calls.map((call) => call[0]?.thinkLevel)).toEqual([
      "ultra",
      "high",
    ]);
    expect(followupRun.run.thinkLevel).toBe("ultra");
  });

  it("freezes abort ownership only after model fallback settles", async () => {
    const { replyOperation, freezeAbortMock } = createMockReplyOperation();
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      expect(freezeAbortMock).not.toHaveBeenCalled();
      await params.run("anthropic", "claude").catch(() => undefined);
      expect(freezeAbortMock).not.toHaveBeenCalled();
      const result = await params.run("openai", "gpt-5.5");
      expect(freezeAbortMock).not.toHaveBeenCalled();
      return {
        result,
        provider: "openai",
        model: "gpt-5.5",
        attempts: [],
      };
    });
    state.runEmbeddedAgentMock
      .mockRejectedValueOnce(new Error("primary failed"))
      .mockResolvedValueOnce({
        payloads: [{ text: "ok" }],
        meta: {},
      });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams(),
      replyOperation,
    });

    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(freezeAbortMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses a settled fallback result after an accepted user abort", async () => {
    const { replyOperation, freezeAbortMock } = createMockReplyOperation();
    const abortController = new AbortController();
    let operationResult: ReplyOperation["result"] = null;
    let releaseFallback: () => void = () => undefined;
    let markCandidateSettled: () => void = () => undefined;
    const candidateSettled = new Promise<void>((resolve) => {
      markCandidateSettled = resolve;
    });
    const fallbackRelease = new Promise<void>((resolve) => {
      releaseFallback = resolve;
    });
    let releaseToolTask: () => void = () => undefined;
    const pendingToolTask = new Promise<void>((resolve) => {
      releaseToolTask = resolve;
    });
    const pendingToolTasks = new Set([pendingToolTask]);
    Object.defineProperty(replyOperation, "abortSignal", {
      configurable: true,
      get: () => abortController.signal,
    });
    Object.defineProperty(replyOperation, "result", {
      configurable: true,
      get: () => operationResult,
    });
    replyOperation.abortByUser = vi.fn(() => {
      operationResult = { kind: "aborted", code: "aborted_by_user" };
      abortController.abort("user_abort");
      return true;
    });
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "late reply" }],
      meta: {},
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await params.run("anthropic", "claude");
      markCandidateSettled();
      await fallbackRelease;
      return {
        result,
        provider: "anthropic",
        model: "claude",
        attempts: [],
      };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pending = runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams(),
      replyOperation,
      pendingToolTasks,
    });
    await candidateSettled;
    expect(replyOperation.abortByUser()).toBe(true);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    releaseFallback();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).toBe(false);
    expect(freezeAbortMock).not.toHaveBeenCalled();
    releaseToolTask();

    await expect(pending).resolves.toEqual({
      kind: "final",
      payload: { text: SILENT_REPLY_TOKEN },
    });
    expect(freezeAbortMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses a settled fallback result after an upstream abort", async () => {
    const upstreamAbort = new AbortController();
    const replyOperation = createReplyOperation({
      sessionKey: "agent:main:upstream-settled-fallback",
      sessionId: "upstream-settled-fallback",
      resetTriggered: false,
      upstreamAbortSignal: upstreamAbort.signal,
    });
    replyOperation.setPhase("running");
    let releaseFallback: () => void = () => undefined;
    let markCandidateSettled: () => void = () => undefined;
    const candidateSettled = new Promise<void>((resolve) => {
      markCandidateSettled = resolve;
    });
    const fallbackRelease = new Promise<void>((resolve) => {
      releaseFallback = resolve;
    });
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "late reply" }],
      meta: {},
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await params.run("anthropic", "claude");
      markCandidateSettled();
      await fallbackRelease;
      return {
        result,
        provider: "anthropic",
        model: "claude",
        attempts: [],
      };
    });

    try {
      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const pending = runAgentTurnWithFallback({
        ...createMinimalRunAgentTurnParams(),
        replyOperation,
      });
      await candidateSettled;
      upstreamAbort.abort(new Error("caller cancelled"));
      expect(replyOperation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
      expect(replyOperation.abortSignal.aborted).toBe(true);
      releaseFallback();

      await expect(pending).resolves.toEqual({
        kind: "final",
        payload: { text: SILENT_REPLY_TOKEN },
      });
    } finally {
      replyOperation.complete();
    }
  });

  it("preserves restart reply classification after an upstream abort settles fallback", async () => {
    const upstreamAbort = new AbortController();
    const replyOperation = createReplyOperation({
      sessionKey: "agent:main:upstream-settled-restart",
      sessionId: "upstream-settled-restart",
      resetTriggered: false,
      upstreamAbortSignal: upstreamAbort.signal,
    });
    replyOperation.setPhase("running");
    let releaseFallback: () => void = () => undefined;
    let markCandidateSettled: () => void = () => undefined;
    const candidateSettled = new Promise<void>((resolve) => {
      markCandidateSettled = resolve;
    });
    const fallbackRelease = new Promise<void>((resolve) => {
      releaseFallback = resolve;
    });
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "late reply" }],
      meta: {},
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await params.run("anthropic", "claude");
      markCandidateSettled();
      await fallbackRelease;
      return {
        result,
        provider: "anthropic",
        model: "claude",
        attempts: [],
      };
    });

    try {
      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const pending = runAgentTurnWithFallback({
        ...createMinimalRunAgentTurnParams(),
        replyOperation,
      });
      await candidateSettled;
      upstreamAbort.abort(createAgentRunRestartAbortError());
      releaseFallback();

      await expect(pending).resolves.toEqual({
        kind: "final",
        payload: {
          isError: true,
          text: "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
        },
      });
    } finally {
      replyOperation.complete();
    }
  });

  it("passes the hydrated run account to embedded execution", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });
    const followupRun = createFollowupRun();
    followupRun.run.agentAccountId = "work";
    followupRun.originatingChannel = "slack";
    followupRun.originatingTo = "user:U1";
    followupRun.originatingAccountId = "work";
    followupRun.originatingChatType = "direct";

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: {
          Provider: "cron-event",
        },
      }),
    );

    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "embedded run params", {
      messageProvider: "slack",
      messageTo: "user:U1",
      agentAccountId: "work",
      chatType: "direct",
    });
  });

  it("signals typing from embedded harness execution phases before assistant text", async () => {
    const typingSignals = createMockTypingSignaler();
    const onAgentRunStart = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onExecutionPhase?.({
        phase: "model_call_started",
        provider: "openai",
        model: "gpt-5.4",
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({
        opts: {
          onAgentRunStart,
        } satisfies GetReplyOptions,
      }),
      typingSignals,
    });

    expect(result.kind).toBe("success");
    expect(typingSignals.signalExecutionActivity).toHaveBeenCalledOnce();
    expect(typingSignals.signalRunStart).not.toHaveBeenCalled();
    expect(onAgentRunStart).toHaveBeenCalledOnce();
  });

  it("injects pending MCP App context exactly once without changing transcript text", async () => {
    const runtime = { sessionId: "session" } as SessionMcpRuntime;
    state.peekSessionMcpRuntimeMock.mockReturnValue(runtime);
    updateMcpAppModelContext(
      runtime,
      {},
      {
        content: [{ type: "text", text: "selected item 42" }],
      },
    );
    state.runEmbeddedAgentMock.mockImplementation(async (params: EmbeddedAgentParams) => {
      params.onExecutionPhase?.({ phase: "model_call_started" });
      return { payloads: [{ text: "ok" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams(),
      commandBody: "show details",
      transcriptCommandBody: "show details",
    });
    await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams(),
      commandBody: "next question",
      transcriptCommandBody: "next question",
    });

    expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.prompt).toContain("selected item 42");
    expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.transcriptPrompt).toBe("show details");
    expect(state.runEmbeddedAgentMock.mock.calls[1]?.[0]?.prompt).toBe("next question");
    expect(state.runEmbeddedAgentMock.mock.calls[1]?.[0]?.transcriptPrompt).toBe("next question");
  });

  it("does not consume pending MCP App context when pre-start validation fails", async () => {
    const runtime = { sessionId: "session" } as SessionMcpRuntime;
    state.peekSessionMcpRuntimeMock.mockReturnValue(runtime);
    updateMcpAppModelContext(
      runtime,
      {},
      {
        content: [{ type: "text", text: "still pending" }],
      },
    );
    state.resolveCurrentTurnImagesMock.mockRejectedValueOnce(new Error("invalid image"));

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    await expect(runAgentTurnWithFallback(createMinimalRunAgentTurnParams())).rejects.toThrow(
      "invalid image",
    );
    state.resolveCurrentTurnImagesMock.mockResolvedValueOnce({});
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onExecutionPhase?.({ phase: "model_call_started" });
      return { payloads: [{ text: "ok" }], meta: {} };
    });
    await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.prompt).toContain("still pending");
  });

  it("forwards CLI harness execution phases into typing signals", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("codex-cli", "gpt-5.4"),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runCliAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onExecutionPhase?.({
        phase: "process_spawned",
        provider: "codex-cli",
        model: "gpt-5.4",
        backend: "codex",
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });
    const followupRun = createFollowupRun();
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";
    followupRun.run.clientCaps = ["tool-events", "inline-widgets"];
    const typingSignals = createMockTypingSignaler();

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        followupRun,
        typingSignals,
      }),
    );

    expect(result.kind).toBe("success");
    expect(typingSignals.signalExecutionActivity).toHaveBeenCalledOnce();
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      provider: "codex-cli",
      model: "gpt-5.4",
      clientCaps: ["tool-events", "inline-widgets"],
    });
  });

  it("consumes pending MCP App context when a CLI process receives the turn", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("codex-cli", "gpt-5.4"),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [],
    }));
    const runtime = { sessionId: "session" } as SessionMcpRuntime;
    state.peekSessionMcpRuntimeMock.mockReturnValue(runtime);
    updateMcpAppModelContext(
      runtime,
      {},
      {
        content: [{ type: "text", text: "CLI selection" }],
      },
    );
    state.runCliAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onExecutionPhase?.({ phase: "process_spawned" });
      return { payloads: [{ text: "final" }], meta: {} };
    });
    const followupRun = createFollowupRun();
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        followupRun,
      }),
    );

    expect(state.runCliAgentMock.mock.calls[0]?.[0]?.prompt).toContain("CLI selection");
    expect(state.runCliAgentMock.mock.calls[0]?.[0]?.transcriptPrompt).toBe("fix it");
    expect(runtime.pendingMcpAppModelContext).toBeUndefined();
  });

  it("propagates commitment-only bootstrap scope to CLI runs", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("claude-cli", "sonnet-4.6"),
      provider: "claude-cli",
      model: "sonnet-4.6",
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {},
    });
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "sonnet-4.6";
    const params = createMinimalRunAgentTurnParams({
      followupRun,
      opts: {
        isHeartbeat: true,
        bootstrapContextMode: "lightweight",
        [HEARTBEAT_RUN_SCOPE]: "commitment-only",
      },
    });
    params.isHeartbeat = true;

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    await runAgentTurnWithFallback(params);

    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      trigger: "heartbeat",
      bootstrapContextMode: "lightweight",
      bootstrapContextRunKind: "commitment-only",
    });
  });

  it("registers run ownership before asynchronous image preflight", async () => {
    const agentEvents = await import("../../infra/agent-events.js");
    const registerAgentRunContext = vi.mocked(agentEvents.registerAgentRunContext);
    let resolveImages: (() => void) | undefined;
    state.resolveCurrentTurnImagesMock.mockImplementationOnce(
      () =>
        new Promise<Record<string, never>>((resolve) => {
          resolveImages = () => resolve({});
        }),
    );
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const runPromise = runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(registerAgentRunContext).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sessionKey: "main",
        sessionId: "session",
      }),
    );
    expect(state.runWithModelFallbackMock).not.toHaveBeenCalled();

    resolveImages?.();
    await runPromise;
  });

  it("clears run ownership when image preflight fails", async () => {
    const agentEvents = await import("../../infra/agent-events.js");
    const clearAgentRunContext = vi.mocked(agentEvents.clearAgentRunContext);
    state.resolveCurrentTurnImagesMock.mockRejectedValueOnce(new Error("invalid image metadata"));

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    await expect(
      runAgentTurnWithFallback(
        createMinimalRunAgentTurnParams({
          opts: { runId: "preflight-failure" },
        }),
      ),
    ).rejects.toThrow("invalid image metadata");

    expect(clearAgentRunContext).toHaveBeenCalledWith("preflight-failure", expect.any(String));
    expect(state.runWithModelFallbackMock).not.toHaveBeenCalled();
  });

  it("passes runtime toolsAllow to embedded agent runs", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        opts: {
          toolsAllow: ["message"],
        },
      }),
    );

    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "embedded run params", {
      toolsAllow: ["message"],
    });
  });
});
