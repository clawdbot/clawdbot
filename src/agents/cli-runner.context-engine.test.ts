/** Tests CLI runner integration with context-engine lifecycle hooks. */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../context-engine/types.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";
import { waitForDeferredTurnMaintenanceForSession } from "./embedded-agent-runner/context-engine-maintenance.js";

const {
  executePreparedCliRunMock,
  loadCliSessionContextEngineMessagesMock,
  loadCliSessionHistoryMessagesMock,
  getGlobalHookRunnerMock,
  runBeforeAgentReplyForTurnMock,
  prepareCliRunContextMock,
} = vi.hoisted(() => ({
  executePreparedCliRunMock: vi.fn(),
  loadCliSessionContextEngineMessagesMock: vi.fn(),
  loadCliSessionHistoryMessagesMock: vi.fn(),
  getGlobalHookRunnerMock: vi.fn(() => null),
  runBeforeAgentReplyForTurnMock: vi.fn(async () => undefined),
  prepareCliRunContextMock: vi.fn(),
}));

let runCliAgent: typeof import("./cli-runner.js").runCliAgent;
let runPreparedCliAgent: typeof import("./cli-runner.js").runPreparedCliAgent;
let restoreCliRunnerTestDeps: typeof import("./cli-runner.js").restoreCliRunnerTestDeps;
let setCliRunnerTestDeps: typeof import("./cli-runner.js").setCliRunnerTestDeps;

vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: executePreparedCliRunMock,
}));

vi.mock("./cli-runner/prepare.runtime.js", () => ({
  prepareCliRunContext: prepareCliRunContextMock,
}));

vi.mock("./cli-runner/session-history.js", () => ({
  loadCliSessionContextEngineMessages: loadCliSessionContextEngineMessagesMock,
  loadCliSessionHistoryMessages: loadCliSessionHistoryMessagesMock,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: getGlobalHookRunnerMock,
}));

vi.mock("../plugins/before-agent-reply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/before-agent-reply.js")>()),
  runBeforeAgentReplyForTurn: runBeforeAgentReplyForTurnMock,
}));

function textMessage(role: "user" | "assistant", text: string, timestamp: number): AgentMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp,
  } as AgentMessage;
}

function createContextEngine(overrides: Partial<ContextEngine> = {}): ContextEngine {
  // Minimal context engine keeps tests focused on runner lifecycle calls.
  return {
    info: { id: "test-context-engine", name: "Test context engine" },
    ingest: vi.fn(async () => ({ ingested: true })),
    assemble: vi.fn(async (params) => ({
      messages: params.messages,
      estimatedTokens: 0,
    })),
    compact: vi.fn(async () => ({ ok: true, compacted: false })),
    ...overrides,
  };
}

function createMaintenanceResult() {
  return {
    changed: false,
    bytesFreed: 0,
    rewrittenEntries: 0,
  };
}

// The context engine reads history from the canonical store, so the runner must forward
// the exact target it was given rather than re-deriving one from a session file token.
const CONTEXT_ENGINE_SESSION_TARGET = {
  agentId: "main",
  sessionId: "openclaw-session-1",
  sessionKey: "agent:main:main",
  storePath: "/tmp/openclaw-cli-context-engine-test/openclaw-agent.sqlite",
} as const;

function createAdmittedCliRecorder(entryId: string) {
  const message = { role: "user" as const, content: "visible ask", timestamp: 1 };
  const recorder = createUserTurnTranscriptRecorder({ message, target: async () => undefined });
  const admission = {
    ...CONTEXT_ENGINE_SESSION_TARGET,
    generation: "generation-1",
    entryId,
    rawSeq: 1,
    effectiveParentId: null,
    activeMessagePosition: 0,
    logicalTurnId: `${entryId}-turn`,
    role: "user" as const,
  };
  recorder.markRuntimePersisted(message, admission);
  return { recorder, admission };
}

