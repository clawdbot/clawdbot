// Coverage for context-engine bootstrap, assembly, and turn finalization.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_TRANSCRIPT_PROMPT } from "../../../auto-reply/heartbeat.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { buildMemorySystemPromptAddition } from "../../../context-engine/delegate.js";
import {
  clearMemoryPluginState,
  registerMemoryPromptSection,
} from "../../../plugins/memory-state.js";
import {
  addSubagentRunForTests,
  leasePendingAgentSteeringItems,
  releasePendingAgentSteeringItems,
  resetSubagentRegistryForTests,
} from "../../subagent-registry.js";
import type { SubagentRunRecord } from "../../subagent-registry.types.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
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
import { EmbeddedAttemptSessionTakeoverError } from "./attempt.session-lock.js";
import {
  cleanupTempPaths,
  createDefaultEmbeddedSession,
  createContextEngineBootstrapAndAssemble,
  createContextEngineAttemptRunner,
  expectCalledWithSessionKey,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
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

beforeAll(async () => {
  await preloadRunEmbeddedAttemptForTests();
});
type AfterTurnPromptCacheCall = { runtimeContext?: { promptCache?: Record<string, unknown> } };
type TrajectoryEvent = { type?: string; data?: Record<string, unknown> };
type ToolResultGuardInstallParams = {
  midTurnPrecheck?: {
    onMidTurnPrecheck?: (request: MidTurnPrecheckRequest) => void;
  };
};
type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireRecords(value: unknown, label: string): Array<Record<string, unknown>> {
  expect(value, label).toBeInstanceOf(Array);
  return value as Array<Record<string, unknown>>;
}

function sumToolResultTextChars(messages: AgentMessage[]): number {
  // Context-engine budget tests need deterministic text size accounting for
  // toolResult blocks.
  return messages.reduce((sum, message) => {
    if (message.role !== "toolResult") {
      return sum;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      return sum;
    }
    return (
      sum +
      content.reduce((blockSum, block) => {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          return blockSum + (block as { text: string }).text.length;
        }
        return blockSum;
      }, 0)
    );
  }, 0);
}

function findRecord(
  records: Array<Record<string, unknown>>,
  predicate: (record: Record<string, unknown>) => boolean,
  label: string,
) {
  const record = records.find(predicate);
  if (!record) {
    throw new Error(`expected record: ${label}`);
  }
  return record;
}

