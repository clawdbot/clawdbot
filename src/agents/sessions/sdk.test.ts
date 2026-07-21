import { createAssistantMessageEventStream, type AssistantMessage } from "openclaw/plugin-sdk/llm";
// Agent session SDK tests cover default tool wiring, prompt preservation, and
// session write-lock behavior.
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getStreamLlmRuntime } from "../../llm/model-runtime-binding.js";
import type { Model, SimpleStreamOptions } from "../../llm/types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";

const thinkingMocks = vi.hoisted(() => ({
  resolveThinkingDefaultForModel: vi.fn(() => "medium"),
}));
const streamMocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
}));

vi.mock("../../auto-reply/thinking.js", () => ({
  resolveThinkingDefaultForModel: thinkingMocks.resolveThinkingDefaultForModel,
}));
vi.mock("../../llm/stream.js", () => ({
  streamSimple: streamMocks.streamSimple,
}));
import { takeRuntimeUserTurnTranscriptContext } from "../../sessions/user-turn-transcript-runtime-context.js";
import { AuthStorage } from "./auth-storage.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { LoadExtensionsResult, ToolDefinition } from "./extensions/types.js";
import * as publicSessionSdk from "./index.js";
import { getModelRegistryRuntime } from "./model-registry-runtime.js";
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
  contextWindow: 1000,
  maxTokens: 1000,
};

describe("createAgentSession runtime ownership", () => {
  it("keeps embedded recovery construction out of the public sessions barrel", () => {
    expect(publicSessionSdk).not.toHaveProperty("createAgentSessionForEmbeddedRunner");
  });

  it("binds the installed stream wrapper to the model-registry lifecycle", async () => {
    const modelRegistry = createTestModelRegistry();
    const { session } = await createAgentSession({
      model: testModel,
      resourceLoader: createEmptyResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry,
    });

    expect(getStreamLlmRuntime(session.agent.streamFn)).toBe(
      getModelRegistryRuntime(modelRegistry).llmRuntime,
    );
  });
});

function createModelWithoutBaseUrl(overrides: Partial<Model>): Model {
  const { baseUrl: _baseUrl, ...model } = { ...testModel, ...overrides };
  return model as unknown as Model;
}

