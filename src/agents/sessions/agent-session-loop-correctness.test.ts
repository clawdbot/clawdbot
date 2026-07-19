import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamMocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
}));

import type { AgentTool } from "../runtime/index.js";
import type { AgentSessionEvent } from "./agent-session-types.js";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { LoadExtensionsResult, ToolDefinition } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { createSyntheticSourceInfo } from "./source-info.js";

const testModel: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100,
  maxTokens: 100,
};

const sessions: AgentSession[] = [];

function createUsage(contextTokens: number) {
  return {
    input: contextTokens,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: contextTokens + 1,
    contextUsage: {
      state: "available" as const,
      promptTokens: contextTokens,
      totalTokens: contextTokens + 1,
    },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createAssistant(
  activeModel: Model,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
  contextTokens = 1,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: activeModel.api,
    provider: activeModel.provider,
    model: activeModel.id,
    usage: createUsage(contextTokens),
    stopReason,
    timestamp: Date.now(),
  };
}

function createAssistantResultStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } else {
      stream.push({ type: "done", reason: message.stopReason, message });
    }
    stream.end();
  });
  return stream;
}

function createResourceLoader(
  handlers: Map<string, Array<(...args: unknown[]) => Promise<unknown>>> = new Map(),
): ResourceLoader {
  const extensionsResult: LoadExtensionsResult = {
    extensions:
      handlers.size > 0
        ? [
            {
              path: "<test-extension>",
              resolvedPath: "<test-extension>",
              sourceInfo: createSyntheticSourceInfo("<test-extension>", {
                source: "temporary",
              }),
              handlers,
              tools: new Map(),
              messageRenderers: new Map(),
              commands: new Map(),
              flags: new Map(),
              shortcuts: new Map(),
            },
          ]
        : [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function createCompactionHandlers() {
  return new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
    [
      "session_before_compact",
      [
        async (event: unknown) => {
          const preparation = (
            event as {
              preparation: { firstKeptEntryId: string; tokensBefore: number };
            }
          ).preparation;
          return {
            compaction: {
              summary: "condensed history",
              firstKeptEntryId: preparation.firstKeptEntryId,
              tokensBefore: preparation.tokensBefore,
            },
          };
        },
      ],
    ],
  ]);
}

async function createTestSession(
  options: {
    model?: Model;
    settingsManager?: SettingsManager;
    sessionManager?: SessionManager;
    resourceLoader?: ResourceLoader;
    customTools?: ToolDefinition[];
  } = {},
) {
  const model = options.model ?? testModel;
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(model.provider, "test-api-key");
  const settingsManager =
    options.settingsManager ??
    SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
  const sessionManager = options.sessionManager ?? SessionManager.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(model.provider, {
    api: model.api,
    streamSimple: streamMocks.streamSimple,
  });
  const result = await createAgentSession({
    model,
    noTools: "builtin",
    customTools: options.customTools,
    resourceLoader: options.resourceLoader ?? createResourceLoader(),
    sessionManager,
    settingsManager,
    modelRegistry,
  });
  sessions.push(result.session);
  return { ...result, settingsManager, sessionManager };
}

function appendHistory(sessionManager: SessionManager, assistant: AssistantMessage): void {
  sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: Date.now() - 2 });
  sessionManager.appendMessage({ ...assistant, timestamp: Date.now() - 1 });
}

beforeEach(() => {
  streamMocks.streamSimple.mockReset();
});

afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.dispose();
  }
});