function mockArg(source: MockCallSource, callIndex: number, argIndex: number, label: string) {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call: ${label}`);
  }
  if (argIndex >= call.length) {
    throw new Error(`expected mock call argument ${argIndex}: ${label}`);
  }
  return call[argIndex];
}

function mockParams(source: MockCallSource, callIndex: number, label: string) {
  return requireRecord(mockArg(source, callIndex, 0, label), label);
}

function expectFields(actual: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key], key).toEqual(value);
  }
}

function trackSessionWriteLocks(): string[] {
  // Context-engine finalization writes should release and reacquire transcript
  // locks in a predictable order.
  const events: string[] = [];
  hoisted.acquireSessionWriteLockMock.mockImplementation(async () => {
    const lockId = hoisted.acquireSessionWriteLockMock.mock.calls.length;
    events.push(`acquire-${lockId}`);
    return {
      release: async () => {
        events.push(`release-${lockId}`);
      },
    };
  });
  return events;
}

function expectInitialLockReleasedBeforePostTurnWrite(events: string[]) {
  expect(events.indexOf("release-1")).toBeGreaterThan(events.indexOf("acquire-1"));
  expect(events.indexOf("acquire-2")).toBeGreaterThan(events.indexOf("release-1"));
  expect(events.indexOf("release-2")).toBeGreaterThan(events.indexOf("acquire-2"));
}

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
  // Shared bootstrap harness keeps session identifiers stable across context
  // engine implementations.
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
  let toolSearchControlsCase: Record<string, unknown>;

  beforeAll(async () => {
    resetEmbeddedAttemptHarness();
    clearMemoryPluginState();
    hoisted.runContextEngineMaintenanceMock.mockReset().mockResolvedValue(undefined);
    hoisted.detectAndLoadPromptImagesMock.mockClear();
    const setupTempPaths: string[] = [];
    try {
      await createContextEngineAttemptRunner({
        contextEngine: {
          assemble: async ({ messages }) => ({ messages, estimatedTokens: 1 }),
        },
        sessionKey,
        tempPaths: setupTempPaths,
        attemptOverrides: {
          disableTools: false,
          config: {
            tools: {
              toolSearch: true,
            },
          } as OpenClawConfig,
        },
      });

      toolSearchControlsCase = mockParams(
        hoisted.createOpenClawCodingToolsMock,
        0,
        "createOpenClawCodingTools options",
      );
    } finally {
      await cleanupTempPaths(setupTempPaths);
      clearMemoryPluginState();
      vi.restoreAllMocks();
    }
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    clearMemoryPluginState();
    hoisted.runContextEngineMaintenanceMock.mockReset().mockResolvedValue(undefined);
    hoisted.detectAndLoadPromptImagesMock.mockClear();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    clearMemoryPluginState();
    vi.restoreAllMocks();
  });

  it("enables Tool Search controls for embedded OpenClaw runs when configured", async () => {
    expect(toolSearchControlsCase.includeToolSearchControls).toBe(true);
    expect(toolSearchControlsCase.toolSearchCatalogRef).toEqual({});
  });

  it("keeps client tool names out of context engine capability guidance", async () => {
    const contextEngine = createContextEngineBootstrapAndAssemble();

    await createContextEngineAttemptRunner({
      contextEngine,
      sessionKey,
      tempPaths,
      attemptOverrides: {
        disableTools: false,
        config: {
          tools: {
            toolSearch: { enabled: true, mode: "directory" },
          },
        } as OpenClawConfig,
        clientTools: [
          {
            type: "function",
            function: {
              name: "memory_search",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
    });

    const assembleParams = mockParams(
      contextEngine.assemble as MockCallSource,
      0,
      "assemble params",
    );
    const availableTools = assembleParams.availableTools;
    expect(availableTools).toBeInstanceOf(Set);
    expect((availableTools as Set<string>).has("memory_search")).toBe(false);
  });

  it("keeps pending parent steering queued during commitment-only runs", async () => {
    const childRunId = "queued-child-run";
    const frozenResultText = "queued child result for the next normal turn";
    const endedAt = Date.now() - 1_000;
    const pendingRun: SubagentRunRecord = {
      runId: childRunId,
      childSessionKey: `agent:main:subagent:${childRunId}`,
      requesterSessionKey: sessionKey,
      requesterDisplayKey: sessionKey,
      task: "inspect the parent flow",
      cleanup: "delete",
      createdAt: endedAt - 1_000,
      endedAt,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
      completion: { required: true, resultText: frozenResultText },
      delivery: {
        status: "pending",
        createdAt: endedAt + 1,
        payload: {
          requesterSessionKey: sessionKey,
          requesterDisplayKey: sessionKey,
          childSessionKey: `agent:main:subagent:${childRunId}`,
          childRunId,
          task: "inspect the parent flow",
          endedAt,
          outcome: { status: "ok" },
          expectsCompletionMessage: true,
          frozenResultText,
        },
      },
    };
    let submittedPrompt = "";
    resetSubagentRegistryForTests({ persist: false });
    addSubagentRunForTests(pendingRun);

    try {
      await createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey,
        tempPaths,
        attemptOverrides: {
          bootstrapContextRunKind: "commitment-only",
          trigger: "heartbeat",
        },
        sessionPrompt: async (_session, prompt) => {
          submittedPrompt = prompt;
        },
      });

      expect(submittedPrompt).not.toContain(frozenResultText);
      const leaseId = "next-normal-turn";
      const retained = leasePendingAgentSteeringItems({
        requesterSessionKey: sessionKey,
        leaseId,
      });
      expect(retained?.runIds).toEqual([childRunId]);
      expect(retained?.prompt).toContain(frozenResultText);
      releasePendingAgentSteeringItems({ runIds: [childRunId], leaseId });
    } finally {
      resetSubagentRegistryForTests({ persist: false });
    }
  });

  it("defaults local-model lean embedded runs to Tool Search controls", async () => {
    await createContextEngineAttemptRunner({
      contextEngine: {
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 1 }),
      },
      sessionKey,
      tempPaths,
      attemptOverrides: {
        disableTools: false,
        config: {
          agents: {
            defaults: {
              experimental: {
                localModelLean: true,
              },
            },
          },
        } as OpenClawConfig,
      },
    });

    expect(hoisted.createOpenClawCodingToolsMock).toHaveBeenCalledTimes(1);
    const options = mockParams(
      hoisted.createOpenClawCodingToolsMock,
      0,
      "createOpenClawCodingTools options",
    );
    expect(options.includeToolSearchControls).toBe(true);
    const optionsConfig = requireRecord(options.config, "createOpenClawCodingTools config");
    const toolsConfig = requireRecord(
      optionsConfig.tools,
      "createOpenClawCodingTools tools config",
    );
    expect(toolsConfig.toolSearch).toEqual({
      enabled: true,
      mode: "tools",
      searchDefaultLimit: 5,
      maxSearchLimit: 10,
    });
  });

  it("keeps Tool Search controls off for lean message-tool-only delivery", async () => {
    hoisted.createOpenClawCodingToolsMock.mockReturnValueOnce([
      {
        name: "message",
        label: "Message",
        description: "Send a visible reply.",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ text: "sent" }),
      },
      {
        name: "browser",
        label: "Browser",
        description: "Open a browser session.",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ text: "opened" }),
      },
    ]);

    await createContextEngineAttemptRunner({
      contextEngine: {
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 1 }),
      },
      sessionKey,
      tempPaths,
      attemptOverrides: {
        disableTools: false,
        sourceReplyDeliveryMode: "message_tool_only",
        config: {
          agents: {
            defaults: {
              experimental: {
                localModelLean: true,
              },
            },
          },
        } as OpenClawConfig,
      },
    });

    expect(hoisted.createOpenClawCodingToolsMock).toHaveBeenCalledTimes(1);
    const options = mockParams(
      hoisted.createOpenClawCodingToolsMock,
      0,
      "createOpenClawCodingTools options",
    );
    expect(options.includeToolSearchControls).toBe(false);
    const sessionOptions = mockParams(
      hoisted.createAgentSessionMock,
      0,
      "createAgentSession options",
    );
    const customTools = requireRecords(sessionOptions.customTools, "customTools");
    expect(customTools.map((tool) => tool.name)).toEqual(["message"]);
  });

  it("quarantines unsupported tool schemas before creating the model session", async () => {
    hoisted.createOpenClawCodingToolsMock.mockReturnValue([
      {
        name: "healthy_lookup",
        label: "Healthy Lookup",
        description: "Look up safe data.",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ text: "ok" }),
      },
      {
        name: "fuzzplugin_move_angles",
        label: "Fuzzplugin Move Angles",
        description: "Move robot joints.",
        parameters: {
          type: "object",
          properties: {
            target: { $dynamicRef: "#target" },
          },
        },
        execute: async () => ({ text: "bad" }),
      },
    ]);

    const activeToolNames: string[][] = [];
    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        disableTools: false,
        config: {
          tools: {
            codeMode: { enabled: false },
            toolSearch: false,
          },
        } as OpenClawConfig,
      },
      createSession: () => {
        const session = createDefaultEmbeddedSession();
        session.setActiveToolsByName = (toolNames) => {
          activeToolNames.push([...toolNames]);
        };
        return session;
      },
    });

    const sessionOptions = mockParams(
      hoisted.createAgentSessionMock,
      0,
      "createAgentSession options",
    );
    const customTools = requireRecords(sessionOptions.customTools, "customTools");
    expect(customTools.map((tool) => tool.name)).toEqual(["healthy_lookup"]);
    expect(activeToolNames).toEqual([["healthy_lookup"]]);
  });

  it("keeps the embedded system prompt after active tool selection", async () => {
    let seenSystemPrompt: string | undefined;

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      sessionMessages: [seedMessage],
      sessionPrompt: async (activeSession) => {
        seenSystemPrompt = activeSession.agent.state.systemPrompt;
      },
    });

    expect(seenSystemPrompt).toBe("system prompt");
  });

  it("enforces code-mode payload surface from active-agent config during an embedded attempt", async () => {
    const observedOptions: Array<Record<string, unknown>> = [];
    const payloads: Array<Record<string, unknown>> = [];

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:ops:guildchat:channel:test-code-mode",
      tempPaths,
      attemptOverrides: {
        agentId: "ops",
        disableTools: false,
        config: {
          tools: {
            codeMode: { enabled: false },
          },
          agents: {
            list: [{ id: "ops", tools: { codeMode: true } }],
          },
        } as OpenClawConfig,
        model: {
          api: "openai-chatgpt-responses",
          provider: "gateway",
          id: "gpt-5.5",
          contextWindow: 8192,
          input: ["text"],
        } as never,
      },
      createSession: () => {
        const session = createDefaultEmbeddedSession();
        session.agent.streamFn = async (_model, _context, options) => {
          observedOptions.push(options as Record<string, unknown>);
          const payload: Record<string, unknown> = {
            tools: [
              { type: "function", name: "exec" },
              { type: "function", name: "wait" },
              { type: "function", name: "read" },
            ],
          };
          (
            options as { onPayload?: (payload: Record<string, unknown>) => void } | undefined
          )?.onPayload?.(payload);
          payloads.push(structuredClone(payload));
          return {
            async result() {
              return { role: "assistant", content: "done" };
            },
            [Symbol.asyncIterator]() {
              return (async function* () {})();
            },
          };
        };
        session.prompt = async () => {
          await session.agent.streamFn?.(
            {} as never,
            {
              messages: [],
              tools: [
                { name: "exec", description: "", parameters: {} },
                { name: "wait", description: "", parameters: {} },
              ],
            } as never,
            {},
          );
          session.messages = [
            ...session.messages,
            { role: "assistant", content: "done", timestamp: 2 },
          ];
        };
        return session;
      },
    });

    expect(observedOptions.at(-1)?.openclawCodeModeToolSurface).toBe(true);
    expect(payloads.at(-1)?.tools).toEqual([
      { type: "function", name: "exec" },
      { type: "function", name: "wait" },
    ]);
  });

  it("keeps newly generated thinking after repairing rejected Anthropic replay", async () => {
    const { SessionManager: ActualSessionManager } =
      await vi.importActual<typeof import("../../sessions/index.js")>("../../sessions/index.js");
    const staleAssistant = {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "historical stale thinking",
          thinkingSignature: "stale-signature",
        },
        { type: "text", text: "historical answer" },
      ],
      stopReason: "stop",
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      timestamp: 2,
    } as AgentMessage;
    const sessionMessages = [
      { role: "user", content: "historical question", timestamp: 1 } as AgentMessage,
      staleAssistant,
    ];
    const sessionManager = ActualSessionManager.inMemory();
    const appendSessionMessage = (message: AgentMessage) =>
      sessionManager.appendMessage(message as Parameters<typeof sessionManager.appendMessage>[0]);
    for (const message of sessionMessages) {
      appendSessionMessage(message);
    }
    const retryAssistant = {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "fresh valid retry thinking",
          thinkingSignature: "fresh-valid-signature",
        },
        { type: "text", text: "retry answer" },
      ],
      stopReason: "stop",
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      timestamp: 4,
    } as AgentMessage;
    const providerContexts: AgentMessage[][] = [];
    const afterTurn = vi.fn(async (_params: { messages: AgentMessage[] }) => {});

    hoisted.sessionManagerOpenMock.mockReturnValue(sessionManager);

    await createContextEngineAttemptRunner({
      contextEngine: {
        ...createContextEngineBootstrapAndAssemble(),
        afterTurn,
      },
      sessionKey,
      tempPaths,
      sessionMessages,
      attemptOverrides: {
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        model: {
          api: "anthropic-messages",
          provider: "anthropic",
          id: "claude-sonnet-4-6",
          contextWindow: 128_000,
          input: ["text"],
        } as never,
        runtimePlan: {
          prompt: {
            resolveSystemPromptContribution: () => undefined,
          },
          transcript: {
            resolvePolicy: () => ({
              sanitizeMode: "full",
              sanitizeToolCallIds: true,
              preserveNativeAnthropicToolUseIds: false,
              repairToolUseResultPairing: true,
              preserveSignatures: true,
              sanitizeThinkingSignatures: false,
              dropThinkingBlocks: false,
              dropReasoningFromHistory: false,
              applyGoogleTurnOrdering: false,
              validateGeminiTurns: false,
              validateAnthropicTurns: false,
              allowSyntheticToolResults: false,
            }),
          },
          transport: {
            extraParams: {},
            resolveExtraParams: () => ({}),
          },
          tools: {
            normalize: (tools: unknown[]) => tools,
            logDiagnostics: () => {},
          },
          auth: {
            providerForAuth: "anthropic",
            authProfileProviderForAuth: "",
            forwardedAuthProfileId: undefined,
          },
          delivery: {
            isSilentPayload: () => false,
            resolveFollowupRoute: () => undefined,
          },
          outcome: {
            classifyRunResult: () => undefined,
          },
          observability: {
            resolvedRef: "anthropic/claude-sonnet-4-6",
            provider: "anthropic",
            modelId: "claude-sonnet-4-6",
            modelApi: "anthropic-messages",
          },
        } as never,
      },
      createSession: () => {
        const session = createDefaultEmbeddedSession({ initialMessages: sessionMessages });
        let streamCalls = 0;
        session.agent.streamFn = async (_model, context) => {
          streamCalls += 1;
          providerContexts.push([
            ...((context as { messages?: AgentMessage[] } | undefined)?.messages ?? []),
          ]);
          if (streamCalls === 1) {
            throw new Error("invalid signature in thinking block");
          }
          return {
            async result() {
              return retryAssistant;
            },
            [Symbol.asyncIterator]() {
              return (async function* () {})();
            },
          };
        };
        session.prompt = async (prompt, options) => {
          options?.preflightResult?.(true);
          const userMessage = {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: 3,
          } as AgentMessage;
          session.messages = [...session.messages, userMessage];
          appendSessionMessage(userMessage);
          const stream = await session.agent.streamFn?.(
            {} as never,
            { messages: session.messages } as never,
            {},
          );
          const assistantMessage = await (
            stream as { result: () => Promise<AgentMessage> }
          ).result();
          session.messages = [...session.messages, assistantMessage];
          appendSessionMessage(assistantMessage);
        };
        return session;
      },
    });

    const firstProviderContext = providerContexts[0] ?? [];
    const retryProviderContext = providerContexts[1] ?? [];
    expect(JSON.stringify(firstProviderContext)).toContain("stale-signature");
    expect(JSON.stringify(retryProviderContext)).not.toContain("stale-signature");

    const finalMessages = sessionManager.buildSessionContext().messages;
    expect(JSON.stringify(finalMessages[1])).not.toContain("historical stale thinking");
    expect(JSON.stringify(finalMessages.at(-1))).toContain("fresh valid retry thinking");
    expect(JSON.stringify(finalMessages.at(-1))).toContain("fresh-valid-signature");
    expect(afterTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "thinking",
                thinking: "fresh valid retry thinking",
                thinkingSignature: "fresh-valid-signature",
              }),
            ]),
          }),
        ]),
      }),
    );
  });

  it("sends transcriptPrompt visibly and keeps runtime context out of transcript messages", async () => {
    const seen: { prompt?: string; messages?: unknown[]; systemPrompt?: string } = {};

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      trajectory: true,
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
        seen.systemPrompt = session.agent.state.systemPrompt;
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(seen.prompt).toBe("visible ask");
    expect(result.finalPromptText).toBe("visible ask");
    expectFields(
      findRecord(
        requireRecords(seen.messages, "seen messages"),
        (message) => message.customType === "openclaw.runtime-context",
        "runtime context message",
      ),
      {
        role: "custom",
        customType: "openclaw.runtime-context",
        display: false,
      },
    );
    expect(seen.systemPrompt).not.toContain("secret runtime context");
    expect(JSON.stringify(seen.messages)).not.toContain("visible ask");
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

  it("filters heartbeat response-tool transcript artifacts before normal prompt snapshots", async () => {
    const contextEngine = createContextEngineBootstrapAndAssemble();
    const sessionMessages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT, timestamp: 1 },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_bash",
            name: "bash",
            arguments: { command: "cat HEARTBEAT.md" },
          },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_bash",
        content: [{ type: "text", text: "HEARTBEAT.md says stay quiet" }],
        timestamp: 3,
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: {
              outcome: "no_change",
              notify: false,
              summary: "No visible update.",
            },
          },
        ],
        timestamp: 4,
      },
      {
        role: "toolResult",
        toolCallId: "call_heartbeat",
        content: [{ type: "text", text: '{"notify":false}' }],
        timestamp: 5,
      },
      { role: "assistant", content: "No visible update. notify=false", timestamp: 6 },
    ] as AgentMessage[];

    const result = await createContextEngineAttemptRunner({
      contextEngine,
      sessionKey,
      tempPaths,
      sessionMessages,
      attemptOverrides: {
        prompt: "what model are you",
        transcriptPrompt: "what model are you",
      },
      sessionPrompt: async (session) => {
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "gpt-test", timestamp: 7 },
        ];
      },
    });

    const assembleInput = contextEngine.assemble.mock.calls.at(0)?.[0];
    const assembledMessagesJson = JSON.stringify(assembleInput?.messages ?? []);
    const snapshotJson = JSON.stringify(result.messagesSnapshot);
    for (const artifact of [
      "HEARTBEAT.md",
      "heartbeat_respond",
      "notify=false",
      '"notify":false',
      HEARTBEAT_TRANSCRIPT_PROMPT,
    ]) {
      expect(assembledMessagesJson).not.toContain(artifact);
      expect(snapshotJson).not.toContain(artifact);
    }
    expect(result.finalPromptText).toBe("what model are you");
  });

  it("filters interrupted prompt-only heartbeat artifacts before normal prompt snapshots", async () => {
    const contextEngine = createContextEngineBootstrapAndAssemble();
    const sessionMessages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT, timestamp: 1 },
    ] as AgentMessage[];

    const result = await createContextEngineAttemptRunner({
      contextEngine,
      sessionKey,
      tempPaths,
      sessionMessages,
      attemptOverrides: {
        prompt: "what model are you",
        transcriptPrompt: "what model are you",
      },
      sessionPrompt: async (session) => {
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "gpt-test", timestamp: 2 },
        ];
      },
    });

    const assembleInput = contextEngine.assemble.mock.calls.at(0)?.[0];
    const assembledMessagesJson = JSON.stringify(assembleInput?.messages ?? []);
    const snapshotJson = JSON.stringify(result.messagesSnapshot);
    expect(assembledMessagesJson).not.toContain(HEARTBEAT_TRANSCRIPT_PROMPT);
    expect(snapshotJson).not.toContain(HEARTBEAT_TRANSCRIPT_PROMPT);
    expect(result.finalPromptText).toBe("what model are you");
  });

  it("filters pending notify=true heartbeat response-tool calls before normal prompt snapshots", async () => {
    const contextEngine = createContextEngineBootstrapAndAssemble();
    const sessionMessages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT, timestamp: 1 },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: {
              outcome: "needs_attention",
              notify: true,
              summary: "Build is blocked.",
              notificationText: "Build is blocked on missing credentials.",
            },
          },
        ],
        timestamp: 2,
      },
    ] as AgentMessage[];

    const result = await createContextEngineAttemptRunner({
      contextEngine,
      sessionKey,
      tempPaths,
      sessionMessages,
      attemptOverrides: {
        prompt: "what model are you",
        transcriptPrompt: "what model are you",
      },
      sessionPrompt: async (session) => {
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "gpt-test", timestamp: 3 },
        ];
      },
    });

    const assembleInput = contextEngine.assemble.mock.calls.at(0)?.[0];
    const assembledMessagesJson = JSON.stringify(assembleInput?.messages ?? []);
    const snapshotJson = JSON.stringify(result.messagesSnapshot);
    for (const artifact of [
      HEARTBEAT_TRANSCRIPT_PROMPT,
      "heartbeat_respond",
      '"notify":true',
      "Build is blocked on missing credentials.",
    ]) {
      expect(assembledMessagesJson).not.toContain(artifact);
      expect(snapshotJson).not.toContain(artifact);
    }
    expect(result.finalPromptText).toBe("what model are you");
  });

  it("preserves visible heartbeat alerts in normal prompt snapshots", async () => {
    const contextEngine = createContextEngineBootstrapAndAssemble();
    const sessionMessages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT, timestamp: 1 },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_bash",
            name: "bash",
            arguments: { command: "cat HEARTBEAT.md" },
          },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_bash",
        content: [{ type: "text", text: "HEARTBEAT.md says check deployment" }],
        timestamp: 3,
      },
      {
        role: "assistant",
        content: "Build is blocked on a failing release check.",
        timestamp: 4,
      },
    ] as AgentMessage[];

    const result = await createContextEngineAttemptRunner({
      contextEngine,
      sessionKey,
      tempPaths,
      sessionMessages,
      attemptOverrides: {
        prompt: "what changed while I was away?",
        transcriptPrompt: "what changed while I was away?",
      },
      sessionPrompt: async (session) => {
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "gpt-test", timestamp: 5 },
        ];
      },
    });

    const assembleInput = contextEngine.assemble.mock.calls.at(0)?.[0];
    const assembledMessagesJson = JSON.stringify(assembleInput?.messages ?? []);
    const snapshotJson = JSON.stringify(result.messagesSnapshot);
    for (const visibleContext of [
      HEARTBEAT_TRANSCRIPT_PROMPT,
      "HEARTBEAT.md says check deployment",
      "Build is blocked on a failing release check.",
    ]) {
      expect(assembledMessagesJson).toContain(visibleContext);
      expect(snapshotJson).toContain(visibleContext);
    }
    expect(result.finalPromptText).toBe("what changed while I was away?");
  });

  it("preserves visible heartbeat response-tool notifications in normal prompt snapshots", async () => {
    const contextEngine = createContextEngineBootstrapAndAssemble();
    const sessionMessages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT, timestamp: 1 },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: {
              outcome: "needs_attention",
              notify: true,
              summary: "Build is blocked.",
              notificationText: "Build is blocked on missing credentials.",
            },
          },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_heartbeat",
        content: [{ type: "text", text: '{"notify":true}' }],
        timestamp: 3,
      },
      { role: "assistant", content: "HEARTBEAT_OK", timestamp: 4 },
    ] as AgentMessage[];

    const result = await createContextEngineAttemptRunner({
      contextEngine,
      sessionKey,
      tempPaths,
      sessionMessages,
      attemptOverrides: {
        prompt: "what changed while I was away?",
        transcriptPrompt: "what changed while I was away?",
      },
      sessionPrompt: async (session) => {
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "gpt-test", timestamp: 5 },
        ];
      },
    });

    const assembleInput = contextEngine.assemble.mock.calls.at(0)?.[0];
    const assembledMessagesJson = JSON.stringify(assembleInput?.messages ?? []);
    const snapshotJson = JSON.stringify(result.messagesSnapshot);
    for (const visibleContext of [
      "heartbeat_respond",
      '"notify":true',
      "Build is blocked on missing credentials.",
      "HEARTBEAT_OK",
    ]) {
      expect(assembledMessagesJson).toContain(visibleContext);
      expect(snapshotJson).toContain(visibleContext);
    }
    expect(result.finalPromptText).toBe("what changed while I was away?");
  });

  it("rebuilds skill prompt inputs from the sandbox workspace for non-rw sandbox runs", async () => {
    const sandboxWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-skills-"));
    tempPaths.push(sandboxWorkspace);
    hoisted.resolveSandboxContextMock.mockResolvedValue({
      enabled: true,
      workspaceAccess: "ro",
      workspaceDir: sandboxWorkspace,
    });

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        skillsSnapshot: {
          prompt:
            "<available_skills><skill><location>~/.openclaw/skills/smaug/SKILL.md</location></skill></available_skills>",
          skills: [{ name: "smaug" }],
          resolvedSkills: [
            {
              name: "smaug",
              description: "Host copy",
              disableModelInvocation: false,
              filePath: "/Users/alice/.openclaw/skills/smaug/SKILL.md",
              baseDir: "/Users/alice/.openclaw/skills/smaug",
              source: "openclaw-workspace",
              sourceInfo: {
                path: "/Users/alice/.openclaw/skills/smaug/SKILL.md",
                source: "openclaw-workspace",
                scope: "project",
                origin: "top-level",
                baseDir: "/Users/alice/.openclaw/skills/smaug",
              },
            },
          ],
        },
      },
    });

    expectFields(
      mockParams(hoisted.resolveEmbeddedRunSkillEntriesMock, 0, "skill entries params"),
      {
        workspaceDir: sandboxWorkspace,
        skillsSnapshot: undefined,
      },
    );
    expectFields(mockParams(hoisted.resolveSkillsPromptForRunMock, 0, "skills prompt params"), {
      workspaceDir: sandboxWorkspace,
      skillsSnapshot: undefined,
    });
  });

  it("keeps before_prompt_build context in the model prompt and out of transcript messages", async () => {
    const runBeforePromptBuild = vi.fn(async () => ({
      prependContext: "dynamic hook context",
      appendContext: "dynamic hook tail",
    }));
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((name: string) => name === "before_prompt_build"),
      runBeforePromptBuild,
      runBeforeAgentStart: vi.fn(),
    });
    const seen: {
      modelMessages?: unknown[];
      preprocessedModelMessages?: unknown[];
      prompt?: string;
      messages?: unknown[];
      systemPrompt?: string;
    } = {};

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        prompt: "visible ask",
        transcriptPrompt: "visible ask",
      },
      sessionPrompt: async (session, prompt) => {
        seen.prompt = prompt;
        seen.messages = [...session.messages];
        seen.systemPrompt = session.agent.state.systemPrompt;
        const transformContext = (
          session.agent as {
            transformContext?: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
          }
        ).transformContext;
        seen.modelMessages = await transformContext?.([
          { role: "user", content: [{ type: "text", text: prompt }], timestamp: 1 },
        ]);
        seen.preprocessedModelMessages = await transformContext?.([
          {
            role: "user",
            content: [{ type: "text", text: `session preprocessed\n\n${prompt}` }],
            timestamp: 1,
          },
        ]);
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(seen.prompt).toBe("visible ask");
    expect(result.finalPromptText).toBe("visible ask");
    expect(JSON.stringify(seen.modelMessages)).toContain("dynamic hook context");
    expect(JSON.stringify(seen.modelMessages)).toContain("dynamic hook tail");
    expect(JSON.stringify(seen.preprocessedModelMessages)).toContain("dynamic hook context");
    expect(JSON.stringify(seen.preprocessedModelMessages)).toContain("session preprocessed");
    expect(JSON.stringify(seen.preprocessedModelMessages)).toContain("dynamic hook tail");
    expect(seen.systemPrompt).not.toContain("dynamic hook context");
    expect(seen.systemPrompt).not.toContain("dynamic hook tail");
    expect(JSON.stringify(seen.messages)).not.toContain("dynamic hook context");
    expect(JSON.stringify(seen.messages)).not.toContain("dynamic hook tail");
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("dynamic hook context");
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("dynamic hook tail");
  });

  it("keeps hook context model-only when orphan repair merges the prompt", async () => {
    const runBeforePromptBuild = vi.fn(async () => ({
      prependContext: "dynamic hook context",
      appendContext: "dynamic hook tail",
    }));
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((name: string) => name === "before_prompt_build"),
      runBeforePromptBuild,
      runBeforeAgentStart: vi.fn(),
    });
    hoisted.sessionManager.getLeafEntry.mockReturnValueOnce({
      id: "orphan-leaf",
      parentId: "parent-leaf",
      type: "message",
      message: { role: "user", content: "orphaned ask", timestamp: 1 },
    });
    const seen: { modelMessages?: unknown[]; prompt?: string; messages?: unknown[] } = {};

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        prompt: "visible ask",
      },
      sessionPrompt: async (session, prompt) => {
        seen.prompt = prompt;
        seen.messages = [...session.messages];
        const transformContext = (
          session.agent as {
            transformContext?: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
          }
        ).transformContext;
        seen.modelMessages = await transformContext?.([
          { role: "user", content: [{ type: "text", text: prompt }], timestamp: 1 },
        ]);
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(seen.prompt).toContain("orphaned ask");
    expect(seen.prompt).toContain("visible ask");
    expect(seen.prompt).not.toContain("dynamic hook context");
    expect(seen.prompt).not.toContain("dynamic hook tail");
    expect(result.finalPromptText).toBe(seen.prompt);
    expect(JSON.stringify(seen.modelMessages)).toContain("dynamic hook context");
    expect(JSON.stringify(seen.modelMessages)).toContain("orphaned ask");
    expect(JSON.stringify(seen.modelMessages)).toContain("dynamic hook tail");
    expect(JSON.stringify(seen.messages)).not.toContain("dynamic hook context");
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("dynamic hook tail");
    expect(hoisted.sessionManager.branch).toHaveBeenCalledWith("parent-leaf");
  });

  it("targets the latest active prompt after orphan repair reaches the embedded provider", async () => {
    const marker =
      "[Queued user message from a previous active turn; preserved as context only. Continue with the active prompt below.]";
    const olderPrompt = "OLD_TURN: answer the earlier short request";
    const latestPrompt = "LATEST_TURN: answer only this active instruction";
    const repairedPrompt = `${marker}\n${olderPrompt}\n\n${latestPrompt}`;
    const runBeforePromptBuild = vi.fn(async () => ({
      prependContext: "provider-side context",
    }));
    const seen: { modelInputPrompt?: string; modelMessages?: AgentMessage[] } = {};
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((name: string) => name === "before_prompt_build"),
      runBeforePromptBuild,
      runBeforeAgentStart: vi.fn(),
    });
    hoisted.sessionManager.getLeafEntry.mockReturnValueOnce({
      id: "orphan-leaf",
      parentId: "parent-leaf",
      type: "message",
      message: { role: "user", content: olderPrompt, timestamp: 1 },
    });

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        prompt: latestPrompt,
      },
      sessionPrompt: async (session, prompt) => {
        seen.modelInputPrompt = prompt;
        const transformContext = (
          session.agent as {
            transformContext?: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
          }
        ).transformContext;
        seen.modelMessages = await transformContext?.([
          { role: "user", content: [{ type: "text", text: prompt }], timestamp: 1 },
        ]);
        const activePrompt = prompt.startsWith(`${marker}\n${olderPrompt}\n\n`)
          ? prompt.slice(`${marker}\n${olderPrompt}\n\n`.length)
          : "missing-active-prompt";
        session.messages = [
          ...session.messages,
          { role: "assistant", content: `stub-provider-target=${activePrompt}`, timestamp: 2 },
        ];
      },
    });

    expect(result.finalPromptText).toBe(repairedPrompt);
    expect(seen.modelInputPrompt).toBe(repairedPrompt);
    const serializedModelMessages = JSON.stringify(seen.modelMessages);
    expect(serializedModelMessages).toContain(marker);
    expect(serializedModelMessages).toContain(olderPrompt);
    expect(serializedModelMessages).toContain(latestPrompt);
    const finalAssistant = findRecord(
      requireRecords(result.messagesSnapshot, "messages snapshot"),
      (message) => message.role === "assistant",
      "final assistant",
    );
    expect(finalAssistant.content).toBe(`stub-provider-target=${latestPrompt}`);
    expect(finalAssistant.content).not.toContain("OLD_TURN");
    expect(hoisted.sessionManager.branch).toHaveBeenCalledWith("parent-leaf");
  });

  it("repairs an orphaned user message behind non-message session metadata before the provider", async () => {
    const marker =
      "[Queued user message from a previous active turn; preserved as context only. Continue with the active prompt below.]";
    const olderPrompt = "OLD_TURN_76888: answer the orphaned queued turn";
    const latestPrompt = "LATEST_TURN_76888: answer only the active channel prompt";
    const repairedPrompt = `${marker}\n${olderPrompt}\n\n${latestPrompt}`;
    const modelSnapshotData = { provider: "deepseek", modelId: "deepseek-chat" };
    const orphanLeaf = {
      id: "orphan-leaf",
      parentId: "parent-leaf",
      type: "message",
      message: { role: "user", content: olderPrompt, timestamp: 1 },
    };
    const thinkingEntry = {
      id: "thinking-leaf",
      parentId: "orphan-leaf",
      type: "thinking_level_change",
      thinkingLevel: "high",
    };
    const modelEntry = {
      id: "model-leaf",
      parentId: "thinking-leaf",
      type: "model_change",
      provider: "deepseek",
      modelId: "deepseek-chat",
    };
    const modelSnapshotEntry = {
      id: "model-snapshot-leaf",
      parentId: "model-leaf",
      type: "custom",
      customType: "model-snapshot",
      data: modelSnapshotData,
    };
    const labelEntry = {
      id: "label-leaf",
      parentId: "model-snapshot-leaf",
      type: "label",
      targetId: "model-snapshot-leaf",
      label: "model snapshot",
    };
    hoisted.sessionManager.getLeafEntry.mockReturnValueOnce(labelEntry);
    hoisted.sessionManager.getEntry.mockImplementation((id: unknown) => {
      if (id === "model-snapshot-leaf") {
        return modelSnapshotEntry;
      }
      if (id === "model-leaf") {
        return modelEntry;
      }
      if (id === "thinking-leaf") {
        return thinkingEntry;
      }
      return id === "orphan-leaf" ? orphanLeaf : undefined;
    });
    const replayedEntries: string[] = [];
    hoisted.sessionManager.appendThinkingLevelChange.mockImplementation((...args: unknown[]) => {
      replayedEntries.push(`thinking:${String(args[0])}`);
      return "replayed-thinking";
    });
    hoisted.sessionManager.appendModelChange.mockImplementation((...args: unknown[]) => {
      replayedEntries.push(`model:${String(args[0])}/${String(args[1])}`);
      return "replayed-model";
    });
    hoisted.sessionManager.appendCustomEntry.mockImplementation((...args: unknown[]) => {
      if (args[0] === "model-snapshot") {
        replayedEntries.push(`custom:${args[0]}:${JSON.stringify(args[1])}`);
      }
      return "replayed-custom";
    });
    hoisted.sessionManager.appendLabelChange.mockImplementation((...args: unknown[]) => {
      replayedEntries.push(`label:${String(args[0])}/${String(args[1])}`);
      return "replayed-label";
    });
    const seen: { modelInputPrompt?: string } = {};

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        prompt: latestPrompt,
      },
      sessionPrompt: async (session, prompt) => {
        seen.modelInputPrompt = prompt;
        const activePrompt = prompt.startsWith(`${marker}\n${olderPrompt}\n\n`)
          ? prompt.slice(`${marker}\n${olderPrompt}\n\n`.length)
          : "missing-active-prompt";
        session.messages = [
          ...session.messages,
          { role: "assistant", content: `stub-provider-target=${activePrompt}`, timestamp: 2 },
        ];
      },
    });

    expect(result.finalPromptText).toBe(repairedPrompt);
    expect(seen.modelInputPrompt).toBe(repairedPrompt);
    const finalAssistant = findRecord(
      requireRecords(result.messagesSnapshot, "messages snapshot"),
      (message) => message.role === "assistant",
      "final assistant",
    );
    expect(finalAssistant.content).toBe(`stub-provider-target=${latestPrompt}`);
    expect(hoisted.sessionManager.branch).toHaveBeenCalledWith("parent-leaf");
    expect(replayedEntries).toEqual([
      "thinking:high",
      "model:deepseek/deepseek-chat",
      `custom:model-snapshot:${JSON.stringify(modelSnapshotData)}`,
      "label:replayed-custom/model snapshot",
    ]);
  });

  it("does not abort orphan repair for a dangling trailing label", async () => {
    const marker =
      "[Queued user message from a previous active turn; preserved as context only. Continue with the active prompt below.]";
    const olderPrompt = "OLD_TURN_76888: dangling label repair";
    const latestPrompt = "LATEST_TURN_76888: answer after dangling label";
    const orphanLeaf = {
      id: "orphan-leaf",
      parentId: "parent-leaf",
      type: "message",
      message: { role: "user", content: olderPrompt, timestamp: 1 },
    };
    const thinkingEntry = {
      id: "thinking-leaf",
      parentId: "orphan-leaf",
      type: "thinking_level_change",
      thinkingLevel: "high",
    };
    const labelEntry = {
      id: "label-leaf",
      parentId: "thinking-leaf",
      type: "label",
      targetId: "missing-entry",
      label: "stale label",
    };
    hoisted.sessionManager.getLeafEntry.mockReturnValueOnce(labelEntry);
    hoisted.sessionManager.getEntry.mockImplementation((id: unknown) => {
      if (id === "thinking-leaf") {
        return thinkingEntry;
      }
      return id === "orphan-leaf" ? orphanLeaf : undefined;
    });
    hoisted.sessionManager.appendThinkingLevelChange.mockReturnValue("replayed-thinking");
    hoisted.sessionManager.appendLabelChange.mockImplementation((targetId: unknown) => {
      throw new Error(`Entry ${String(targetId)} not found`);
    });
    const seen: { modelInputPrompt?: string } = {};

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        prompt: latestPrompt,
      },
      sessionPrompt: async (session, prompt) => {
        seen.modelInputPrompt = prompt;
        const activePrompt = prompt.startsWith(`${marker}\n${olderPrompt}\n\n`)
          ? prompt.slice(`${marker}\n${olderPrompt}\n\n`.length)
          : "missing-active-prompt";
        session.messages = [
          ...session.messages,
          { role: "assistant", content: `stub-provider-target=${activePrompt}`, timestamp: 2 },
        ];
      },
    });

    expect(result.finalPromptText).toBe(`${marker}\n${olderPrompt}\n\n${latestPrompt}`);
    expect(seen.modelInputPrompt).toBe(result.finalPromptText);
    const finalAssistant = findRecord(
      requireRecords(result.messagesSnapshot, "messages snapshot"),
      (message) => message.role === "assistant",
      "final assistant",
    );
    expect(finalAssistant.content).toBe(`stub-provider-target=${latestPrompt}`);
    expect(hoisted.sessionManager.branch).toHaveBeenCalledWith("parent-leaf");
    expect(hoisted.sessionManager.appendLabelChange).not.toHaveBeenCalled();
  });

  it("removes the repaired orphan from assembled history when the context engine appends the active prompt", async () => {
    const marker =
      "[Queued user message from a previous active turn; preserved as context only. Continue with the active prompt below.]";
    const olderPrompt = "OLD_TURN_76888: stale assembled history";
    const latestPrompt = "LATEST_TURN_76888: active assembled prompt";
    hoisted.sessionManager.getLeafEntry.mockReturnValueOnce({
      id: "orphan-leaf",
      parentId: "parent-leaf",
      type: "message",
      message: { role: "user", content: olderPrompt, timestamp: 1 },
    });
    const seen: {
      prompt?: string;
      assembledPrompt?: string;
      assembledMessages?: AgentMessage[];
      messages?: AgentMessage[];
    } = {};

    await createContextEngineAttemptRunner({
      contextEngine: createTestContextEngine({
        bootstrap: async () => ({ bootstrapped: true }),
        assemble: async ({ messages, prompt }: { messages: AgentMessage[]; prompt?: string }) => {
          seen.assembledPrompt = prompt;
          seen.assembledMessages = [...messages];
          return {
            messages: [
              ...messages,
              { role: "user", content: latestPrompt, timestamp: 2 } as AgentMessage,
            ],
            estimatedTokens: 1,
          };
        },
      }),
      sessionKey,
      tempPaths,
      sessionMessages: [{ role: "user", content: olderPrompt, timestamp: 1 } as AgentMessage],
      sessionMessagesAfterRepair: [],
      attemptOverrides: {
        prompt: latestPrompt,
      },
      sessionPrompt: async (session, prompt) => {
        seen.prompt = prompt;
        seen.messages = [...session.messages] as AgentMessage[];
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 3 },
        ];
      },
    });

    expect(seen.prompt).toBe(`${marker}\n${olderPrompt}\n\n${latestPrompt}`);
    expect(seen.assembledPrompt).toBe(seen.prompt);
    expect(JSON.stringify(seen.assembledMessages)).not.toContain(olderPrompt);
    expect(JSON.stringify(seen.messages)).not.toContain(olderPrompt);
    expect(JSON.stringify(seen.messages)).toContain(latestPrompt);
    expect(hoisted.sessionManager.branch).toHaveBeenCalledWith("parent-leaf");
  });

  it("keeps hidden runtime context hidden when orphan repair merges a transcript prompt", async () => {
    hoisted.sessionManager.getLeafEntry.mockReturnValueOnce({
      id: "orphan-leaf",
      parentId: "parent-leaf",
      type: "message",
      message: { role: "user", content: "orphaned ask", timestamp: 1 },
    });
    const seen: { prompt?: string; messages?: unknown[] } = {};

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

    expect(seen.prompt).toContain("orphaned ask");
    expect(seen.prompt).toContain("visible ask");
    expect(seen.prompt).not.toContain("secret runtime context");
    expect(result.finalPromptText).toBe(seen.prompt);
    const runtimeContext = findRecord(
      requireRecords(seen.messages, "seen messages"),
      (message) => message.customType === "openclaw.runtime-context",
      "runtime context message",
    );
    expect(runtimeContext.content).toContain("secret runtime context");
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("secret runtime context");
    expect(hoisted.sessionManager.branch).toHaveBeenCalledWith("parent-leaf");
  });

  it("keeps bootstrap truncation warnings out of WebChat runtime context", async () => {
    const seen: { prompt?: string; messages?: unknown[] } = {};
    hoisted.resolveBootstrapContextForRunMock.mockResolvedValueOnce({
      bootstrapFiles: [
        {
          name: "AGENTS.md",
          path: "/tmp/openclaw-warning-workspace/AGENTS.md",
          content: "A".repeat(200),
          missing: false,
        },
      ],
      contextFiles: [
        { path: "/tmp/openclaw-warning-workspace/AGENTS.md", content: "A".repeat(20) },
      ],
    });

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        config: {
          agents: {
            defaults: {
              bootstrapMaxChars: 50,
              bootstrapTotalMaxChars: 50,
            },
          },
        } as OpenClawConfig,
        prompt: "visible ask",
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
    expect(JSON.stringify(seen.messages)).not.toContain("[Bootstrap truncation warning]");
    expect(JSON.stringify(seen.messages)).not.toContain("bootstrapMaxChars");
  });

  it("preserves bootstrap system context in the assembled system prompt", async () => {
    const seen: { prompt?: string; messages?: unknown[] } = {};
    hoisted.isWorkspaceBootstrapPendingMock.mockResolvedValueOnce(true);
    hoisted.createOpenClawCodingToolsMock.mockImplementationOnce(() => [
      { name: "read", execute: async () => "" },
    ]);
    hoisted.resolveBootstrapContextForRunMock.mockResolvedValueOnce({
      bootstrapFiles: [
        {
          name: "BOOTSTRAP.md",
          path: "/tmp/openclaw-bootstrap-workspace/BOOTSTRAP.md",
          content: "Ask who I am.",
          missing: false,
        },
      ],
      contextFiles: [
        {
          path: "/tmp/openclaw-bootstrap-workspace/BOOTSTRAP.md",
          content: "Ask who I am.",
        },
      ],
    });

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        disableTools: false,
        prompt: "visible ask",
        transcriptPrompt: "visible ask",
        trigger: "user",
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
    expect(JSON.stringify(seen.messages)).not.toContain("Ask who I am.");
    const promptInput = hoisted.embeddedSystemPromptInputs.at(-1) as {
      bootstrapMode?: string;
      contextFiles?: Array<{ path: string; content: string }>;
    };

    expect(promptInput.bootstrapMode).toBe("full");
    expect(promptInput.contextFiles).toEqual([
      {
        path: "/tmp/openclaw-bootstrap-workspace/BOOTSTRAP.md",
        content: "Ask who I am.",
      },
    ]);
  });

  it("includes hook-adjusted bootstrap files preloaded before routing", async () => {
    const workspaceDir = "/tmp/openclaw-hook-workspace";
    hoisted.resolveBootstrapFilesForRunMock.mockResolvedValueOnce([
      {
        name: "BOOTSTRAP.md",
        path: `${workspaceDir}/BOOTSTRAP.md`,
        content: "Ask who I am before continuing.",
        missing: false,
      },
    ]);

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        prompt: "visible ask",
        transcriptPrompt: "visible ask",
        trigger: "user",
        workspaceDir,
      },
      sessionPrompt: async (session) => {
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(hoisted.resolveBootstrapFilesForRunMock).toHaveBeenCalledOnce();
    expect(hoisted.resolveBootstrapContextForRunMock).not.toHaveBeenCalled();
    const promptInput = hoisted.embeddedSystemPromptInputs.at(-1) as {
      bootstrapMode?: string;
      contextFiles?: Array<{ path: string; content: string }>;
    };

    expect(promptInput.bootstrapMode).toBe("full");
    expect(promptInput.contextFiles).toEqual([
      {
        path: `${workspaceDir}/BOOTSTRAP.md`,
        content: "Ask who I am before continuing.",
      },
    ]);
  });

  it("skips bootstrap preload on completed continuation-skip turns", async () => {
    hoisted.resolveContextInjectionModeMock.mockReturnValue("continuation-skip");
    hoisted.hasCompletedBootstrapTurnMock.mockResolvedValue(true);
    hoisted.isWorkspaceBootstrapPendingMock.mockResolvedValue(false);

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        prompt: "visible ask",
        transcriptPrompt: "visible ask",
        trigger: "user",
      },
      sessionPrompt: async (session) => {
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(hoisted.hasCompletedBootstrapTurnMock).toHaveBeenCalledOnce();
    expect(hoisted.isWorkspaceBootstrapPendingMock).toHaveBeenCalledOnce();
    expect(hoisted.resolveBootstrapFilesForRunMock).not.toHaveBeenCalled();
    expect(hoisted.resolveBootstrapContextForRunMock).not.toHaveBeenCalled();
  });

  it("adds current-turn context to the current model input without exposing internal runtime context", async () => {
    let seenPrompt: string | undefined;
    let seenMessages: unknown[] | undefined;

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      trajectory: true,
      attemptOverrides: {
        prompt: [
          "what does this mean?",
          "",
          "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
          "secret runtime context",
          "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        ].join("\n"),
        transcriptPrompt: "what does this mean?",
        currentInboundContext: {
          text: [
            "Reply target of current user message (untrusted, for context):",
            "```json",
            JSON.stringify(
              {
                sender_label: "Mike",
                body: "WT daily plan - Sat May 2\nSee ./quoted-secret.png and [media attached: media://inbound/quoted.png]",
              },
              null,
              2,
            ),
            "```",
          ].join("\n"),
        },
      },
      sessionPrompt: async (session, prompt) => {
        seenPrompt = prompt;
        seenMessages = [...session.messages];
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    // The user prompt is kept BARE; current-turn inbound metadata is routed into
    // the runtime-context carrier instead of being prepended to the user text.
    expect(seenPrompt).toBe("what does this mean?");
    expect(seenPrompt).not.toContain(
      "Reply target of current user message (untrusted, for context):",
    );
    expect(seenPrompt).not.toContain("OPENCLAW_INTERNAL_CONTEXT");
    expect(seenPrompt).not.toContain("secret runtime context");
    expect(result.finalPromptText).toBe(seenPrompt);
    const runtimeContext = findRecord(
      requireRecords(seenMessages, "seen messages"),
      (message) => message.customType === "openclaw.runtime-context",
      "runtime context message",
    );
    expect(runtimeContext.content).toContain(
      "Reply target of current user message (untrusted, for context):",
    );
    expect(runtimeContext.content).toContain('"sender_label": "Mike"');
    expect(runtimeContext.content).toContain("WT daily plan - Sat May 2");
    expect(runtimeContext.content).toContain("./quoted-secret.png");
    expect(runtimeContext.content).toContain("media://inbound/quoted.png");
    expect(runtimeContext.content).toContain("secret runtime context");
    expect(hoisted.detectAndLoadPromptImagesMock).toHaveBeenCalledTimes(1);
    expect(mockParams(hoisted.detectAndLoadPromptImagesMock, 0, "prompt image params").prompt).toBe(
      "what does this mean?",
    );
    const trajectoryEvents = (
      await fs.readFile(path.join(tempPaths[0] ?? "", "session.trajectory.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TrajectoryEvent);
    const promptSubmitted = trajectoryEvents.find((event) => event.type === "prompt.submitted");
    expect(promptSubmitted?.data?.prompt).toBe(seenPrompt);
    expect(promptSubmitted?.data?.prompt).not.toContain("WT daily plan - Sat May 2");
    expect(promptSubmitted?.data?.prompt).not.toContain("secret runtime context");
  });

  it("keeps hook prompt context visible while hiding inter-session provenance", async () => {
    const runBeforePromptBuild = vi.fn(async () => ({
      prependContext: "dynamic hook context",
      appendContext: "dynamic hook tail",
    }));
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((name: string) => name === "before_prompt_build"),
      runBeforePromptBuild,
      runBeforeAgentStart: vi.fn(),
    });
    const seen: {
      modelMessages?: unknown[];
      prompt?: string;
      messages?: unknown[];
      systemPrompt?: string;
    } = {};

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
        seen.prompt = prompt;
        seen.messages = [...session.messages];
        seen.systemPrompt = session.agent.state.systemPrompt;
        const transformContext = (
          session.agent as {
            transformContext?: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
          }
        ).transformContext;
        seen.modelMessages = await transformContext?.([
          { role: "user", content: [{ type: "text", text: prompt }], timestamp: 1 },
        ]);
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(seen.prompt).toBe("visible ask");
    expect(result.finalPromptText).toBe("visible ask");
    expect(seen.prompt).not.toContain("[Inter-session message]");
    expect(seen.prompt).not.toContain("secret runtime context");
    expect(JSON.stringify(seen.modelMessages)).toContain("dynamic hook context");
    expect(JSON.stringify(seen.modelMessages)).toContain("dynamic hook tail");
    expect(JSON.stringify(seen.modelMessages)).not.toContain("[Inter-session message]");
    expect(JSON.stringify(seen.modelMessages)).not.toContain("secret runtime context");
    const runtimeContext = findRecord(
      requireRecords(seen.messages, "seen messages"),
      (message) => message.customType === "openclaw.runtime-context",
      "runtime context message",
    );
    expect(seen.systemPrompt).not.toContain("[Inter-session message]");
    expect(runtimeContext.content).toContain("[Inter-session message]");
    expect(runtimeContext.content).toContain("isUser=false");
    expect(runtimeContext.content).not.toContain("visible ask");
    expect(runtimeContext.content).toContain("secret runtime context");
    expect(runtimeContext.content).not.toContain("dynamic hook context");
    expect(runtimeContext.content).not.toContain("dynamic hook tail");
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("dynamic hook context");
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("dynamic hook tail");
  });

  it("submits runtime-only context through system prompt without visible prompt", async () => {
    let seenPrompt: string | undefined;
    let seenModelMessages: unknown[] | undefined;
    const runBeforePromptBuild = vi.fn(async () => ({
      prependContext: "dynamic hook context",
      appendContext: "dynamic hook tail",
    }));
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((name: string) => name === "before_prompt_build"),
      runBeforePromptBuild,
      runBeforeAgentStart: vi.fn(),
    });

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      trajectory: true,
      attemptOverrides: {
        prompt: "internal heartbeat event",
        transcriptPrompt: "",
      },
      sessionPrompt: async (session, prompt) => {
        seenPrompt = prompt;
        const transformContext = (
          session.agent as {
            transformContext?: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
          }
        ).transformContext;
        seenModelMessages = await transformContext?.([
          { role: "user", content: [{ type: "text", text: prompt }], timestamp: 1 },
        ]);
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(seenPrompt).toBe("Continue the OpenClaw runtime event.");
    expect(result.finalPromptText).toBe("Continue the OpenClaw runtime event.");
    expect(JSON.stringify(seenModelMessages)).toContain("dynamic hook context");
    expect(JSON.stringify(seenModelMessages)).toContain("internal heartbeat event");
    expect(JSON.stringify(seenModelMessages)).toContain("dynamic hook tail");
    expect(
      requireRecords(result.messagesSnapshot, "messages snapshot").some(
        (message) =>
          message.role === "user" && String(message.content).includes("internal heartbeat event"),
      ),
    ).toBe(false);
    const trajectoryEvents = (
      await fs.readFile(path.join(tempPaths[0] ?? "", "session.trajectory.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TrajectoryEvent);
    const contextCompiled = trajectoryEvents.find((event) => event.type === "context.compiled");
    expect(contextCompiled?.data?.prompt).toContain("dynamic hook context");
    expect(contextCompiled?.data?.prompt).toContain("internal heartbeat event");
    expect(contextCompiled?.data?.prompt).toContain("dynamic hook tail");
    expect(contextCompiled?.data?.systemPrompt).toContain("internal heartbeat event");
    expect(contextCompiled?.data?.systemPrompt).not.toContain("dynamic hook context");
    expect(contextCompiled?.data?.systemPrompt).not.toContain("dynamic hook tail");
  });

  it("keeps runtime-only context hidden when orphan repair merges an empty transcript", async () => {
    let seenPrompt: string | undefined;
    let seenMessages: unknown[] | undefined;
    hoisted.sessionManager.getLeafEntry.mockReturnValueOnce({
      id: "orphan-leaf",
      parentId: "parent-leaf",
      type: "message",
      message: { role: "user", content: "orphaned ask", timestamp: 1 },
    });

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      trajectory: true,
      attemptOverrides: {
        prompt: "internal heartbeat event",
        transcriptPrompt: "",
      },
      sessionPrompt: async (session, prompt) => {
        seenPrompt = prompt;
        seenMessages = [...session.messages];
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(seenPrompt).toContain("orphaned ask");
    expect(seenPrompt).not.toContain("internal heartbeat event");
    expect(result.finalPromptText).toBe(seenPrompt);
    const trajectoryEvents = (
      await fs.readFile(path.join(tempPaths[0] ?? "", "session.trajectory.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TrajectoryEvent);
    const contextCompiled = trajectoryEvents.find((event) => event.type === "context.compiled");
    const runtimeContext = findRecord(
      requireRecords(seenMessages, "seen messages"),
      (message) => message.customType === "openclaw.runtime-context",
      "runtime context message",
    );
    expect(runtimeContext.content).toContain("internal heartbeat event");
    expect(contextCompiled?.data?.systemPrompt).not.toContain("internal heartbeat event");
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("internal heartbeat event");
    expect(hoisted.sessionManager.branch).toHaveBeenCalledWith("parent-leaf");
  });

  it("keeps current inbound context visible on runtime-only turns", async () => {
    let seenPrompt: string | undefined;

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      trajectory: true,
      attemptOverrides: {
        prompt: "runtime bare mention event",
        transcriptPrompt: "",
        currentInboundContext: {
          text: [
            "Reply target of current user message (untrusted, for context):",
            "```json",
            JSON.stringify(
              { sender_label: "Alice", body: "Hello from the replied message" },
              null,
              2,
            ),
            "```",
          ].join("\n"),
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

    expect(seenPrompt).toContain("Reply target of current user message (untrusted, for context):");
    expect(seenPrompt).toContain("Hello from the replied message");
    expect(seenPrompt).toContain("Continue the OpenClaw runtime event.");
    expect(result.finalPromptText).toBe(seenPrompt);
    const trajectoryEvents = (
      await fs.readFile(path.join(tempPaths[0] ?? "", "session.trajectory.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TrajectoryEvent);
    const contextCompiled = trajectoryEvents.find((event) => event.type === "context.compiled");
    expect(contextCompiled?.data?.prompt).toContain("Hello from the replied message");
    expect(contextCompiled?.data?.systemPrompt).toContain("runtime bare mention event");
  });

  it("submits suppressed room event context as the model prompt", async () => {
    let seenPrompt: string | undefined;
    let seenModelMessages: unknown[] | undefined;
    let seenMessages: unknown[] | undefined;
    const runBeforePromptBuild = vi.fn(async () => ({
      prependContext: "dynamic hook context",
      appendContext: "dynamic hook tail",
    }));
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((name: string) => name === "before_prompt_build"),
      runBeforePromptBuild,
      runBeforeAgentStart: vi.fn(),
    });

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      trajectory: true,
      attemptOverrides: {
        prompt: "[OpenClaw room event]",
        transcriptPrompt: "",
        currentInboundEventKind: "room_event",
        currentInboundContext: {
          text: [
            "[OpenClaw room event]",
            "inbound_event_kind: room_event",
            "visible_reply_contract: message_tool_only",
            "Room context:\n#2001 Alice: lunch at 2?\n#2002 Bob: works",
            "Current event:\n#2003 Bob: hey claw summarize the plan",
            "Treat this as observed room activity. Default: no reply; most room events need no response from you. Send a visible reply via message(action=send) only when you are directly addressed or have concrete value to add; your final text here stays private either way.",
          ].join("\n\n"),
        },
        suppressNextUserMessagePersistence: true,
      },
      sessionPrompt: async (session, prompt) => {
        seenPrompt = prompt;
        seenMessages = [...session.messages];
        const transformContext = (
          session.agent as {
            transformContext?: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
          }
        ).transformContext;
        seenModelMessages = await transformContext?.([
          { role: "user", content: [{ type: "text", text: prompt }], timestamp: 1 },
        ]);
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    // The user prompt stays the bare room-event marker; the room context is
    // routed into the runtime-context carrier instead of the user text.
    expect(seenPrompt).toBe("[OpenClaw room event]");
    expect(seenPrompt).not.toContain("inbound_event_kind: room_event");
    expect(seenPrompt).not.toBe("Continue the OpenClaw runtime event.");
    expect(seenPrompt).not.toContain("dynamic hook context");
    expect(seenPrompt).not.toContain("dynamic hook tail");
    const roomRuntimeContext = findRecord(
      requireRecords(seenMessages, "seen messages"),
      (message) => message.customType === "openclaw.runtime-context",
      "runtime context message",
    );
    expect(roomRuntimeContext.content).toContain("inbound_event_kind: room_event");
    expect(roomRuntimeContext.content).toContain("visible_reply_contract: message_tool_only");
    expect(roomRuntimeContext.content).toContain(
      "Current event:\n#2003 Bob: hey claw summarize the plan",
    );
    expect(JSON.stringify(seenModelMessages)).toContain("dynamic hook context");
    expect(JSON.stringify(seenModelMessages)).toContain("dynamic hook tail");
    expect(result.finalPromptText).toBe(seenPrompt);
    const trajectoryEvents = (
      await fs.readFile(path.join(tempPaths[0] ?? "", "session.trajectory.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TrajectoryEvent);
    const contextCompiled = trajectoryEvents.find((event) => event.type === "context.compiled");
    // Room context now rides the runtime-context carrier, not the user prompt.
    expect(contextCompiled?.data?.prompt).not.toContain(
      "visible_reply_contract: message_tool_only",
    );
    expect(contextCompiled?.data?.prompt).toContain("[OpenClaw room event]");
  });

  it("skips blank visible prompts with replay history before provider submission", async () => {
    const lockEvents = trackSessionWriteLocks();
    const sessionPrompt = vi.fn(async () => {
      throw new Error("blank prompt should not be submitted");
    });

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      trajectory: true,
      attemptOverrides: {
        prompt: "  \n\t  ",
      },
      sessionPrompt,
    });

    expect(sessionPrompt).not.toHaveBeenCalled();
    expect(result.finalPromptText).toBeUndefined();
    expect(result.promptError).toBeNull();
    expect(result.messagesSnapshot).toHaveLength(1);
    expectFields(requireRecord(result.messagesSnapshot[0], "messages snapshot seed"), {
      role: "user",
      content: "seed",
    });
    const trajectoryEvents = (
      await fs.readFile(path.join(tempPaths[0] ?? "", "session.trajectory.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TrajectoryEvent);
    expect(trajectoryEvents.some((event) => event.type === "prompt.submitted")).toBe(false);
    const skipped = findRecord(
      trajectoryEvents as Array<Record<string, unknown>>,
      (event) => event.type === "prompt.skipped",
      "prompt skipped event",
    );
    expect(requireRecord(skipped.data, "prompt skipped data").reason).toBe("blank_user_prompt");
    expectInitialLockReleasedBeforePostTurnWrite(lockEvents);
  });

  it("releases the initial session lock before before_agent_run block finalizers", async () => {
    const lockEvents = trackSessionWriteLocks();
    const sessionPrompt = vi.fn(async () => {
      throw new Error("blocked prompt should not be submitted");
    });
    const runBeforeAgentRun = vi.fn(async () => ({
      pluginId: "test-policy",
      decision: { outcome: "block", reason: "Blocked by test policy." },
    }));
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((name: string) => name === "before_agent_run"),
      runBeforeAgentRun,
    });

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      sessionPrompt,
    });

    expect(runBeforeAgentRun).toHaveBeenCalledTimes(1);
    expect(sessionPrompt).not.toHaveBeenCalled();
    expect(result.finalPromptText).toBeUndefined();
    expect(result.promptErrorSource).toBe("hook:before_agent_run");
    expectInitialLockReleasedBeforePostTurnWrite(lockEvents);
  });

  it("preserves provider prompt errors when cleanup reacquire detects session takeover", async () => {
    const providerError = new Error("provider rejected request: HTTP 400");
    let acquireCount = 0;
    let cleanupReacquireSessionFile: string | undefined;
    hoisted.acquireSessionWriteLockMock.mockImplementation(async (params) => {
      acquireCount += 1;
      if (acquireCount === 3) {
        cleanupReacquireSessionFile = params.sessionFile;
        await fs.appendFile(params.sessionFile, '{"type":"message","id":"takeover"}\n', "utf8");
      }
      return { release: async () => {} };
    });

    const error = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      sessionPrompt: async () => {
        throw providerError;
      },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("EmbeddedAttemptSessionTakeoverError");
    expect((error as Error).message).toBe(providerError.message);
    expect((error as Error).cause).toBeInstanceOf(EmbeddedAttemptSessionTakeoverError);
    if (!cleanupReacquireSessionFile) {
      throw new Error("expected cleanup lock reacquire");
    }
    expect(((error as Error).cause as Error).message).toContain(cleanupReacquireSessionFile);
    expect((error as { promptError?: unknown }).promptError).toBe(providerError);
    expect(hoisted.flushPendingToolResultsAfterIdleMock).not.toHaveBeenCalled();
  });

  it("keeps cleanup session takeover fatal when no provider prompt error exists", async () => {
    let releasingCleanupLock = false;
    hoisted.flushPendingToolResultsAfterIdleMock.mockImplementation(async () => {
      releasingCleanupLock = true;
    });
    hoisted.acquireSessionWriteLockMock.mockImplementation(async (params) => ({
      release: async () => {
        if (releasingCleanupLock) {
          throw new EmbeddedAttemptSessionTakeoverError(params.sessionFile);
        }
      },
    }));

    await expect(
      createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey,
        tempPaths,
        sessionPrompt: async (session) => {
          session.messages = [...session.messages, doneMessage];
        },
      }),
    ).rejects.toBeInstanceOf(EmbeddedAttemptSessionTakeoverError);
  });

  it("uses assembled context as the default precheck authority", async () => {
    let sawPrompt = false;
    const hugeHistory = "large raw history ".repeat(2_000);

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

  it("skips the generic precheck when the context engine owns compaction", async () => {
    let sawPrompt = false;
    const hugeHistory = "large raw history ".repeat(2_000);

    const result = await createContextEngineAttemptRunner({
      contextEngine: createTestContextEngine({
        info: {
          id: "test-context-engine",
          name: "Test Context Engine",
          version: "0.0.1",
          ownsCompaction: true,
        },
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
    expect(hoisted.preemptiveCompactionCalls).toHaveLength(0);
  });

  it("keeps the generic precheck active when owning context engine assembly fails", async () => {
    const lockEvents = trackSessionWriteLocks();
    let sawPrompt = false;
    const hugeHistory = "large raw history ".repeat(2_000);

    const result = await createContextEngineAttemptRunner({
      contextEngine: createTestContextEngine({
        info: {
          id: "test-context-engine",
          name: "Test Context Engine",
          version: "0.0.1",
          ownsCompaction: true,
        },
        assemble: async () => {
          throw new Error("assembly failed");
        },
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
    expect(hoisted.preemptiveCompactionCalls).toHaveLength(1);
    expect(hoisted.preemptiveCompactionCalls.at(-1)).not.toHaveProperty("unwindowedMessages");
    expectInitialLockReleasedBeforePostTurnWrite(lockEvents);
  });

  it("repairs tool-result pairing after context engine assembly", async () => {
    let promptMessages: AgentMessage[] = [];

    await createContextEngineAttemptRunner({
      contextEngine: createTestContextEngine({
        assemble: async () => ({
          messages: [
            { role: "user", content: "assembled context", timestamp: 1 },
            {
              role: "toolResult",
              toolCallId: "call_orphan",
              toolUseId: "call_orphan",
              toolName: "read",
              content: [{ type: "text", text: "orphaned result" }],
              timestamp: 2,
            },
          ] as AgentMessage[],
          estimatedTokens: 8,
        }),
      }),
      sessionKey,
      tempPaths,
      sessionPrompt: async (session) => {
        promptMessages = session.messages.map((message) => message as AgentMessage);
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 3 },
        ];
      },
    });

    expect(promptMessages).toContainEqual(
      expect.objectContaining({ role: "user", content: "assembled context" }),
    );
    expect(promptMessages.some((message) => message.role === "toolResult")).toBe(false);
    expect(JSON.stringify(promptMessages)).not.toContain("orphaned result");
  });

  it("honors context engines that opt into preassembly overflow authority", async () => {
    const lockEvents = trackSessionWriteLocks();
    let sawPrompt = false;
    const hugeHistory = "large raw history ".repeat(2_000);

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
    expectInitialLockReleasedBeforePostTurnWrite(lockEvents);
  });

  it("keeps the preassembly overflow precheck active for owning context engines", async () => {
    const lockEvents = trackSessionWriteLocks();
    let sawPrompt = false;
    const hugeHistory = "large raw history ".repeat(2_000);

    const result = await createContextEngineAttemptRunner({
      contextEngine: createTestContextEngine({
        info: {
          id: "test-context-engine",
          name: "Test Context Engine",
          version: "0.0.1",
          ownsCompaction: true,
        },
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
    expect(hoisted.preemptiveCompactionCalls).toHaveLength(1);
    expect(hoisted.preemptiveCompactionCalls.at(-1)).toHaveProperty("unwindowedMessages");
    expectInitialLockReleasedBeforePostTurnWrite(lockEvents);
  });

  it("snapshots pre-assembly messages before assemble even when the engine windows in place", async () => {
    const hugeHistory = "large raw history ".repeat(2_000);
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
    // The snapshot must reflect the true pre-assembly state after LLM-boundary
    // stamping, not the in-place windowed array that assemble mutated.
    expect(unwindowed).toHaveLength(1);
    const [unwindowedMessage] = unwindowed ?? [];
    expect(unwindowedMessage).toMatchObject({ role: "user", timestamp: 1 });
    const unwindowedContent = (unwindowedMessage as { content?: unknown } | undefined)?.content;
    expect(unwindowedContent).toEqual(
      expect.stringMatching(/^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\]]+\] /),
    );
    expect(unwindowedContent).toContain(hugeHistory);
    expect(unwindowedContent).not.toContain("windowed");
  });

  it("passes the boundary-stamped current prompt to llm_input hooks", async () => {
    const runLlmInput = vi.fn(async () => {});
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((name: string) => name === "llm_input"),
      runLlmInput,
    });

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
    });

    const params = mockParams(runLlmInput as MockCallSource, 0, "llm_input params");
    expect(params.prompt).toEqual(
      expect.stringMatching(/^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\]]+\] hello$/),
    );
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
    expect(seen.messages).toStrictEqual([]);
    expect(seen.systemPrompt ?? "").toBe("");
    expect(result.finalPromptText).toBe("hello");
    expect(result.systemPromptReport?.systemPrompt ?? "").toBe("");
    expect(result.messagesSnapshot).toHaveLength(1);
    expectFields(requireRecord(result.messagesSnapshot[0], "gateway model snapshot"), {
      role: "assistant",
      content: "pong",
    });
    expect(hoisted.resolveBootstrapContextForRunMock).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
    expect(afterTurn).not.toHaveBeenCalled();
    expect(runBeforePromptBuild).not.toHaveBeenCalled();
    expect(runLlmInput).not.toHaveBeenCalled();
  });

  it("flushes the embedded session transcript before afterTurn", async () => {
    const events: string[] = [];
    const afterTurn = vi.fn(async () => {
      events.push("afterTurn");
    });
    hoisted.sessionManager.rewriteFile.mockImplementation(() => {
      events.push("flush");
    });

    await createContextEngineAttemptRunner({
      contextEngine: createTestContextEngine({ afterTurn }),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        currentInboundEventKind: "room_event",
        currentInboundContext: { text: "[OpenClaw room event]" },
        suppressNextUserMessagePersistence: true,
        transcriptPrompt: "",
      },
      sessionPrompt: async (session) => {
        session.messages = [...session.messages, doneMessage];
      },
    });

    const afterTurnIndex = events.indexOf("afterTurn");
    expect(afterTurn).toHaveBeenCalledTimes(1);
    expect(afterTurnIndex).not.toBe(-1);
    expect(events.slice(0, afterTurnIndex)).toContain("flush");
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

    expect(events).toContain("bootstrap");
    expect(events).toContain("lock");
    expect(events.indexOf("bootstrap")).toBeLessThan(events.indexOf("lock"));
  });

  it("forwards modelId to assemble", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const contextEngine = createTestContextEngine({ bootstrap, assemble });

    await runBootstrap(sessionKey, contextEngine);
    await runAssemble(sessionKey, contextEngine);

    expect(mockParams(assemble as MockCallSource, 0, "assemble params").model).toBe("gpt-test");
  });

  it("forwards availableTools and citationsMode to assemble", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const contextEngine = createTestContextEngine({ bootstrap, assemble });

    await runBootstrap(sessionKey, contextEngine);
    await runAssemble(sessionKey, contextEngine, {
      availableTools: new Set(["memory_search", "wiki_search"]),
      citationsMode: "on",
    });

    expectFields(mockParams(assemble as MockCallSource, 0, "assemble params"), {
      availableTools: new Set(["memory_search", "wiki_search"]),
      citationsMode: "on",
    });
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

    const assembled = requireRecord(result, "assembled context");
    expect(assembled.estimatedTokens).toBe(1);
    expect(assembled.systemPromptAddition).toBe(
      "## Memory Recall\ntools=memory_search,wiki_search\ncitations=on",
    );
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

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledWith({
      message: doneMessage,
      sessionId: embeddedSessionId,
      sessionKey,
    });
  });

  it("forwards silentExpected to the embedded subscription", () => {
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

  it("forwards the normalized message channel to the embedded subscription", async () => {
    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        messageChannel: "TELEGRAM",
      },
    });

    const subscriptionParams = requireRecord(
      hoisted.subscribeEmbeddedAgentSessionMock.mock.calls[0]?.[0],
      "subscription params",
    );
    expect(subscriptionParams.messageChannel).toBe("telegram");
  });

  it("skips maintenance when afterTurn fails", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const afterTurn = vi.fn(async () => {
      throw new Error("afterTurn failed");
    });

    await finalizeTurn(sessionKey, createTestContextEngine({ bootstrap, assemble, afterTurn }));

    expectCalledWithSessionKey(afterTurn, sessionKey);
    expect(
      hoisted.runContextEngineMaintenanceMock.mock.calls.some(
        ([params]) => requireRecord(params, "maintenance params").reason === "turn",
      ),
    ).toBe(false);
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

    expect(
      hoisted.runContextEngineMaintenanceMock.mock.calls.some(
        ([params]) => requireRecord(params, "maintenance params").reason === "bootstrap",
      ),
    ).toBe(true);
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
    ).toEqual({
      retention: "short",
      lastCallUsage: {
        input: 10,
        output: 5,
        cacheRead: 40,
        cacheWrite: 2,
        total: 57,
      },
      lastCacheTouchAt: 123,
    });
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

    const promptCache = buildLoopPromptCacheInfo({
      messagesSnapshot: [seedMessage, toolUseAssistant],
      prePromptMessageCount: 1,
      retention: "short",
      fallbackLastCacheTouchAt: 123,
    });
    expect(promptCache?.retention).toBe("short");
    expect(promptCache?.lastCallUsage?.cacheRead).toBe(39036);
    expect(promptCache?.lastCallUsage?.cacheWrite).toBe(59934);
    expect(promptCache?.lastCallUsage?.total).toBe(98973);
    expect(promptCache?.lastCacheTouchAt).toBe(Date.parse("2026-04-16T16:49:59.536Z"));
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

    const promptCache = buildLoopPromptCacheInfo({
      messagesSnapshot: [seedMessage, toolUseAssistant],
      prePromptMessageCount: 1,
      retention: "short",
      fallbackLastCacheTouchAt: 123,
    });
    expect(promptCache?.retention).toBe("short");
    expect(promptCache?.lastCallUsage?.total).toBe(3);
    expect(promptCache?.lastCacheTouchAt).toBe(123);
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

    const observationRecord = requireRecord(observation, "prompt cache observation");
    expectFields(observationRecord, {
      broke: true,
      previousCacheRead: 5000,
      cacheRead: 2000,
    });
    expect(
      requireRecords(observationRecord.changes, "prompt cache observation changes").some(
        (change) => change.code === "systemPrompt",
      ),
    ).toBe(true);
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

    expectCalledWithSessionKey(ingestBatch, sessionKey);
    expect(
      hoisted.runContextEngineMaintenanceMock.mock.calls.some(
        ([params]) => requireRecord(params, "maintenance params").reason === "turn",
      ),
    ).toBe(false);
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
      bundleLspRuntime: undefined,
      sessionLock: { release: releaseMock },
    });

    expect(flushMock).toHaveBeenCalledTimes(1);
    expect(disposeMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledTimes(1);
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

    const loopHookParams = mockParams(
      hoisted.installContextEngineLoopHookMock,
      0,
      "context engine loop hook params",
    );
    expect(loopHookParams.midTurnPrecheck).toBeUndefined();
  });

  it("recovers when the runtime persists the mid-turn precheck as an assistant error", async () => {
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

    const syntheticRuntimeError = {
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
        session.messages = [...session.messages, syntheticRuntimeError];
      },
    });

    expect(result.promptErrorSource).toBe("precheck");
    expect(result.preflightRecovery).toEqual({
      route: "compact_only",
      source: "mid-turn",
      estimatedPromptTokens: 9000,
      promptBudgetBeforeReserve: 7000,
      overflowTokens: 2000,
    });
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

    expect(
      mockParams(hoisted.installToolResultContextGuardMock, 0, "tool-result guard params")
        .contextWindowTokens,
    ).toBe(1_000_000);
  });

  it("passes context engines the message budget after reserve and rendered prompt pressure", async () => {
    const contextEngine = createContextEngineBootstrapAndAssemble();
    hoisted.compactionReserveTokens = 20_000;

    await createContextEngineAttemptRunner({
      contextEngine,
      sessionKey,
      tempPaths,
      attemptOverrides: {
        contextTokenBudget: 100_000,
        prompt: "current prompt",
        transcriptPrompt: "current prompt",
      },
    });

    const assembleParams = mockParams(
      contextEngine.assemble as MockCallSource,
      0,
      "assemble params",
    );
    expect(assembleParams.tokenBudget).toBeLessThan(80_000);
    expect(assembleParams.runtimeSettings).toMatchObject({
      limits: {
        maxOutputTokens: 20_000,
      },
    });
  });

  it("preserves the cacheable prefix while bounding current prompt results", async () => {
    const toolText = "process output ".repeat(70);
    const sessionMessages: AgentMessage[] = [{ role: "user", content: "seed", timestamp: 1 }];
    for (let index = 0; index < 8; index += 1) {
      const toolCallId = `call_${index}`;
      sessionMessages.push({
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: "process", input: {} }],
        timestamp: 2 + index * 2,
      } as unknown as AgentMessage);
      sessionMessages.push({
        role: "toolResult",
        toolCallId,
        toolName: "process",
        content: [{ type: "text", text: `${index}: ${toolText}` }],
        isError: false,
        timestamp: 3 + index * 2,
      } as AgentMessage);
    }
    let submittedMessages: AgentMessage[] = [];
    let promptHandlerMessages: AgentMessage[] = [];
    let afterTurnMessages: AgentMessage[] = [];
    const afterTurn = vi.fn(async ({ messages }: { messages: AgentMessage[] }) => {
      afterTurnMessages = messages;
    });

    await createContextEngineAttemptRunner({
      contextEngine: {
        ...createContextEngineBootstrapAndAssemble(),
        afterTurn,
      },
      sessionKey,
      tempPaths,
      sessionMessages,
      attemptOverrides: {
        contextTokenBudget: 128_000,
        config: {
          agents: {
            defaults: {
              contextLimits: {
                toolResultMaxChars: 2_000,
              },
            },
            list: [{ id: "main" }],
          },
        } as OpenClawConfig,
      },
      createSession: () => {
        const session = createDefaultEmbeddedSession({ initialMessages: sessionMessages });
        session.agent.streamFn = async (_model, context) => {
          const providerMessages = (context as { messages?: AgentMessage[] } | undefined)?.messages;
          submittedMessages = providerMessages ?? [];
          return {
            async result() {
              return doneMessage;
            },
            [Symbol.asyncIterator]() {
              return (async function* () {})();
            },
          };
        };
        session.prompt = async (_prompt, options) => {
          for (let index = 0; index < 8; index += 1) {
            session.messages.push({
              role: "toolResult",
              toolCallId: `current_call_${index}`,
              toolName: "process",
              content: [
                { type: "text", text: `current ${index}: ${"current output ".repeat(300)}` },
              ],
              isError: false,
              timestamp: 100 + index,
            } as AgentMessage);
          }
          promptHandlerMessages = session.messages.map((message) => message as AgentMessage);
          options?.preflightResult?.(true);
          await session.agent.streamFn?.({} as never, { messages: session.messages } as never, {});
          session.messages = [...session.messages, doneMessage];
        };
        return session;
      },
    });

    expect(sumToolResultTextChars(sessionMessages)).toBeGreaterThan(4_000);
    expect(sumToolResultTextChars(promptHandlerMessages)).toBeGreaterThan(4_000);
    const submittedCurrentPromptMessages = submittedMessages.slice(sessionMessages.length);
    expect(
      submittedMessages
        .filter((message) => message.role === "toolResult")
        .every((message) => sumToolResultTextChars([message]) <= 2_000),
    ).toBe(true);
    expect(JSON.stringify(submittedCurrentPromptMessages)).toContain("truncated");
    expect(afterTurn).toHaveBeenCalledTimes(1);
    expect(sumToolResultTextChars(afterTurnMessages)).toBeGreaterThan(4_000);
    expect(JSON.stringify(afterTurnMessages)).not.toContain("truncated");
  });

  it("routes aggregate prompt-history truncation to compact-then-truncate before prompt submission", async () => {
    let sawPrompt = false;
    const sessionMessages: AgentMessage[] = [{ role: "user", content: "seed", timestamp: 1 }];
    for (let index = 0; index < 5; index += 1) {
      sessionMessages.push({
        ...makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: `aggregate_${index}`, name: "read", arguments: {} }],
          timestamp: 2 + index * 2,
        }),
      });
      sessionMessages.push({
        role: "toolResult",
        toolCallId: `aggregate_${index}`,
        toolName: "read",
        content: [{ type: "text", text: `${index}: ${"aggregate output ".repeat(900)}` }],
        isError: false,
        timestamp: 3 + index * 2,
      } as AgentMessage);
    }
    sessionMessages.push(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "old turn done" }],
        timestamp: 20,
      }),
    );

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      sessionMessages,
      attemptOverrides: {
        contextTokenBudget: 1_000,
      },
      sessionPrompt: async (session) => {
        sawPrompt = true;
        session.messages = [...session.messages, doneMessage];
      },
    });

    expect(sawPrompt).toBe(false);
    expect(result.promptErrorSource).toBe("precheck");
    expect(result.preflightRecovery).toEqual({ route: "compact_then_truncate" });
    expect(hoisted.preemptiveCompactionCalls).toHaveLength(0);
  });

  it("routes protected trailing aggregate pressure to compact-then-truncate", async () => {
    let sawPrompt = false;
    const sessionMessages: AgentMessage[] = [
      { role: "user", content: "seed", timestamp: 1 },
      makeAgentAssistantMessage({
        content: Array.from({ length: 5 }, (_, index) => ({
          type: "toolCall",
          id: `fresh_${index}`,
          name: "read",
          arguments: {},
        })),
        timestamp: 2,
      }),
    ];
    for (let index = 0; index < 5; index += 1) {
      sessionMessages.push({
        role: "toolResult",
        toolCallId: `fresh_${index}`,
        toolName: "read",
        content: [{ type: "text", text: `${index}: ${"fresh output ".repeat(90)}` }],
        isError: false,
        timestamp: 3 + index,
      } as AgentMessage);
    }

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      sessionMessages,
      attemptOverrides: {
        contextTokenBudget: 1_000,
      },
      sessionPrompt: async (session) => {
        sawPrompt = true;
        session.messages = [...session.messages, doneMessage];
      },
    });

    expect(sawPrompt).toBe(false);
    expect(result.promptErrorSource).toBe("precheck");
    expect(result.preflightRecovery).toEqual({ route: "compact_then_truncate" });
    expect(hoisted.preemptiveCompactionCalls).toHaveLength(0);
  });
});