function createAssistantError(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: testModel.api,
    provider: testModel.provider,
    model: testModel.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: 1,
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

function createEmptyResourceLoader(): ResourceLoader {
  return createResourceLoaderWithHandlers(new Map());
}

function createTestModelRegistry(authStorage = AuthStorage.inMemory()): ModelRegistry {
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  for (const api of ["openai-responses", "bedrock-converse-stream"] as const) {
    modelRegistry.registerProvider(`test-${api}`, {
      api,
      streamSimple: streamMocks.streamSimple,
    });
  }
  return modelRegistry;
}

function createResourceLoaderWithHandlers(
  handlers: Map<string, Array<(...args: unknown[]) => Promise<unknown>>>,
): ResourceLoader {
  const extensionsResult: LoadExtensionsResult = {
    extensions:
      handlers.size > 0
        ? [
            {
              path: "<test-extension>",
              resolvedPath: "<test-extension>",
              sourceInfo: createSyntheticSourceInfo("<test-extension>", { source: "temporary" }),
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

async function createSessionAndStreamModel(model: Model): Promise<SimpleStreamOptions> {
  streamMocks.streamSimple.mockClear();
  const { session } = await createAgentSession({
    model,
    resourceLoader: createEmptyResourceLoader(),
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
    modelRegistry: createTestModelRegistry(),
  });

  await session.agent.streamFn?.(
    model,
    {
      messages: [],
      systemPrompt: "",
      tools: [],
    },
    {},
  );

  return streamMocks.streamSimple.mock.lastCall?.[2] ?? {};
}

function appendPersistedAssistantMessage(params: {
  sessionManager: SessionManager;
  content: unknown;
  stopReason?: "stop" | "aborted";
}) {
  params.sessionManager.appendMessage({
    role: "assistant",
    content: params.content,
    api: "messages",
    provider: "anthropic",
    model: "sonnet-4.6",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: params.stopReason ?? "stop",
    timestamp: Date.now(),
  } as Parameters<SessionManager["appendMessage"]>[0]);
}

async function createSessionFromManager(sessionManager: SessionManager) {
  const { session } = await createAgentSession({
    model: testModel,
    resourceLoader: createEmptyResourceLoader(),
    sessionManager,
    settingsManager: SettingsManager.inMemory(),
    modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
  });
  return session;
}

async function createSessionWithPersistedAssistantContent(content: unknown) {
  const sessionManager = SessionManager.inMemory();
  appendPersistedAssistantMessage({ sessionManager, content });
  return await createSessionFromManager(sessionManager);
}

describe("AgentSession getLastAssistantText", () => {
  it.each([
    {
      name: "legacy string content",
      content: " legacy assistant text ",
      expected: "legacy assistant text",
    },
    {
      name: "normal text blocks",
      content: [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "visible " },
        { type: "text", text: "answer" },
      ],
      expected: "visible answer",
    },
    { name: "null content", content: null, expected: undefined },
    { name: "object content", content: { type: "text", text: "malformed" }, expected: undefined },
  ])("reads $name without throwing", async ({ content, expected }) => {
    const session = await createSessionWithPersistedAssistantContent(content);
    expect(session.getLastAssistantText()).toBe(expected);
  });

  it("skips aborted malformed content and returns the preceding assistant text", async () => {
    const sessionManager = SessionManager.inMemory();
    appendPersistedAssistantMessage({ sessionManager, content: "previous answer" });
    appendPersistedAssistantMessage({
      sessionManager,
      content: null,
      stopReason: "aborted",
    });
    const session = await createSessionFromManager(sessionManager);

    expect(session.getLastAssistantText()).toBe("previous answer");
  });
});

describe("AgentSession queued user turns", () => {
  it("carries prepared transcript context on the exact steered message", async () => {
    const session = await createSessionFromManager(SessionManager.inMemory());
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "visible group prompt",
        sender: { id: "user-42", name: "Ada" },
      },
      target: createTestUserTurnTranscriptTarget(),
    });
    const steer = vi.spyOn(session.agent, "steer").mockImplementation(() => undefined);

    await session.steer("runtime group prompt", undefined, recorder);

    const runtimeMessage = steer.mock.calls[0]?.[0];
    expect(runtimeMessage).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "runtime group prompt" }],
    });
    if (!runtimeMessage) {
      throw new Error("expected queued runtime message");
    }
    expect(takeRuntimeUserTurnTranscriptContext(runtimeMessage)).toMatchObject({
      message: {
        role: "user",
        content: "visible group prompt",
        __openclaw: { senderId: "user-42", senderName: "Ada" },
      },
      recorder,
    });
  });
});