function buildPreparedContext(contextEngine: ContextEngine): PreparedCliRunContext {
  // Prepared contexts mirror the shape produced by prepare.runtime without
  // loading full backend setup in every lifecycle assertion.
  const backend = {
    command: "claude",
    args: ["--print"],
    output: "text" as const,
    input: "arg" as const,
    sessionMode: "existing" as const,
    serialize: true,
  };

  return {
    params: {
      admittedRunContext: createTestAdmittedRunContext("run-1"),
      sessionId: "openclaw-session-1",
      sessionKey: "agent:main:main",
      agentId: "main",
      sessionFile: "session.jsonl",
      sessionTarget: CONTEXT_ENGINE_SESSION_TARGET,
      workspaceDir: "/tmp/openclaw-cli-context-engine-test",
      prompt: "visible ask",
      transcriptPrompt: "transcript visible ask",
      provider: "claude-cli",
      model: "sonnet-4.6",
      thinkLevel: "low",
      timeoutMs: 1_000,
      runId: "run-1",
    },
    started: Date.now(),
    workspaceDir: "/tmp/openclaw-cli-context-engine-test",
    backendResolved: {
      id: "claude-cli",
      config: backend,
      bundleMcp: false,
      pluginId: "anthropic",
    },
    executionTarget: { kind: "process" },
    preparedBackend: {
      backend,
      env: {},
    },
    reusableCliSession: {
      mode: "reuse",
      sessionId: "existing-external-cli-session",
    },
    hadSessionFile: true,
    contextEngineConfig: {},
    contextEngine,
    contextEngineTurnPrompt: "transcript visible ask",
    modelId: "sonnet-4.6",
    normalizedModel: "sonnet-4.6",
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    claudeSkillsPluginArgs: [],
    authEpochVersion: 2,
  };
}

function expectMessageText(message: AgentMessage | undefined, expected: string): void {
  // Context engines may use legacy string content or structured text blocks.
  expect(message).toBeDefined();
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") {
    expect(content).toBe(expected);
    return;
  }
  expect(Array.isArray(content)).toBe(true);
  expect((content as unknown[] | undefined)?.[0]).toMatchObject({ type: "text", text: expected });
}

