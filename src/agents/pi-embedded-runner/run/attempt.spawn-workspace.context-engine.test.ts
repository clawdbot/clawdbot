import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.js";
import { buildMemorySystemPromptAddition } from "../../../context-engine/delegate.js";
import {
  clearMemoryPluginState,
  registerMemoryPromptSection,
} from "../../../plugins/memory-state.js";
import {
  type AttemptContextEngine,
  buildLoopPromptCacheInfo,
  assembleAttemptContextEngine,
  buildContextEnginePromptCacheInfo,
  findCurrentAttemptAssistantMessage,
  finalizeAttemptContextEngineTurn,
  resolvePromptCacheTouchTimestamp,
  runAttemptContextEngineBootstrap,
} from "./attempt.context-engine-helpers.js";
import {
  cleanupTempPaths,
  createContextEngineBootstrapAndAssemble,
  createContextEngineAttemptRunner,
  expectCalledWithSessionKey,
  getHoisted,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";
import {
  buildEmbeddedSubscriptionParams,
  cleanupEmbeddedAttemptResources,
} from "./attempt.subscription-cleanup.js";
import type { MidTurnPrecheckRequest } from "./midturn-precheck.js";

const hoisted = getHoisted();
const embeddedSessionId = "embedded-session";
const sessionFile = "/tmp/session.jsonl";
const seedMessage = { role: "user", content: "seed", timestamp: 1 } as AgentMessage;
const doneMessage = { role: "assistant", content: "done", timestamp: 2 } as unknown as AgentMessage;
type AfterTurnPromptCacheCall = { runtimeContext?: { promptCache?: Record<string, unknown> } };
type TrajectoryEvent = { type?: string; data?: Record<string, unknown> };
type ToolResultGuardInstallParams = {
  midTurnPrecheck?: {
    onMidTurnPrecheck?: (request: MidTurnPrecheckRequest) => void;
  };
};

function createTestContextEngine(params: Partial<AttemptContextEngine>): AttemptContextEngine {
  return {
    info: {
      id: "test-context-engine",
      name: "Test Context Engine",
      version: "0.0.1",
    },
    ingest: async () => ({ ingested: true }),
    compact: async () => ({
      ok: false,
      compacted: false,
      reason: "not used in this test",
    }),
    ...params,
  } as AttemptContextEngine;
}

async function runBootstrap(
  sessionKey: string,
  contextEngine: AttemptContextEngine,
  overrides: Partial<Parameters<typeof runAttemptContextEngineBootstrap>[0]> = {},
) {
  await runAttemptContextEngineBootstrap({
    hadSessionFile: true,
    contextEngine,
    sessionId: embeddedSessionId,
    sessionKey,
    sessionFile,
    sessionManager: hoisted.sessionManager,
    runtimeContext: {},
    runMaintenance: hoisted.runContextEngineMaintenanceMock,
    warn: () => {},
    ...overrides,
  });
}

async function runAssemble(
  sessionKey: string,
  contextEngine: AttemptContextEngine,
  overrides: Partial<Parameters<typeof assembleAttemptContextEngine>[0]> = {},
) {
  return await assembleAttemptContextEngine({
    contextEngine,
    sessionId: embeddedSessionId,
    sessionKey,
    messages: [seedMessage],
    tokenBudget: 2048,
    modelId: "gpt-test",
    ...overrides,
  });
}

async function finalizeTurn(
  sessionKey: string,
  contextEngine: AttemptContextEngine,
  overrides: Partial<Parameters<typeof finalizeAttemptContextEngineTurn>[0]> = {},
) {
  await finalizeAttemptContextEngineTurn({
    contextEngine,
    promptError: false,
    aborted: false,
    yieldAborted: false,
    sessionIdUsed: embeddedSessionId,
    sessionKey,
    sessionFile,
    messagesSnapshot: [doneMessage],
    prePromptMessageCount: 0,
    tokenBudget: 2048,
    runtimeContext: {},
    runMaintenance: hoisted.runContextEngineMaintenanceMock,
    sessionManager: hoisted.sessionManager,
    warn: () => {},
    ...overrides,
  });
}

describe("runEmbeddedAttempt context engine sessionKey forwarding", () => {
  const sessionKey = "agent:main:guildchat:channel:test-ctx-engine";
  const tempPaths: string[] = [];
  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    clearMemoryPluginState();
    hoisted.runContextEngineMaintenanceMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    clearMemoryPluginState();
    vi.restoreAllMocks();
  });

  it("sends transcriptPrompt visibly and queues runtime context as hidden custom context", async () => {
    const seen: { prompt?: string; messages?: unknown[]; systemPrompt?: string } = {};

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        prompt: [
          "visible ask",
          "",
          "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
          "secret runtime context",
          "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        ].join("\n"),
        transcriptPrompt: "visible ask",
      },
      sessionPrompt: async (session, prompt) => {
        seen.prompt = prompt;
        seen.messages = [...session.messages];
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(seen.prompt).toBe("visible ask");
    expect(result.finalPromptText).toBe("visible ask");
    expect(seen.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "custom",
          customType: "openclaw.runtime-context",
          display: false,
          content:
            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret runtime context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        }),
      ]),
    );
    expect(JSON.stringify(seen.messages)).not.toContain(
      "OpenClaw runtime context for the immediately preceding user message.",
    );
    expect(JSON.stringify(seen.messages)).not.toContain("not user-authored");
    const trajectoryEvents = (
      await fs.readFile(path.join(tempPaths[0] ?? "", "session.trajectory.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TrajectoryEvent);
    const promptSubmitted = trajectoryEvents.find((event) => event.type === "prompt.submitted");
    const contextCompiled = trajectoryEvents.find((event) => event.type === "context.compiled");
    const modelCompleted = trajectoryEvents.find((event) => event.type === "model.completed");
    const traceArtifacts = trajectoryEvents.find((event) => event.type === "trace.artifacts");

    expect(promptSubmitted?.data?.prompt).toBe("visible ask");
    expect(contextCompiled?.data?.prompt).toBe("visible ask");
    expect(modelCompleted?.data?.finalPromptText).toBe("visible ask");
    expect(traceArtifacts?.data?.finalPromptText).toBe("visible ask");
    for (const value of [
      promptSubmitted?.data?.prompt,
      contextCompiled?.data?.prompt,
      modelCompleted?.data?.finalPromptText,
      traceArtifacts?.data?.finalPromptText,
    ]) {
      expect(String(value)).not.toContain("OPENCLAW_INTERNAL_CONTEXT");
      expect(String(value)).not.toContain("secret runtime context");
    }
  });

  it("marks inter-session transcriptPrompt before submitting the visible prompt", async () => {
    let seenPrompt: string | undefined;

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        prompt: [
          "visible ask",
          "",
          "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
          "secret runtime context",
          "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        ].join("\n"),
        transcriptPrompt: "visible ask",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:discord:source",
          sourceTool: "sessions_send",
        },
      },
      sessionPrompt: async (session, prompt) => {
        seenPrompt = prompt;
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(seenPrompt).toMatch(/^\[Inter-session message\]/);
    expect(seenPrompt).toContain("isUser=false");
    expect(seenPrompt).toContain("visible ask");
    expect(result.finalPromptText).toBe(seenPrompt);
  });

  it("submits runtime-only context through system prompt without visible prompt", async () => {
    let seenPrompt: string | undefined;

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        prompt: "internal heartbeat event",
        transcriptPrompt: "",
      },
      sessionPrompt: async (session, prompt) => {
        seenPrompt = prompt;
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(seenPrompt).toBe("Continue the OpenClaw runtime event.");
    expect(result.finalPromptText).toBe("Continue the OpenClaw runtime event.");
    expect(result.messagesSnapshot).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("internal heartbeat event"),
        }),
      ]),
    );
    const trajectoryEvents = (
      await fs.readFile(path.join(tempPaths[0] ?? "", "session.trajectory.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TrajectoryEvent);
    const contextCompiled = trajectoryEvents.find((event) => event.type === "context.compiled");
    expect(contextCompiled?.data?.prompt).toBe("Continue the OpenClaw runtime event.");
    expect(contextCompiled?.data?.systemPrompt).toContain("internal heartbeat event");
  });

  it("skips blank visible prompts with replay history before provider submission", async () => {
    const sessionPrompt = vi.fn(async () => {
      throw new Error("blank prompt should not be submitted");
    });

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        prompt: "  \n\t  ",
      },
      sessionPrompt,
    });

    expect(sessionPrompt).not.toHaveBeenCalled();
    expect(result.finalPromptText).toBeUndefined();
    expect(result.promptError).toBeFalsy();
    expect(result.messagesSnapshot).toEqual([
      expect.objectContaining({ role: "user", content: "seed" }),
    ]);
    const trajectoryEvents = (
      await fs.readFile(path.join(tempPaths[0] ?? "", "session.trajectory.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TrajectoryEvent);
    expect(trajectoryEvents.some((event) => event.type === "prompt.submitted")).toBe(false);
    expect(trajectoryEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "prompt.skipped",
          data: expect.objectContaining({ reason: "blank_user_prompt" }),
        }),
      ]),
    );
  });

  it("uses assembled context as the default precheck authority", async () => {
    let sawPrompt = false;
    const hugeHistory = "large raw history ".repeat(25_000);

    const result = await createContextEngineAttemptRunner({
      contextEngine: createTestContextEngine({
        assemble: async () => ({
          messages: [
            { role: "user", content: "small assembled context", timestamp: 1 },
          ] as AgentMessage[],
          estimatedTokens: 8,
        }),
      }),
      sessionKey,
      tempPaths,
      sessionMessages: [{ role: "user", content: hugeHistory, timestamp: 1 }] as AgentMessage[],
      attemptOverrides: {
        contextTokenBudget: 500,
      },
      sessionPrompt: async (session) => {
        sawPrompt = true;
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(sawPrompt).toBe(true);
    expect(result.promptError).toBeNull();
    expect(result.promptErrorSource).toBeNull();
    expect(hoisted.preemptiveCompactionCalls.at(-1)).not.toHaveProperty("unwindowedMessages");
  });

  it("honors context engines that opt into preassembly overflow authority", async () => {
    let sawPrompt = false;
    const hugeHistory = "large raw history ".repeat(25_000);

    const result = await createContextEngineAttemptRunner({
      contextEngine: createTestContextEngine({
        assemble: async () => ({
          messages: [
            { role: "user", content: "small assembled context", timestamp: 1 },
          ] as AgentMessage[],
          estimatedTokens: 8,
          promptAuthority: "preassembly_may_overflow",
        }),
      }),
      sessionKey,
      tempPaths,
      sessionMessages: [{ role: "user", content: hugeHistory, timestamp: 1 }] as AgentMessage[],
      attemptOverrides: {
        contextTokenBudget: 500,
      },
      sessionPrompt: async (session) => {
        sawPrompt = true;
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(sawPrompt).toBe(false);
    expect(result.promptErrorSource).toBe("precheck");
    expect(result.preflightRecovery?.route).toBe("compact_only");
    expect(hoisted.preemptiveCompactionCalls.at(-1)).toHaveProperty("unwindowedMessages");
  });

  it("snapshots pre-assembly messages before assemble even when the engine windows in place", async () => {
    const hugeHistory = "large raw history ".repeat(25_000);
    const preassemblyMarker = { role: "user", content: hugeHistory, timestamp: 1 } as AgentMessage;

    await createContextEngineAttemptRunner({
      contextEngine: createTestContextEngine({
        assemble: async ({ messages }: { messages: AgentMessage[] }) => {
          // Simulate an engine that windows the input array IN PLACE.
          // The assemble contract does not require immutability, so the
          // runner must have already snapshotted before calling us.
          messages.length = 0;
          messages.push({ role: "user", content: "windowed", timestamp: 2 } as AgentMessage);
          return {
            messages: [
              { role: "user", content: "small assembled context", timestamp: 1 },
            ] as AgentMessage[],
            estimatedTokens: 8,
            promptAuthority: "preassembly_may_overflow",
          };
        },
      }),
      sessionKey,
      tempPaths,
      sessionMessages: [preassemblyMarker],
      attemptOverrides: {
        contextTokenBudget: 500,
      },
      sessionPrompt: async (session) => {
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 3 },
        ];
      },
    });

    const lastCall = hoisted.preemptiveCompactionCalls.at(-1);
    expect(lastCall).toHaveProperty("unwindowedMessages");
    const unwindowed = (lastCall as { unwindowedMessages?: AgentMessage[] }).unwindowedMessages;
    // The snapshot must reflect the true pre-assembly state, not the in-place
    // windowed array that assemble mutated.
    expect(unwindowed).toEqual([preassemblyMarker]);
  });

  it("keeps gateway model runs independent from agent context and session history", async () => {
    const bootstrap = vi.fn(async () => ({ bootstrapped: true }));
    const assemble = vi.fn(async ({ messages }: { messages: AgentMessage[] }) => ({
      messages: [
        ...messages,
        { role: "custom", customType: "test-context", content: "should not be sent" },
      ] as AgentMessage[],
      estimatedTokens: 1,
    }));
    const afterTurn = vi.fn(async () => {});
    const runBeforePromptBuild = vi.fn(async () => ({ prependContext: "hook context" }));
    const runLlmInput = vi.fn(async () => {});
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn(
        (name: string) =>
          name === "before_prompt_build" || name === "before_agent_start" || name === "llm_input",
      ),
      runBeforePromptBuild,
      runBeforeAgentStart: vi.fn(async () => ({ prependContext: "legacy hook context" })),
      runLlmInput,
    });
    const seen: { prompt?: string; messages?: unknown[]; systemPrompt?: string } = {};

    const result = await createContextEngineAttemptRunner({
      contextEngine: createTestContextEngine({
        bootstrap,
        assemble,
        afterTurn,
      }),
      sessionKey,
      tempPaths,
      sessionMessages: [
        { role: "user", content: "old session question", timestamp: 1 },
        { role: "assistant", content: "old session answer", timestamp: 2 },
      ] as AgentMessage[],
      attemptOverrides: {
        promptMode: "none",
        disableTools: true,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:discord:source",
          sourceTool: "sessions_send",
        },
      },
      sessionPrompt: async (session, prompt) => {
        seen.prompt = prompt;
        seen.messages = [...session.messages];
        seen.systemPrompt = session.agent.state.systemPrompt;
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "pong", timestamp: 3 },
        ];
      },
    });

    expect(seen.prompt).toBe("hello");
    expect(seen.prompt).not.toContain("[Inter-session message]");
    expect(seen.messages).toEqual([]);
    expect(seen.systemPrompt ?? "").toBe("");
    expect(result.finalPromptText).toBe("hello");
    expect(result.systemPromptReport?.systemPrompt ?? "").toBe("");
    expect(result.messagesSnapshot).toEqual([
      expect.objectContaining({ role: "assistant", content: "pong" }),
    ]);
    expect(hoisted.resolveBootstrapContextForRunMock).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
    expect(afterTurn).not.toHaveBeenCalled();
    expect(runBeforePromptBuild).not.toHaveBeenCalled();
    expect(runLlmInput).not.toHaveBeenCalled();
  });

  it("forwards sessionKey to bootstrap, assemble, and afterTurn", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const afterTurn = vi.fn(async (_params: { sessionKey?: string }) => {});
    const contextEngine = createTestContextEngine({
      bootstrap,
      assemble,
      afterTurn,
    });

    await runBootstrap(sessionKey, contextEngine);
    await runAssemble(sessionKey, contextEngine);
    await finalizeTurn(sessionKey, contextEngine);

    expectCalledWithSessionKey(bootstrap, sessionKey);
    expectCalledWithSessionKey(assemble, sessionKey);
    expectCalledWithSessionKey(afterTurn, sessionKey);
  });

  it("resolves bootstrap context before acquiring the session write lock", async () => {
    const events: string[] = [];
    hoisted.resolveBootstrapContextForRunMock.mockImplementation(async () => {
      events.push("bootstrap");
      return { bootstrapFiles: [], contextFiles: [] };
    });
    hoisted.acquireSessionWriteLockMock.mockImplementation(async () => {
      events.push("lock");
      return { release: async () => {} };
    });

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
    });

    expect(events).toEqual(expect.arrayContaining(["bootstrap", "lock"]));
    expect(events.indexOf("bootstrap")).toBeLessThan(events.indexOf("lock"));
  });

  it("forwards modelId to assemble", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const contextEngine = createTestContextEngine({ bootstrap, assemble });

    await runBootstrap(sessionKey, contextEngine);
    await runAssemble(sessionKey, contextEngine);

    expect(assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-test",
      }),
    );
  });

  it("forwards availableTools and citationsMode to assemble", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const contextEngine = createTestContextEngine({ bootstrap, assemble });

    await runBootstrap(sessionKey, contextEngine);
    await runAssemble(sessionKey, contextEngine, {
      availableTools: new Set(["memory_search", "wiki_search"]),
      citationsMode: "on",
    });

    expect(assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        availableTools: new Set(["memory_search", "wiki_search"]),
        citationsMode: "on",
      }),
    );
  });

  it("lets non-legacy engines opt into the active memory prompt helper", async () => {
    registerMemoryPromptSection(({ availableTools, citationsMode }) => {
      if (!availableTools.has("memory_search")) {
        return [];
      }
      return [
        "## Memory Recall",
        `tools=${[...availableTools].toSorted().join(",")}`,
        `citations=${citationsMode ?? "auto"}`,
        "",
      ];
    });

    const contextEngine = createTestContextEngine({
      assemble: async ({ messages, availableTools, citationsMode }) => ({
        messages,
        estimatedTokens: messages.length,
        systemPromptAddition: buildMemorySystemPromptAddition({
          availableTools: availableTools ?? new Set(),
          citationsMode,
        }),
      }),
    });

    const result = await runAssemble(sessionKey, contextEngine, {
      availableTools: new Set(["wiki_search", "memory_search"]),
      citationsMode: "on",
    });

    expect(result).toMatchObject({
      estimatedTokens: 1,
      systemPromptAddition: "## Memory Recall\ntools=memory_search,wiki_search\ncitations=on",
    });
  });

  it("forwards sessionKey to ingestBatch when afterTurn is absent", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const ingestBatch = vi.fn(
      async (_params: { sessionKey?: string; messages: AgentMessage[] }) => ({ ingestedCount: 1 }),
    );

    await finalizeTurn(sessionKey, createTestContextEngine({ bootstrap, assemble, ingestBatch }), {
      messagesSnapshot: [seedMessage, doneMessage],
      prePromptMessageCount: 1,
    });

    expectCalledWithSessionKey(ingestBatch, sessionKey);
  });

  it("forwards sessionKey to per-message ingest when ingestBatch is absent", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const ingest = vi.fn(async (_params: { sessionKey?: string; message: AgentMessage }) => ({
      ingested: true,
    }));

    await finalizeTurn(sessionKey, createTestContextEngine({ bootstrap, assemble, ingest }), {
      messagesSnapshot: [seedMessage, doneMessage],
      prePromptMessageCount: 1,
    });

    expect(ingest).toHaveBeenCalled();
    expect(
      ingest.mock.calls.every((call) => {
        const params = call[0];
        return params.sessionKey === sessionKey;
      }),
    ).toBe(true);
  });

  it("forwards silentExpected to the embedded subscription", async () => {
    const params = buildEmbeddedSubscriptionParams({
      session: {} as never,
      runId: "run-context-engine-forwarding",
      hookRunner: undefined,
      verboseLevel: undefined,
      reasoningMode: "off",
      toolResultFormat: undefined,
      shouldEmitToolResult: undefined,
      shouldEmitToolOutput: undefined,
      onToolResult: undefined,
      onReasoningStream: undefined,
      onReasoningEnd: undefined,
      onBlockReply: undefined,
      onBlockReplyFlush: undefined,
      blockReplyBreak: undefined,
      blockReplyChunking: undefined,
      onPartialReply: undefined,
      onAssistantMessageStart: undefined,
      onAgentEvent: undefined,
      enforceFinalTag: undefined,
      silentExpected: true,
      config: undefined,
      sessionKey,
      sessionId: embeddedSessionId,
      agentId: "main",
    });

    expect(params.silentExpected).toBe(true);
    expect(params.sessionKey).toBe(sessionKey);
  });

  it("skips maintenance when afterTurn fails", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const afterTurn = vi.fn(async () => {
      throw new Error("afterTurn failed");
    });

    await finalizeTurn(sessionKey, createTestContextEngine({ bootstrap, assemble, afterTurn }));

    expect(afterTurn).toHaveBeenCalled();
    expect(hoisted.runContextEngineMaintenanceMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "turn" }),
    );
  });

  it("runs startup maintenance for existing sessions even without bootstrap()", async () => {
    const { assemble } = createContextEngineBootstrapAndAssemble();

    await runBootstrap(
      sessionKey,
      createTestContextEngine({
        assemble,
        maintain: async () => ({
          changed: false,
          bytesFreed: 0,
          rewrittenEntries: 0,
          reason: "test maintenance",
        }),
      }),
    );

    expect(hoisted.runContextEngineMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "bootstrap" }),
    );
  });

  it("builds prompt-cache retention, last-call usage, and cache-touch metadata", () => {
    expect(
      buildContextEnginePromptCacheInfo({
        retention: "short",
        lastCallUsage: {
          input: 10,
          output: 5,
          cacheRead: 40,
          cacheWrite: 2,
          total: 57,
        },
        lastCacheTouchAt: 123,
      }),
    ).toEqual(
      expect.objectContaining({
        retention: "short",
        lastCallUsage: {
          input: 10,
          output: 5,
          cacheRead: 40,
          cacheWrite: 2,
          total: 57,
        },
        lastCacheTouchAt: 123,
      }),
    );
  });

  it("omits prompt-cache metadata when no cache data is available", () => {
    expect(buildContextEnginePromptCacheInfo({})).toBeUndefined();
  });

  it("does not reuse a prior turn's usage when the current attempt has no assistant", () => {
    const priorAssistant = {
      role: "assistant",
      content: "prior turn",
      timestamp: 2,
      usage: {
        input: 99,
        output: 7,
        cacheRead: 1234,
        total: 1340,
      },
    } as unknown as AgentMessage;
    const currentAttemptAssistant = findCurrentAttemptAssistantMessage({
      messagesSnapshot: [seedMessage, priorAssistant],
      prePromptMessageCount: 2,
    });
    const promptCache = buildContextEnginePromptCacheInfo({
      retention: "short",
      lastCallUsage: (currentAttemptAssistant as { usage?: undefined } | undefined)?.usage,
    });

    expect(currentAttemptAssistant).toBeUndefined();
    expect(promptCache).toEqual({ retention: "short" });
  });

  it("derives live loop prompt-cache info from the current attempt assistant", () => {
    const toolUseAssistant = {
      role: "assistant",
      content: "tool use",
      timestamp: "2026-04-16T16:49:59.536Z",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 39036,
        cacheWrite: 59934,
        total: 98973,
      },
    } as unknown as AgentMessage;

    expect(
      buildLoopPromptCacheInfo({
        messagesSnapshot: [seedMessage, toolUseAssistant],
        prePromptMessageCount: 1,
        retention: "short",
        fallbackLastCacheTouchAt: 123,
      }),
    ).toEqual(
      expect.objectContaining({
        retention: "short",
        lastCallUsage: expect.objectContaining({
          cacheRead: 39036,
          cacheWrite: 59934,
          total: 98973,
        }),
        lastCacheTouchAt: Date.parse("2026-04-16T16:49:59.536Z"),
      }),
    );
  });

  it("falls back to the persisted cache touch when loop usage has no cache metrics", () => {
    const toolUseAssistant = {
      role: "assistant",
      content: "tool use",
      timestamp: "2026-04-16T16:49:59.536Z",
      usage: {
        input: 1,
        output: 2,
        total: 3,
      },
    } as unknown as AgentMessage;

    expect(
      buildLoopPromptCacheInfo({
        messagesSnapshot: [seedMessage, toolUseAssistant],
        prePromptMessageCount: 1,
        retention: "short",
        fallbackLastCacheTouchAt: 123,
      }),
    ).toEqual(
      expect.objectContaining({
        retention: "short",
        lastCallUsage: expect.objectContaining({
          total: 3,
        }),
        lastCacheTouchAt: 123,
      }),
    );
  });

  it("derives a live cache touch timestamp for final afterTurn usage snapshots", () => {
    const lastCallUsage = {
      input: 1,
      output: 2,
      cacheRead: 39036,
      cacheWrite: 0,
      total: 39039,
    };

    expect(
      resolvePromptCacheTouchTimestamp({
        lastCallUsage,
        assistantTimestamp: "2026-04-16T17:04:46.974Z",
        fallbackLastCacheTouchAt: 123,
      }),
    ).toBe(Date.parse("2026-04-16T17:04:46.974Z"));
  });

  it("threads prompt-cache break observations into afterTurn", async () => {
    const afterTurn = vi.fn(async (_params: AfterTurnPromptCacheCall) => {});

    await finalizeTurn(sessionKey, createTestContextEngine({ afterTurn }), {
      runtimeContext: {
        promptCache: {
          observation: {
            broke: true,
            previousCacheRead: 5000,
            cacheRead: 2000,
            changes: [{ code: "systemPrompt", detail: "system prompt digest changed" }],
          },
        },
      },
    });

    const afterTurnCall = afterTurn.mock.calls.at(0)?.[0];
    const runtimeContext = afterTurnCall?.runtimeContext;
    const observation = runtimeContext?.promptCache?.observation as
      | { broke?: boolean; previousCacheRead?: number; cacheRead?: number; changes?: unknown[] }
      | undefined;

    expect(observation).toEqual(
      expect.objectContaining({
        broke: true,
        previousCacheRead: 5000,
        cacheRead: 2000,
        changes: expect.arrayContaining([expect.objectContaining({ code: "systemPrompt" })]),
      }),
    );
  });

  it("skips maintenance when ingestBatch fails", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const ingestBatch = vi.fn(async () => {
      throw new Error("ingestBatch failed");
    });

    await finalizeTurn(sessionKey, createTestContextEngine({ bootstrap, assemble, ingestBatch }), {
      messagesSnapshot: [seedMessage, doneMessage],
      prePromptMessageCount: 1,
    });

    expect(ingestBatch).toHaveBeenCalled();
    expect(hoisted.runContextEngineMaintenanceMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "turn" }),
    );
  });

  it("releases the session lock even when teardown cleanup throws", async () => {
    const releaseMock = vi.fn(async () => {});
    const disposeMock = vi.fn();
    const flushMock = vi.fn(async () => {
      throw new Error("flush failed");
    });

    await cleanupEmbeddedAttemptResources({
      removeToolResultContextGuard: () => {},
      flushPendingToolResultsAfterIdle: flushMock,
      session: { agent: {}, dispose: disposeMock },
      sessionManager: hoisted.sessionManager,
      releaseWsSession: hoisted.releaseWsSessionMock,
      sessionId: embeddedSessionId,
      bundleLspRuntime: undefined,
      sessionLock: { release: releaseMock },
    });

    expect(flushMock).toHaveBeenCalledTimes(1);
    expect(disposeMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(hoisted.releaseWsSessionMock).toHaveBeenCalledWith("embedded-session", {
      allowPool: false,
    });
  });
});