describe("createAgentSession attribution headers", () => {
  it("tolerates Bedrock models that do not expose baseUrl", async () => {
    const options = await createSessionAndStreamModel(
      createModelWithoutBaseUrl({
        id: "global.anthropic.claude-sonnet-4-6",
        provider: "amazon-bedrock",
        api: "bedrock-converse-stream",
      }),
    );

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(options.headers).toBeUndefined();
  });

  it("keeps OpenRouter attribution headers for provider and endpoint matches", async () => {
    const providerOptions = await createSessionAndStreamModel({
      ...testModel,
      provider: "openrouter",
      baseUrl: "https://example.test",
    });
    const endpointOptions = await createSessionAndStreamModel({
      ...testModel,
      provider: "custom-openai",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    expect(providerOptions.headers).toMatchObject({
      "HTTP-Referer": "https://openclaw.ai",
      "X-OpenRouter-Title": "OpenClaw",
      "X-OpenRouter-Categories": "cli-agent",
    });
    expect(endpointOptions.headers).toMatchObject({
      "HTTP-Referer": "https://openclaw.ai",
      "X-OpenRouter-Title": "OpenClaw",
      "X-OpenRouter-Categories": "cli-agent",
    });
  });

  it("keeps Cloudflare attribution headers for provider and endpoint matches", async () => {
    const providerOptions = await createSessionAndStreamModel({
      ...testModel,
      provider: "cloudflare-workers-ai",
      baseUrl: "https://example.test",
    });
    const endpointOptions = await createSessionAndStreamModel({
      ...testModel,
      provider: "custom-openai",
      baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/openai",
    });

    expect(providerOptions.headers).toMatchObject({ "User-Agent": "openclaw" });
    expect(endpointOptions.headers).toMatchObject({ "User-Agent": "openclaw" });
  });
});

describe("createAgentSession tool defaults", () => {
  it("forwards max thinking budgets from settings to the agent", async () => {
    const { session } = await createAgentSession({
      model: testModel,
      resourceLoader: createEmptyResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        thinkingBudgets: {
          high: 16_384,
          max: 32_768,
        },
      }),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    });

    expect(session.agent.thinkingBudgets).toEqual({
      high: 16_384,
      max: 32_768,
    });
  });

  it("keeps custom tools active when only builtin tools are disabled", async () => {
    // `noTools: "builtin"` removes stock tools only; extension/custom tools are
    // still explicitly supplied session capabilities.
    const customTool: ToolDefinition = {
      name: "custom_lookup",
      label: "Custom Lookup",
      description: "Looks up a test value.",
      promptSnippet: "Lookup test values",
      promptGuidelines: ["Use custom_lookup for test values."],
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "ok" }],
        details: {},
      }),
    };

    const { session } = await createAgentSession({
      model: testModel,
      noTools: "builtin",
      customTools: [customTool],
      resourceLoader: createEmptyResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    });

    expect(session.getActiveToolNames()).toEqual(["custom_lookup"]);
    expect(session.getAllTools().map((tool) => tool.name)).toEqual(["custom_lookup"]);

    session.setActiveToolsByName(["bash", "custom_lookup"]);

    expect(session.getActiveToolNames()).toEqual(["custom_lookup"]);
  });

  it("preserves channel-progress visibility for custom tools", async () => {
    const hiddenTool: ToolDefinition = {
      name: "internal_wait",
      label: "Internal Wait",
      hideFromChannelProgress: true,
      description: "Waits for internal work.",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "ok" }],
        details: {},
      }),
    };

    const { session } = await createAgentSession({
      model: testModel,
      noTools: "builtin",
      customTools: [hiddenTool],
      resourceLoader: createEmptyResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    });

    expect(session.agent.state.tools).toEqual([
      expect.objectContaining({
        name: "internal_wait",
        hideFromChannelProgress: true,
      }),
    ]);
  });

  it("preserves an exact base system prompt when active tools change", async () => {
    const customTool: ToolDefinition = {
      name: "custom_lookup",
      label: "Custom Lookup",
      description: "Looks up a test value.",
      promptSnippet: "Lookup test values",
      promptGuidelines: ["Use custom_lookup for test values."],
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "ok" }],
        details: {},
      }),
    };

    const { session } = await createAgentSession({
      model: testModel,
      noTools: "builtin",
      customTools: [customTool],
      resourceLoader: createEmptyResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    });
    const systemPrompt = "You are a personal assistant running inside OpenClaw.";

    session.setBaseSystemPrompt(systemPrompt);
    session.setActiveToolsByName(["bash", "custom_lookup"]);

    expect(session.getActiveToolNames()).toEqual(["custom_lookup"]);
    expect(session.systemPrompt).toBe(systemPrompt);

    const exactPromptOptions = (
      session as unknown as {
        baseSystemPromptOptions: {
          selectedTools?: string[];
          toolSnippets?: Record<string, string>;
          promptGuidelines?: string[];
        };
      }
    ).baseSystemPromptOptions;
    expect(exactPromptOptions.selectedTools).toEqual(["custom_lookup"]);
    expect(exactPromptOptions.toolSnippets).toEqual({
      custom_lookup: "Lookup test values",
    });
    expect(exactPromptOptions.promptGuidelines).toEqual(["Use custom_lookup for test values."]);
  });

  it("runs session message persistence under the configured write lock", async () => {
    // Transcript writes share the caller-provided lock so concurrent event
    // handlers cannot interleave JSONL persistence.
    const events: string[] = [];
    const sessionManager = SessionManager.inMemory();
    const { session } = await createAgentSession({
      model: testModel,
      resourceLoader: createEmptyResourceLoader(),
      sessionManager,
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
      withSessionWriteLock: async (run) => {
        events.push("lock:start");
        try {
          return await run();
        } finally {
          events.push("lock:end");
        }
      },
    });

    const handleAgentEvent = (
      session as unknown as { handleAgentEvent(event: unknown): Promise<void> }
    )["handleAgentEvent"];

    await handleAgentEvent({
      type: "message_end",
      message: {
        role: "user",
        content: "hello",
        timestamp: Date.now(),
      },
    });

    expect(events).toEqual(["lock:start", "lock:end"]);
    expect(sessionManager.getEntries().some((entry) => entry.type === "message")).toBe(true);
  });

  it("runs write-capable tool hooks under the configured write lock", async () => {
    const events: string[] = [];
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      [
        "tool_call",
        [
          async () => {
            events.push("hook");
            return undefined;
          },
        ],
      ],
    ]);

    const { session } = await createAgentSession({
      model: testModel,
      resourceLoader: createResourceLoaderWithHandlers(handlers),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
      withSessionWriteLock: async (run) => {
        events.push("lock:start");
        try {
          return await run();
        } finally {
          events.push("lock:end");
        }
      },
    });

    await session.agent.beforeToolCall?.({
      assistantMessage: {
        role: "assistant",
        content: [],
        api: testModel.api,
        provider: testModel.provider,
        model: testModel.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
      toolCall: { type: "toolCall", id: "call_1", name: "read", arguments: {} },
      args: {},
      context: {
        systemPrompt: "",
        messages: [],
        tools: [],
      },
    });

    expect(events).toEqual(["lock:start", "hook", "lock:end"]);
  });

  it("fences tool execution when no extension hook is registered", async () => {
    // Write-capable tools still enter the lock even without hooks; the lock is
    // about shared session state, not just extension execution.
    const events: string[] = [];
    const { session } = await createAgentSession({
      model: testModel,
      resourceLoader: createEmptyResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
      withSessionWriteLock: async (run) => {
        events.push("lock:start");
        try {
          return await run();
        } finally {
          events.push("lock:end");
        }
      },
    });

    await session.agent.beforeToolCall?.({
      assistantMessage: {
        role: "assistant",
        content: [],
        api: testModel.api,
        provider: testModel.provider,
        model: testModel.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
      toolCall: { type: "toolCall", id: "call_1", name: "write_file", arguments: {} },
      args: {},
      context: {
        systemPrompt: "",
        messages: [],
        tools: [],
      },
    });

    expect(events).toEqual(["lock:start", "lock:end"]);
  });
});