describe("AgentSession loop correctness", () => {
  it("emits agent_settled once after a normal run", async () => {
    const lifecycleEvents: string[] = [];
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      ["agent_end", [async () => lifecycleEvents.push("agent_end")]],
      ["agent_settled", [async () => lifecycleEvents.push("agent_settled")]],
    ]);
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "complete answer" }]),
      ),
    );
    const { session } = await createTestSession({ resourceLoader: createResourceLoader(handlers) });

    await session.prompt("new prompt");

    expect(lifecycleEvents).toEqual(["agent_end", "agent_settled"]);
  });

  it("manually compacts a completed turn smaller than the retained-token budget", async () => {
    const sessionManager = SessionManager.inMemory();
    appendHistory(
      sessionManager,
      createAssistant(testModel, [{ type: "text", text: "short answer" }]),
    );
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 10_000 },
      retry: { enabled: false },
    });
    const { session } = await createTestSession({
      sessionManager,
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });

    const result = await session.compact();

    expect(result.summary).toBe("condensed history");
    expect(sessionManager.getBranch().at(-1)).toMatchObject({
      type: "compaction",
      summary: "condensed history",
    });
  });

  it("keeps a successful high-usage response and performs threshold maintenance without retry", async () => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
      retry: { enabled: false },
    });
    const compactionEvents: AgentSessionEvent[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "complete answer" }], "stop", 100),
      ),
    );
    const { session } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("new prompt");

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(session.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "complete answer" }],
      }),
    );
    expect(compactionEvents).toContainEqual(
      expect.objectContaining({ type: "compaction_end", reason: "threshold", willRetry: false }),
    );
  });

  it("does not retry a high-usage turn terminated by a tool result", async () => {
    const terminalTool: ToolDefinition = {
      name: "finish",
      label: "Finish",
      description: "finishes the current run",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "finished" }],
        details: {},
        terminate: true,
      }),
    };
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
      retry: { enabled: false },
    });
    const compactionEvents: AgentSessionEvent[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(
          activeModel,
          [{ type: "toolCall", id: "call-finish", name: "finish", arguments: {} }],
          "toolUse",
          100,
        ),
      ),
    );
    const { session } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
      customTools: [terminalTool],
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("finish now");

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(compactionEvents).toContainEqual(
      expect.objectContaining({ type: "compaction_end", reason: "threshold", willRetry: false }),
    );
  });

  it("compacts and retries a high-usage length-truncated response", async () => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
      retry: { enabled: false },
    });
    const compactionEvents: AgentSessionEvent[] = [];
    let requestCount = 0;
    streamMocks.streamSimple.mockImplementation((activeModel: Model) => {
      requestCount += 1;
      return createAssistantResultStream(
        requestCount === 1
          ? {
              ...createAssistant(
                activeModel,
                [{ type: "text", text: "truncated answer" }],
                "length",
                100,
              ),
              usage: { ...createUsage(100), output: 0 },
            }
          : createAssistant(activeModel, [{ type: "text", text: "complete retry" }]),
      );
    });
    const { session } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("long request");

    expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
    expect(compactionEvents).toContainEqual(
      expect.objectContaining({ type: "compaction_end", reason: "overflow", willRetry: true }),
    );
    expect(session.getLastAssistantText()).toBe("complete retry");
  });

  it("delivers a pending prompt immediately after pre-prompt compaction", async () => {
    const sessionManager = SessionManager.inMemory();
    appendHistory(
      sessionManager,
      createAssistant(testModel, [{ type: "text", text: "old answer" }], "stop", 100),
    );
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
      retry: { enabled: false },
    });
    const requests: Context[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      requests.push(context);
      return createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "new answer" }]),
      );
    });
    const { session } = await createTestSession({
      sessionManager,
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });
    const continueRun = vi.spyOn(session.agent, "continue");

    await session.prompt("pending prompt");

    expect(continueRun).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.messages)).toContain("pending prompt");
  });

  it("drains a follow-up queued by an agent-end handler", async () => {
    const sessionRef: { current?: AgentSession } = {};
    let queued = false;
    const lifecycleEvents: string[] = [];
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      [
        "agent_end",
        [
          async () => {
            lifecycleEvents.push("agent_end");
            if (!queued) {
              queued = true;
              await sessionRef.current?.followUp("queued after end");
            }
            return undefined;
          },
        ],
      ],
      ["agent_settled", [async () => lifecycleEvents.push("agent_settled")]],
    ]);
    const requests: Context[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      requests.push(context);
      return createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: `answer ${requests.length}` }]),
      );
    });
    const { session } = await createTestSession({ resourceLoader: createResourceLoader(handlers) });
    sessionRef.current = session;

    await session.prompt("initial prompt");

    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]?.messages)).toContain("queued after end");
    expect(session.agent.hasQueuedMessages()).toBe(false);
    expect(lifecycleEvents).toEqual(["agent_end", "agent_end", "agent_settled"]);
  });

  it("leaves queued messages dormant after a turn handoff", async () => {
    const sessionRef: { current?: AgentSession } = {};
    const settled = vi.fn();
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      ["agent_settled", [async () => settled()]],
    ]);
    const yieldTool: ToolDefinition = {
      name: "yield_turn",
      label: "Yield turn",
      description: "ends the current turn for an external handoff",
      parameters: Type.Object({}),
      execute: async () => {
        const activeSession = sessionRef.current;
        if (!activeSession) {
          throw new Error("session not ready");
        }
        activeSession.agent.steer({
          role: "custom",
          customType: "test.turn-handoff",
          content: "resume only for external delivery",
          display: false,
          timestamp: Date.now(),
        });
        activeSession.agent.abort({ code: "turn_handoff", turnHandoff: true });
        return { content: [{ type: "text", text: "yielded" }], details: { yielded: true } };
      },
    };
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(
          activeModel,
          [{ type: "toolCall", id: "call-yield", name: "yield_turn", arguments: {} }],
          "toolUse",
        ),
      ),
    );
    const { session } = await createTestSession({
      customTools: [yieldTool],
      resourceLoader: createResourceLoader(handlers),
    });
    sessionRef.current = session;

    await session.prompt("yield now");

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(session.agent.hasQueuedMessages()).toBe(true);
    expect(settled).not.toHaveBeenCalled();
    session.agent.clearAllQueues();
  });

  it("applies session model, tool, and prompt changes on the following tool turn", async () => {
    const nextModel = { ...testModel, id: "next-model" };
    const sessionRef: { current?: AgentSession } = {};
    const switchTool: ToolDefinition = {
      name: "switch_state",
      label: "Switch state",
      description: "changes the next turn state",
      parameters: Type.Object({}),
      execute: async () => {
        const activeSession = sessionRef.current;
        if (!activeSession) {
          throw new Error("session not ready");
        }
        activeSession.setActiveToolsByName(["second_tool"]);
        activeSession.agent.state.model = nextModel;
        return { content: [{ type: "text", text: "switched" }], details: {} };
      },
    };
    const secondTool: ToolDefinition = {
      name: "second_tool",
      label: "Second tool",
      description: "available after the switch",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
    };
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      ["before_agent_start", [async () => ({ systemPrompt: "prompt override" })]],
    ]);
    const requests: Array<{ model: string; prompt: string; tools: string[] }> = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      requests.push({
        model: activeModel.id,
        prompt: context.systemPrompt ?? "",
        tools: context.tools?.map((tool) => tool.name) ?? [],
      });
      const content: AssistantMessage["content"] =
        requests.length === 1
          ? [{ type: "toolCall", id: "call-switch", name: "switch_state", arguments: {} }]
          : [{ type: "text", text: "finished" }];
      return createAssistantResultStream(
        createAssistant(activeModel, content, requests.length === 1 ? "toolUse" : "stop"),
      );
    });
    const { session } = await createTestSession({
      resourceLoader: createResourceLoader(handlers),
      customTools: [switchTool, secondTool],
    });
    sessionRef.current = session;
    session.setActiveToolsByName(["switch_state"]);

    await session.prompt("switch now");

    expect(requests).toEqual([
      { model: testModel.id, prompt: "prompt override", tools: ["switch_state"] },
      { model: nextModel.id, prompt: "prompt override", tools: ["second_tool"] },
    ]);
  });

  it("preserves explicit updates from an existing next-turn hook", async () => {
    const hookModel = { ...testModel, id: "hook-model" };
    const hookTool: AgentTool = {
      name: "hook_tool",
      label: "Hook tool",
      description: "provided by the existing turn hook",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
    };
    const hookContext = {
      systemPrompt: "hook prompt",
      messages: [],
      tools: [hookTool],
    };
    let returnedUpdate = false;
    const { session } = await createTestSession();
    session.agent.prepareNextTurn = () => {
      if (returnedUpdate) {
        return undefined;
      }
      returnedUpdate = true;
      return { context: hookContext, model: hookModel, thinkingLevel: "high" };
    };
    const contextualHook = session.agent.prepareNextTurnWithContext;
    if (!contextualHook) {
      throw new Error("context-aware next-turn hook was not installed");
    }
    const message = createAssistant(testModel, [{ type: "text", text: "turn complete" }]);
    const newMessages = [message];

    const firstUpdate = await contextualHook({
      message,
      toolResults: [],
      context: { systemPrompt: "loop prompt", messages: [], tools: [] },
      newMessages,
    });
    const secondUpdate = await contextualHook({
      message,
      toolResults: [],
      context: firstUpdate?.context ?? hookContext,
      newMessages,
    });

    for (const update of [firstUpdate, secondUpdate]) {
      expect(update).toMatchObject({
        context: {
          systemPrompt: "hook prompt",
          tools: [expect.objectContaining({ name: "hook_tool" })],
        },
        model: hookModel,
        thinkingLevel: "high",
      });
    }
  });

  it("preserves fields omitted by an existing next-turn context replacement", async () => {
    const sessionTool: AgentTool = {
      name: "session_tool",
      label: "Session tool",
      description: "available in session state",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
    };
    const initialHook = vi.fn(() => ({
      context: { systemPrompt: "stale prompt", messages: [], tools: [sessionTool] },
    }));
    const replacementHook = vi.fn(() => ({
      context: { systemPrompt: "replacement prompt", messages: [] },
    }));
    const { session } = await createTestSession({ customTools: [sessionTool] });
    session.setActiveToolsByName([sessionTool.name]);
    session.agent.prepareNextTurn = initialHook;
    session.agent.prepareNextTurn = replacementHook;
    const message = createAssistant(testModel, [{ type: "text", text: "turn complete" }]);
    const contextualHook = session.agent.prepareNextTurnWithContext;
    if (!contextualHook) {
      throw new Error("context-aware next-turn hook was not installed");
    }

    const update = await contextualHook({
      message,
      toolResults: [],
      context: { systemPrompt: "loop prompt", messages: [], tools: [sessionTool] },
      newMessages: [message],
    });

    expect(update?.context).toEqual({ systemPrompt: "replacement prompt", messages: [] });
    expect(replacementHook).toHaveBeenCalledOnce();
    expect(initialHook).not.toHaveBeenCalled();
  });

  it("aborts in-flight work when disposed", async () => {
    let providerSignal: AbortSignal | undefined;
    streamMocks.streamSimple.mockImplementation(
      (activeModel: Model, _context: Context, options?: SimpleStreamOptions) => {
        providerSignal = options?.signal;
        const stream = createAssistantMessageEventStream();
        options?.signal?.addEventListener(
          "abort",
          () => {
            const message = createAssistant(activeModel, [], "aborted");
            stream.push({ type: "error", reason: "aborted", error: message });
            stream.end();
          },
          { once: true },
        );
        return stream;
      },
    );
    const { session } = await createTestSession();
    const abortRetry = vi.spyOn(session, "abortRetry");
    const abortCompaction = vi.spyOn(session, "abortCompaction");
    const abortBranchSummary = vi.spyOn(session, "abortBranchSummary");
    const abortBash = vi.spyOn(session, "abortBash");
    const abortAgent = vi.spyOn(session.agent, "abort");
    abortRetry.mockImplementationOnce(() => {
      throw new Error("retry abort failed");
    });
    const prompt = session.prompt("wait");
    await vi.waitFor(() => expect(providerSignal).toBeDefined());

    session.dispose();
    await prompt;

    expect(providerSignal?.aborted).toBe(true);
    expect(abortRetry).toHaveBeenCalledOnce();
    expect(abortCompaction).toHaveBeenCalledOnce();
    expect(abortBranchSummary).toHaveBeenCalledOnce();
    expect(abortBash).toHaveBeenCalledOnce();
    expect(abortAgent).toHaveBeenCalledOnce();
  });

  it("resynchronizes queue modes when settings reload", async () => {
    const settingsManager = SettingsManager.inMemory({
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const { session } = await createTestSession({ settingsManager });
    settingsManager.setSteeringMode("all");
    settingsManager.setFollowUpMode("all");
    await settingsManager.flush();

    expect(session.agent.steeringMode).toBe("one-at-a-time");
    expect(session.agent.followUpMode).toBe("one-at-a-time");

    await session.reload();

    expect(session.agent.steeringMode).toBe("all");
    expect(session.agent.followUpMode).toBe("all");
  });
});