describe("runEmbeddedAttempt context engine mid-turn precheck integration", () => {
  const sessionKey = "agent:main:guildchat:channel:midturn-precheck";
  const tempPaths: string[] = [];

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    clearMemoryPluginState();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    clearMemoryPluginState();
    vi.restoreAllMocks();
  });

  it("keeps mid-turn precheck out of the context-engine-owned compaction hook", async () => {
    await createContextEngineAttemptRunner({
      contextEngine: {
        ...createContextEngineBootstrapAndAssemble(),
        info: { ownsCompaction: true },
      },
      sessionKey,
      tempPaths,
      attemptOverrides: {
        config: {
          agents: {
            defaults: {
              compaction: {
                mode: "safeguard",
                midTurnPrecheck: { enabled: true },
              },
            },
          },
        } as OpenClawConfig,
      },
    });

    expect(hoisted.installContextEngineLoopHookMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ midTurnPrecheck: expect.anything() }),
    );
  });

  it("recovers when Pi persists the mid-turn precheck as an assistant error", async () => {
    hoisted.installToolResultContextGuardMock.mockImplementation((...args: unknown[]) => {
      const params = args[0] as ToolResultGuardInstallParams;
      params.midTurnPrecheck?.onMidTurnPrecheck?.({
        route: "compact_only",
        estimatedPromptTokens: 9000,
        promptBudgetBeforeReserve: 7000,
        overflowTokens: 2000,
        toolResultReducibleChars: 0,
        effectiveReserveTokens: 1000,
      });
      return () => {};
    });

    const syntheticPiError = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stopReason: "error",
      errorMessage: "Context overflow: prompt too large for the model (mid-turn precheck).",
      timestamp: 3,
    } as unknown as AgentMessage;

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        config: {
          agents: {
            defaults: {
              compaction: {
                mode: "safeguard",
                midTurnPrecheck: { enabled: true },
              },
            },
          },
        } as OpenClawConfig,
      },
      sessionMessages: [seedMessage],
      sessionPrompt: async (session) => {
        session.messages = [...session.messages, syntheticPiError];
      },
    });

    expect(result.promptErrorSource).toBe("precheck");
    expect(result.preflightRecovery).toEqual({ route: "compact_only", source: "mid-turn" });
    expect(result.messagesSnapshot).toEqual([seedMessage]);
  });
});

describe("runEmbeddedAttempt tool-result guard budget wiring", () => {
  const sessionKey = "agent:main:guildchat:channel:tool-result-guard-budget";
  const tempPaths: string[] = [];

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    clearMemoryPluginState();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    clearMemoryPluginState();
    vi.restoreAllMocks();
  });

  it("uses the resolved contextTokenBudget before model contextWindow", async () => {
    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        contextTokenBudget: 1_000_000,
        model: {
          api: "openai-completions",
          provider: "openai",
          compat: {},
          contextWindow: 200_000,
          input: ["text"],
        } as never,
      },
    });

    expect(hoisted.installToolResultContextGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contextWindowTokens: 1_000_000,
      }),
    );
  });
});