describe("createAgentSession thinking level defaults", () => {
  beforeEach(() => {
    thinkingMocks.resolveThinkingDefaultForModel.mockReset();
    thinkingMocks.resolveThinkingDefaultForModel.mockReturnValue("medium");
  });

  it("uses the provider-specific thinking default for new sessions", async () => {
    thinkingMocks.resolveThinkingDefaultForModel.mockReturnValue("off");

    const ollamaModel = {
      ...testModel,
      provider: "ollama",
      reasoning: true,
      params: { canonicalModelId: "qwen3:8b" },
      compat: { thinkingFormat: "qwen" },
    } satisfies Model;
    const { session } = await createAgentSession({
      model: ollamaModel,
      resourceLoader: createEmptyResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    });

    expect(session.thinkingLevel).toBe("off");
    expect(thinkingMocks.resolveThinkingDefaultForModel).toHaveBeenCalledWith({
      provider: "ollama",
      model: testModel.id,
      catalog: [
        {
          provider: "ollama",
          id: testModel.id,
          api: ollamaModel.api,
          reasoning: true,
          params: { canonicalModelId: "qwen3:8b" },
          compat: { thinkingFormat: "qwen" },
        },
      ],
    });
  });

  it("settings default overrides provider thinking default", async () => {
    thinkingMocks.resolveThinkingDefaultForModel.mockReturnValue("off");

    const { session } = await createAgentSession({
      model: { ...testModel, provider: "ollama", reasoning: true },
      resourceLoader: createEmptyResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ defaultThinkingLevel: "low" }),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    });

    // User-configured settings default beats provider default
    expect(session.thinkingLevel).toBe("low");
  });

  it("uses Ollama policy for custom providers backed by the Ollama API", async () => {
    thinkingMocks.resolveThinkingDefaultForModel.mockReturnValue("off");
    const customOllamaModel = {
      ...testModel,
      provider: "ollama-spark",
      api: "ollama",
      reasoning: true,
    } satisfies Model;

    const { session } = await createAgentSession({
      model: customOllamaModel,
      resourceLoader: createEmptyResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    });

    expect(session.thinkingLevel).toBe("off");
    expect(thinkingMocks.resolveThinkingDefaultForModel).toHaveBeenCalledWith({
      provider: "ollama",
      model: testModel.id,
      catalog: [
        {
          provider: "ollama",
          id: testModel.id,
          api: "ollama",
          reasoning: true,
        },
      ],
    });
  });

  it("falls back to DEFAULT_THINKING_LEVEL for non-off provider defaults", async () => {
    // Non-off provider defaults (adaptive, high, low) preserve prior SDK behaviour
    // to avoid silent cost changes for DeepSeek, OpenRouter, xAI, and Anthropic users.
    for (const nonOffDefault of ["adaptive", "high", "low"] as const) {
      thinkingMocks.resolveThinkingDefaultForModel.mockReturnValue(nonOffDefault);

      const { session } = await createAgentSession({
        model: { ...testModel, reasoning: true },
        resourceLoader: createEmptyResourceLoader(),
        sessionManager: SessionManager.inMemory(),
        settingsManager: SettingsManager.inMemory(),
        modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
      });

      expect(session.thinkingLevel).toBe("medium");
    }
  });

  it("uses provider default for legacy sessions that have no thinking entry", async () => {
    // Sessions created before thinking-level tracking (no thinking_level_change entry)
    // should inherit the provider default, not the hard-coded global "medium".
    thinkingMocks.resolveThinkingDefaultForModel.mockReturnValue("off");

    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });

    const { session } = await createAgentSession({
      model: { ...testModel, provider: "ollama", reasoning: true },
      resourceLoader: createEmptyResourceLoader(),
      sessionManager,
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    });

    expect(session.thinkingLevel).toBe("off");
  });
});