describe("runPreparedCliAgent context engine lifecycle", () => {
  beforeAll(async () => {
    ({ restoreCliRunnerTestDeps, runCliAgent, runPreparedCliAgent, setCliRunnerTestDeps } =
      await import("./cli-runner.js"));
  });

  beforeEach(() => {
    executePreparedCliRunMock.mockReset();
    executePreparedCliRunMock.mockResolvedValue({
      text: " final answer ",
      rawText: " final answer ",
      sessionId: "external-cli-session-1",
      usage: { input: 11, output: 7, total: 18 },
      diagnosticUsage: { input: 21, output: 9, total: 30 },
      finalPromptText: "prompt sent to cli",
    });
    loadCliSessionContextEngineMessagesMock.mockReset();
    loadCliSessionContextEngineMessagesMock.mockResolvedValue([
      textMessage("user", "old ask", 1),
      textMessage("assistant", "old answer", 2),
    ]);
    loadCliSessionHistoryMessagesMock.mockReset();
    loadCliSessionHistoryMessagesMock.mockResolvedValue([]);
    getGlobalHookRunnerMock.mockReset();
    getGlobalHookRunnerMock.mockReturnValue(null);
    runBeforeAgentReplyForTurnMock.mockClear();
    prepareCliRunContextMock.mockReset();
    restoreCliRunnerTestDeps();
    setCliRunnerTestDeps({
      claudeCliSessionTranscriptHasContent: vi.fn(async () => true),
    });
  });

  afterEach(() => {
    restoreCliRunnerTestDeps();
  });

  it.each([
    ["final answer", true],
    ["", true],
    ["", false],
  ] as const)(
    "keeps isolated output %j outside turn lifecycle (strict: %s)",
    async (text, strict) => {
      const bootstrap = vi.fn<NonNullable<ContextEngine["bootstrap"]>>(async () => ({
        bootstrapped: true,
      }));
      const afterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {});
      const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () =>
        createMaintenanceResult(),
      );
      const dispose = vi.fn(async () => {});
      const context = buildPreparedContext(
        createContextEngine({ bootstrap, afterTurn, maintain, dispose }),
      );
      context.params.isolatedCompletion = true;
      context.params.outputTextPolicy = strict ? "strict-visible" : undefined;
      executePreparedCliRunMock.mockResolvedValueOnce({ text });

      const result = runPreparedCliAgent(context);
      if (!text && !strict) {
        await expect(result).rejects.toMatchObject({ reason: "empty_response" });
      } else {
        expect((await result).payloads).toEqual(text ? [{ text }] : undefined);
      }
      expect(executePreparedCliRunMock).toHaveBeenCalledWith(context, undefined, undefined);
      expect(getGlobalHookRunnerMock).not.toHaveBeenCalled();
      expect(loadCliSessionHistoryMessagesMock).not.toHaveBeenCalled();
      expect(loadCliSessionContextEngineMessagesMock).not.toHaveBeenCalled();
      expect(bootstrap).not.toHaveBeenCalled();
      expect(afterTurn).not.toHaveBeenCalled();
      expect(maintain).not.toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();
    },
  );

  it("skips the top-level before-reply hook for isolated completion", async () => {
    const context = buildPreparedContext(createContextEngine());
    context.params.isolatedCompletion = true;
    prepareCliRunContextMock.mockResolvedValue(context);

    await expect(runCliAgent(context.params)).resolves.toMatchObject({
      payloads: [{ text: "final answer" }],
    });

    expect(prepareCliRunContextMock).toHaveBeenCalledOnce();
    expect(runBeforeAgentReplyForTurnMock).not.toHaveBeenCalled();
  });

  it("runs a native control command on the existing session without turn side effects", async () => {
    const bootstrap = vi.fn<NonNullable<ContextEngine["bootstrap"]>>(async () => ({
      bootstrapped: true,
    }));
    const afterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {});
    const context = buildPreparedContext(createContextEngine({ bootstrap, afterTurn }));
    context.params.controlOperation = "compact";
    context.params.allowEmptyAssistantReplyAsSilent = true;
    executePreparedCliRunMock.mockResolvedValueOnce({
      text: "",
      rawText: "",
      sessionId: "existing-external-cli-session",
    });

    const result = await runPreparedCliAgent(context);

    expect(result.meta.agentMeta?.sessionId).toBe("existing-external-cli-session");
    expect(executePreparedCliRunMock).toHaveBeenCalledWith(
      context,
      "existing-external-cli-session",
      undefined,
    );
    expect(getGlobalHookRunnerMock).not.toHaveBeenCalled();
    expect(loadCliSessionHistoryMessagesMock).not.toHaveBeenCalled();
    expect(loadCliSessionContextEngineMessagesMock).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
    expect(afterTurn).not.toHaveBeenCalled();
  });

  it("skips the top-level before-reply hook for native control commands", async () => {
    const context = buildPreparedContext(createContextEngine());
    context.params.controlOperation = "compact";
    prepareCliRunContextMock.mockResolvedValue(context);

    await runCliAgent(context.params);

    expect(prepareCliRunContextMock).toHaveBeenCalledOnce();
    expect(runBeforeAgentReplyForTurnMock).not.toHaveBeenCalled();
  });

  it("finalizes successful CLI turns with the active context engine", async () => {
    const bootstrap = vi.fn<NonNullable<ContextEngine["bootstrap"]>>(async () => ({
      bootstrapped: true,
    }));
    const afterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {});
    const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () =>
      createMaintenanceResult(),
    );
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({ bootstrap, afterTurn, maintain, dispose });
    const context = buildPreparedContext(contextEngine);
    const result = await runPreparedCliAgent(context);

    expect(result.meta.agentMeta?.sessionId).toBe("external-cli-session-1");
    expect(result.meta.agentMeta).toMatchObject({
      usage: { input: 11, output: 7, total: 18 },
      lastCallUsage: { input: 11, output: 7, total: 18 },
      diagnosticUsage: { input: 21, output: 9, total: 30 },
    });
    expect(loadCliSessionContextEngineMessagesMock).toHaveBeenCalledWith(context.params);
    expect(loadCliSessionHistoryMessagesMock).not.toHaveBeenCalled();
    expect(bootstrap).toHaveBeenCalledTimes(1);
    const bootstrapParams = bootstrap.mock.calls[0]?.[0];
    expect.soft(bootstrapParams).toMatchObject({
      sessionId: "openclaw-session-1",
      sessionKey: "agent:main:main",
      sessionTarget: CONTEXT_ENGINE_SESSION_TARGET,
      sessionFile: "session.jsonl",
      runtimeSettings: {
        schemaVersion: 1,
        runtime: { host: "openclaw", mode: "normal" },
        model: {
          provider: "claude-cli",
          requested: null,
          resolved: "sonnet-4.6",
        },
        contextEngineSelection: {
          selectedId: expect.any(String),
          source: "configured",
        },
        executionHost: {
          id: "cli:claude-cli",
          label: 'CLI backend "claude-cli"',
        },
      },
    });
    expect(afterTurn).toHaveBeenCalledTimes(1);
    const afterTurnParams = afterTurn.mock.calls[0]?.[0];
    expect.soft(afterTurnParams).toMatchObject({
      sessionId: "openclaw-session-1",
      sessionKey: "agent:main:main",
      sessionTarget: CONTEXT_ENGINE_SESSION_TARGET,
      sessionFile: "session.jsonl",
      prePromptMessageCount: 2,
      isHeartbeat: false,
      tokenBudget: undefined,
      runtimeContext: undefined,
    });
    expect(afterTurnParams?.messages).toHaveLength(4);
    expect(afterTurnParams?.messages.slice(0, 2)).toEqual([
      textMessage("user", "old ask", 1),
      textMessage("assistant", "old answer", 2),
    ]);
    expectMessageText(afterTurnParams?.messages[2], "transcript visible ask");
    expectMessageText(afterTurnParams?.messages[3], "final answer");
    expect(afterTurnParams?.messages[3]).toMatchObject({
      role: "assistant",
      provider: "claude-cli",
      model: "sonnet-4.6",
      usage: { input: 11, output: 7, total: 18 },
    });
    expect(maintain).toHaveBeenCalledTimes(2);
    expect.soft(maintain.mock.calls[0]?.[0]).toMatchObject({
      sessionTarget: CONTEXT_ENGINE_SESSION_TARGET,
    });
    expect.soft(maintain.mock.calls[1]?.[0]).toMatchObject({
      sessionId: "openclaw-session-1",
      sessionKey: "agent:main:main",
      sessionTarget: CONTEXT_ENGINE_SESSION_TARGET,
      sessionFile: "session.jsonl",
      runtimeContext: {
        rewriteTranscriptEntries: expect.any(Function),
        llm: { complete: expect.any(Function) },
      },
    });
    expect(dispose).not.toHaveBeenCalled();
  });

  it.each(["admission", "terminal"] as const)(
    "does not emit CLI turn facts without %s",
    async (missing) => {
      const afterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {});
      const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () =>
        createMaintenanceResult(),
      );
      const dispose = vi.fn(async () => {});
      const context = buildPreparedContext(createContextEngine({ afterTurn, maintain, dispose }));
      const onContextEngineTurnCandidate = vi.fn();
      context.params.onContextEngineTurnCandidate = onContextEngineTurnCandidate;
      if (missing === "terminal") {
        context.params.userTurnTranscriptRecorder = createAdmittedCliRecorder("cli-user").recorder;
        context.params.persistAssistantTranscript = false;
      }
      prepareCliRunContextMock.mockResolvedValue(context);

      await runCliAgent(context.params);

      expect(onContextEngineTurnCandidate).not.toHaveBeenCalled();
      expect(afterTurn).not.toHaveBeenCalled();
      expect(maintain).toHaveBeenCalledTimes(1);
      expect(dispose).not.toHaveBeenCalled();
    },
  );

  it("uses the admitted user anchor for an accepted transcriptless CLI turn", async () => {
    const context = buildPreparedContext(createContextEngine());
    executePreparedCliRunMock.mockResolvedValue({
      text: "",
      rawText: "",
      didSendViaMessagingTool: true,
      sessionId: "external-cli-session-1",
      usage: { input: 11, output: 0, total: 11 },
      diagnosticUsage: { input: 21, output: 0, total: 21 },
      finalPromptText: "prompt sent to cli",
    });
    const { admission, recorder } = createAdmittedCliRecorder("cli-user");
    const onContextEngineTurnCandidate = vi.fn();
    context.params.onContextEngineTurnCandidate = onContextEngineTurnCandidate;
    context.params.userTurnTranscriptRecorder = recorder;

    await runPreparedCliAgent(context);

    expect(onContextEngineTurnCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        boundary: { admission, terminal: admission },
      }),
    );
  });

  it("uses the admitted user anchor as the terminal for transcriptless room events", async () => {
    const context = buildPreparedContext(createContextEngine());
    const { admission, recorder } = createAdmittedCliRecorder("room-event-user");
    const onContextEngineTurnCandidate = vi.fn();
    context.params.currentInboundEventKind = "room_event";
    context.params.persistAssistantTranscript = false;
    context.params.onContextEngineTurnCandidate = onContextEngineTurnCandidate;
    context.params.userTurnTranscriptRecorder = recorder;

    await runPreparedCliAgent(context);

    expect(onContextEngineTurnCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        boundary: { admission, terminal: admission },
        sessionIdUsed: "openclaw-session-1",
        sessionKey: "agent:main:main",
      }),
    );
  });

  it("does not synthesize a context-engine user turn for empty transcript prompts", async () => {
    const afterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {});
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({ afterTurn, dispose });
    const context = buildPreparedContext(contextEngine);
    context.params.transcriptPrompt = "";
    context.contextEngineTurnPrompt = "";
    await runPreparedCliAgent(context);

    const afterTurnParams = afterTurn.mock.calls[0]?.[0];
    expect(afterTurnParams?.messages).toHaveLength(3);
    expect(afterTurnParams?.prePromptMessageCount).toBe(2);
    expect(afterTurnParams?.messages.slice(0, 2)).toEqual([
      textMessage("user", "old ask", 1),
      textMessage("assistant", "old answer", 2),
    ]);
    const turnMessages = afterTurnParams?.messages.slice(afterTurnParams.prePromptMessageCount);
    expect(turnMessages).toHaveLength(1);
    expectMessageText(turnMessages?.[0], "final answer");
    expect(dispose).not.toHaveBeenCalled();
  });

  it("does not finalize prepared model prompt as transcript turn text", async () => {
    const afterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {});
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({ afterTurn, dispose });
    const context = buildPreparedContext(contextEngine);
    context.params.prompt = "runtime context\n\noriginal user ask";
    delete context.params.transcriptPrompt;
    context.contextEngineTurnPrompt = "original user ask";
    await runPreparedCliAgent(context);

    const afterTurnParams = afterTurn.mock.calls[0]?.[0];
    expect(afterTurnParams?.messages).toHaveLength(4);
    expect(afterTurnParams?.prePromptMessageCount).toBe(2);
    const turnMessages = afterTurnParams?.messages.slice(afterTurnParams.prePromptMessageCount);
    expect(turnMessages).toHaveLength(2);
    expectMessageText(turnMessages?.[0], "original user ask");
    expectMessageText(turnMessages?.[1], "final answer");
    expect(dispose).not.toHaveBeenCalled();
  });

  it("loads unbounded context-engine history separately from hook history", async () => {
    const afterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {});
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({ afterTurn, dispose });
    const context = buildPreparedContext(contextEngine);
    const fullHistory = Array.from({ length: 101 }, (_, index) =>
      textMessage("user", `old ask ${index}`, index),
    );
    loadCliSessionContextEngineMessagesMock.mockResolvedValueOnce(fullHistory);
    await runPreparedCliAgent(context);

    const afterTurnParams = afterTurn.mock.calls[0]?.[0];
    expect(loadCliSessionContextEngineMessagesMock).toHaveBeenCalledTimes(1);
    expect(loadCliSessionHistoryMessagesMock).not.toHaveBeenCalled();
    expect(afterTurnParams?.prePromptMessageCount).toBe(101);
    expect(afterTurnParams?.messages.slice(0, 101)).toEqual(fullHistory);
  });

  it("loads context-engine history after bootstrap lifecycle runs", async () => {
    const postBootstrapHistory = [textMessage("user", "post-bootstrap history", 9)];
    const bootstrap = vi.fn<NonNullable<ContextEngine["bootstrap"]>>(async () => {
      loadCliSessionContextEngineMessagesMock.mockResolvedValueOnce(postBootstrapHistory);
      return { bootstrapped: true };
    });
    const afterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {});
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({ bootstrap, afterTurn, dispose });
    const context = buildPreparedContext(contextEngine);
    await runPreparedCliAgent(context);

    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(loadCliSessionContextEngineMessagesMock).toHaveBeenCalledTimes(1);
    const bootstrapOrder = bootstrap.mock.invocationCallOrder[0];
    const loadHistoryOrder = loadCliSessionContextEngineMessagesMock.mock.invocationCallOrder[0];
    if (typeof bootstrapOrder !== "number" || typeof loadHistoryOrder !== "number") {
      throw new Error("Expected bootstrap and history load invocation order");
    }
    expect(bootstrapOrder).toBeLessThan(loadHistoryOrder);
    const afterTurnParams = afterTurn.mock.calls[0]?.[0];
    expect(afterTurnParams?.prePromptMessageCount).toBe(1);
    expect(afterTurnParams?.messages[0]).toEqual(postBootstrapHistory[0]);
  });

  it("falls back to ingestBatch and still runs turn maintenance", async () => {
    const ingestBatch = vi.fn<NonNullable<ContextEngine["ingestBatch"]>>(async () => ({
      ingestedCount: 2,
    }));
    const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () =>
      createMaintenanceResult(),
    );
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({ ingestBatch, maintain, dispose });
    await runPreparedCliAgent(buildPreparedContext(contextEngine));

    expect(ingestBatch).toHaveBeenCalledTimes(1);
    const ingestBatchParams = ingestBatch.mock.calls[0]?.[0];
    expect(ingestBatchParams).toMatchObject({
      sessionId: "openclaw-session-1",
      sessionKey: "agent:main:main",
    });
    expect(ingestBatchParams?.messages).toHaveLength(2);
    expectMessageText(ingestBatchParams?.messages[0], "transcript visible ask");
    expectMessageText(ingestBatchParams?.messages[1], "final answer");
    expect(maintain).toHaveBeenCalledTimes(2);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("preserves deferred maintenance ownership for background engines", async () => {
    const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () =>
      createMaintenanceResult(),
    );
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({
      info: {
        id: "test-background-context-engine",
        name: "Test background context engine",
        turnMaintenanceMode: "background",
      },
      maintain,
      dispose,
    });
    const context = buildPreparedContext(contextEngine);

    await runPreparedCliAgent(context);

    expect(dispose).not.toHaveBeenCalled();
    await waitForDeferredTurnMaintenanceForSession(context.params.sessionKey);
    expect(maintain).toHaveBeenCalledTimes(2);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("does not dispose background engines when no deferred turn maintenance is queued", async () => {
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({
      info: {
        id: "test-background-context-engine",
        name: "Test background context engine",
        turnMaintenanceMode: "background",
      },
      dispose,
    });
    await runPreparedCliAgent(buildPreparedContext(contextEngine));

    expect(dispose).not.toHaveBeenCalled();
  });

  it("does not dispose background engines after failed CLI attempts", async () => {
    executePreparedCliRunMock.mockRejectedValue(new Error("cli boom"));
    const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () =>
      createMaintenanceResult(),
    );
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({
      info: {
        id: "test-background-context-engine",
        name: "Test background context engine",
        turnMaintenanceMode: "background",
      },
      maintain,
      dispose,
    });
    await expect(runPreparedCliAgent(buildPreparedContext(contextEngine))).rejects.toThrow(
      "cli boom",
    );

    expect(maintain).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("does not finalize or run turn maintenance on failed CLI attempts", async () => {
    executePreparedCliRunMock.mockRejectedValue(new Error("cli boom"));
    const bootstrap = vi.fn<NonNullable<ContextEngine["bootstrap"]>>(async () => ({
      bootstrapped: true,
    }));
    const afterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {});
    const ingestBatch = vi.fn<NonNullable<ContextEngine["ingestBatch"]>>(async () => ({
      ingestedCount: 0,
    }));
    const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () =>
      createMaintenanceResult(),
    );
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({
      bootstrap,
      afterTurn,
      ingestBatch,
      maintain,
      dispose,
    });
    await expect(runPreparedCliAgent(buildPreparedContext(contextEngine))).rejects.toThrow(
      "cli boom",
    );

    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(afterTurn).not.toHaveBeenCalled();
    expect(ingestBatch).not.toHaveBeenCalled();
    expect(maintain).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("does not finalize context-engine turns for empty successful CLI output", async () => {
    executePreparedCliRunMock.mockResolvedValue({
      text: "   ",
      rawText: "   ",
      sessionId: "external-cli-session-empty",
      usage: { input: 11, output: 0, total: 11 },
    });
    const bootstrap = vi.fn<NonNullable<ContextEngine["bootstrap"]>>(async () => ({
      bootstrapped: true,
    }));
    const afterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {});
    const ingestBatch = vi.fn<NonNullable<ContextEngine["ingestBatch"]>>(async () => ({
      ingestedCount: 0,
    }));
    const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () =>
      createMaintenanceResult(),
    );
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({
      bootstrap,
      afterTurn,
      ingestBatch,
      maintain,
      dispose,
    });
    await expect(runPreparedCliAgent(buildPreparedContext(contextEngine))).rejects.toMatchObject({
      name: "FailoverError",
      reason: "empty_response",
      provider: "claude-cli",
      model: "sonnet-4.6",
      sessionId: "openclaw-session-1",
    });

    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(afterTurn).not.toHaveBeenCalled();
    expect(ingestBatch).not.toHaveBeenCalled();
    expect(maintain).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("does not dispose context engines when CLI attempts fail", async () => {
    executePreparedCliRunMock.mockRejectedValue(new Error("cli boom"));
    const dispose = vi.fn(async () => {
      throw new Error("dispose boom");
    });
    const contextEngine = createContextEngine({ dispose });
    await expect(runPreparedCliAgent(buildPreparedContext(contextEngine))).rejects.toThrow(
      "cli boom",
    );

    expect(dispose).not.toHaveBeenCalled();
  });
});