describe("AgentSession retry behavior", () => {
  async function createRetrySession(retry?: { baseDelayMs: number; maxRetries: number }) {
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(testModel.provider, "test-api-key");
    return await createAgentSession({
      model: testModel,
      resourceLoader: createEmptyResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        retry: retry ?? { baseDelayMs: 0, maxRetries: 1 },
      }),
      modelRegistry: createTestModelRegistry(authStorage),
    });
  }

  it("stops permanent errors and retries transient HTTP errors in a session", async () => {
    streamMocks.streamSimple.mockReset();
    const permanentEvents: string[] = [];
    streamMocks.streamSimple.mockImplementation(() =>
      createAssistantResultStream(createAssistantError("model model-x-500-preview not found")),
    );
    const { session: permanentSession } = await createRetrySession();
    permanentSession.subscribe((event) => permanentEvents.push(event.type));

    await permanentSession.prompt("test permanent error");

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(permanentEvents).not.toContain("auto_retry_start");

    const transientEvents: string[] = [];
    streamMocks.streamSimple.mockReset();
    streamMocks.streamSimple
      .mockImplementationOnce(() =>
        createAssistantResultStream(createAssistantError("HTTP 503 temporary provider response")),
      )
      .mockImplementationOnce(() =>
        createAssistantResultStream({
          ...createAssistantError(""),
          content: [{ type: "text", text: "recovered" }],
          stopReason: "stop",
          errorMessage: undefined,
        }),
      );
    const { session: transientSession } = await createRetrySession();
    transientSession.subscribe((event) => transientEvents.push(event.type));

    await transientSession.prompt("test transient error");

    expect(streamMocks.streamSimple.mock.calls.length).toBeGreaterThan(1);
    expect(transientEvents).toContain("auto_retry_start");
    expect(transientEvents).toContain("auto_retry_end");
  });

  it("uses a short server Retry-After as the auto-retry delay floor", async () => {
    vi.useFakeTimers();
    try {
      streamMocks.streamSimple.mockReset();
      streamMocks.streamSimple
        .mockImplementationOnce(() =>
          createAssistantResultStream(
            createAssistantError("HTTP 429: rate limited; Retry-After: 30 seconds"),
          ),
        )
        .mockImplementationOnce(() =>
          createAssistantResultStream({
            ...createAssistantError(""),
            content: [{ type: "text", text: "recovered" }],
            stopReason: "stop",
            errorMessage: undefined,
          }),
        );
      const { session } = await createRetrySession({ baseDelayMs: 2_000, maxRetries: 1 });
      const retryDelays: number[] = [];
      session.subscribe((event) => {
        if (event.type === "auto_retry_start") {
          retryDelays.push(event.delayMs);
        }
      });

      const promptPromise = session.prompt("test Retry-After");
      await vi.advanceTimersByTimeAsync(0);

      expect(retryDelays).toEqual([30_000]);

      await vi.advanceTimersByTimeAsync(30_000);
      await promptPromise;
      expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
