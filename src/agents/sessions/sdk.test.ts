import path from "node:path";
import { registerSessionResourceCleanup } from "@openclaw/ai/internal/runtime";
import { createAssistantMessageEventStream, type AssistantMessage } from "openclaw/plugin-sdk/llm";
// Agent session SDK tests cover default tool wiring, prompt preservation, and
// session write-settlement behavior.
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSessionEntry, loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { getStreamLlmRuntime } from "../../llm/model-runtime-binding.js";
import type { ImageContent, Model, SimpleStreamOptions } from "../../llm/types.js";
import { readRuntimePromptImageOrder } from "../../media/media-facts.js";
import { finalizeRuntimePromptImages } from "../../media/runtime-prompt-image-provenance.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";

const thinkingMocks = vi.hoisted(() => ({
  resolveThinkingDefaultForModel: vi.fn(() => "medium"),
}));
const streamMocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
}));
const sdkSessionTempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../../auto-reply/thinking.js", () => ({
  resolveThinkingDefaultForModel: thinkingMocks.resolveThinkingDefaultForModel,
}));
vi.mock("../../llm/stream.js", () => ({
  streamSimple: streamMocks.streamSimple,
}));
import { takeRuntimeUserTurnTranscriptContext } from "../../sessions/user-turn-transcript-runtime-context.js";
import {
  createCompactionHandlers,
  createResourceLoader,
} from "./agent-session-loop-resource-loader.test-support.js";
import { AuthStorage } from "./auth-storage.js";
import type { ToolDefinition } from "./extensions/types.js";
import * as publicSessionSdk from "./index.js";
import { getModelRegistryRuntime } from "./model-registry-runtime.js";
import { ModelRegistry } from "./model-registry.js";
import { createAgentSession, createAgentSessionForEmbeddedRunner } from "./sdk.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

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

  it("keeps durable provider resources when an embedded attempt session is disposed", async () => {
    const cleanup = vi.fn();
    const unregisterCleanup = registerSessionResourceCleanup(cleanup);
    try {
      const sessionManager = SessionManager.inMemory();
      const { session } = await createAgentSessionForEmbeddedRunner(
        {
          model: testModel,
          resourceLoader: createResourceLoader(),
          sessionManager,
          settingsManager: SettingsManager.inMemory(),
          modelRegistry: createTestModelRegistry(),
        },
        {},
      );

      session.dispose();

      expect(cleanup).not.toHaveBeenCalled();
    } finally {
      unregisterCleanup();
    }
  });

  it("binds the installed stream wrapper to the model-registry lifecycle", async () => {
    const modelRegistry = createTestModelRegistry();
    const { session } = await createAgentSession({
      model: testModel,
      resourceLoader: createResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry,
    });

    expect(getStreamLlmRuntime(session.agent.streamFn)).toBe(
      getModelRegistryRuntime(modelRegistry).llmRuntime,
    );
  });

  it("keeps the default SQLite session inside an explicit agent directory", async () => {
    const root = sdkSessionTempDirs.make("openclaw-sdk-session-");
    const agentDir = path.join(root, "isolated-agent");
    const cwd = path.join(root, "explicit-sdk-cwd");
    const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
    try {
      const { session } = await createAgentSession({
        agentDir,
        cwd,
        model: testModel,
        resourceLoader: createResourceLoader(),
        settingsManager: SettingsManager.inMemory(),
        modelRegistry: createTestModelRegistry(),
      });

      const target = session.sessionManager.getSessionTarget();
      if (!target) {
        throw new Error("Expected the default SDK session to have a transcript target");
      }
      expect(target.storePath).toBe(databasePath);
      expect(loadSessionEntry(target)).toMatchObject({ sessionId: target.sessionId });
      await expect(loadTranscriptEvents(target)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "session", id: target.sessionId, cwd }),
        ]),
      );
      session.dispose();
    } finally {
      disposeOpenClawAgentDatabaseByPath(databasePath);
    }
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
    usage: createZeroUsageFixture(),
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

function createRecoveredAssistantStream() {
  return createAssistantResultStream({
    ...createAssistantError(""),
    content: [{ type: "text", text: "recovered" }],
    stopReason: "stop",
    errorMessage: undefined,
  });
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

async function createSessionAndStreamModel(model: Model): Promise<SimpleStreamOptions> {
  streamMocks.streamSimple.mockClear();
  const { session } = await createAgentSession({
    model,
    resourceLoader: createResourceLoader(),
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

function createSessionManagerWithPersistedAssistantMessages(
  messages: Array<{
    content: unknown;
    stopReason?: "stop" | "aborted";
  }>,
): SessionManager {
  const timestamp = new Date().toISOString();
  return SessionManager.fromEntries([
    {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: "sdk-persisted-content",
      timestamp,
      cwd: process.cwd(),
    },
    ...messages.map((message, index) => ({
      type: "message",
      id: `assistant-${String(index + 1)}`,
      parentId: index === 0 ? null : `assistant-${String(index)}`,
      timestamp,
      message: {
        role: "assistant",
        content: message.content,
        api: "messages",
        provider: "anthropic",
        model: "sonnet-4.6",
        usage: createZeroUsageFixture(),
        stopReason: message.stopReason ?? "stop",
        timestamp: Date.now(),
      },
    })),
  ]);
}

async function createSessionFromManager(sessionManager: SessionManager) {
  const { session } = await createAgentSession({
    authStorage: AuthStorage.inMemory(),
    model: testModel,
    resourceLoader: createResourceLoader(),
    sessionManager,
    settingsManager: SettingsManager.inMemory(),
    modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
  });
  return session;
}

async function createSessionWithPersistedAssistantContent(content: unknown) {
  return await createSessionFromManager(
    createSessionManagerWithPersistedAssistantMessages([{ content }]),
  );
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
    const sessionManager = createSessionManagerWithPersistedAssistantMessages([
      { content: "previous answer" },
      { content: null, stopReason: "aborted" },
    ]);
    const session = await createSessionFromManager(sessionManager);

    expect(session.getLastAssistantText()).toBe("previous answer");
  });
});

describe("AgentSession tree navigation", () => {
  it("leaves the tree unchanged when branch summarization returns reasoning only", async () => {
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(testModel.provider, "test-api-key");
    const sessionManager = SessionManager.inMemory();
    const rootId = sessionManager.appendMessage({
      role: "user",
      content: "shared root",
      timestamp: 1,
    });
    const abandonedLeafId = sessionManager.appendMessage({
      role: "user",
      content: "abandoned branch",
      timestamp: 2,
    });
    sessionManager.branch(rootId);
    const targetId = sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "target branch" }],
      api: testModel.api,
      provider: testModel.provider,
      model: testModel.id,
      usage: createZeroUsageFixture(),
      stopReason: "stop",
      timestamp: 3,
    });
    sessionManager.branch(abandonedLeafId);
    streamMocks.streamSimple.mockReset();
    streamMocks.streamSimple.mockImplementation(() =>
      createAssistantResultStream({
        role: "assistant",
        content: [{ type: "thinking", thinking: "internal summary reasoning" }],
        api: testModel.api,
        provider: testModel.provider,
        model: testModel.id,
        usage: createZeroUsageFixture(),
        stopReason: "stop",
        timestamp: 4,
      }),
    );
    const { session } = await createAgentSession({
      authStorage,
      model: testModel,
      resourceLoader: createResourceLoader(),
      sessionManager,
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: createTestModelRegistry(authStorage),
    });
    const entriesBefore = sessionManager.getEntries();
    const leafBefore = sessionManager.getLeafId();

    await expect(session.navigateTree(targetId, { summarize: true })).rejects.toThrow(
      "Branch summary failed: model returned no summary text",
    );

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(sessionManager.getEntries()).toEqual(entriesBefore);
    expect(sessionManager.getLeafId()).toBe(leafBefore);
    expect(sessionManager.getEntries().some((entry) => entry.type === "branch_summary")).toBe(
      false,
    );
    session.dispose();
  });
});

describe("AgentSession queued user turns", () => {
  it("rechecks captured steering ownership after transcript preparation", async () => {
    const session = await createSessionFromManager(SessionManager.inMemory());
    let resolveInput!: () => void;
    const inputReady = new Promise<void>((resolve) => {
      resolveInput = resolve;
    });
    const recorder = createUserTurnTranscriptRecorder({
      resolveInput: async () => {
        await inputReady;
        return { text: "visible prompt" };
      },
      target: createTestUserTurnTranscriptTarget(),
    });
    const steer = vi.spyOn(session.agent, "steer").mockImplementation(() => undefined);
    let canInject = true;
    const queued = session.steer(
      "runtime prompt",
      undefined,
      recorder,
      undefined,
      undefined,
      "queue-identity",
      () => canInject,
    );
    canInject = false;
    resolveInput();

    await expect(queued).rejects.toThrow("active session is finalizing");
    expect(steer).not.toHaveBeenCalled();
  });

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

  it("preserves prompt image ownership across steered and follow-up messages", async () => {
    const session = await createSessionFromManager(SessionManager.inMemory());
    const steer = vi.spyOn(session.agent, "steer").mockImplementation(() => undefined);
    const followUp = vi.spyOn(session.agent, "followUp").mockImplementation(() => undefined);
    const media = [{ path: "/tmp/a.png", contentType: "image/png" }];
    const imageOrder = ["inline"] as const;
    const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
    const { images } = finalizeRuntimePromptImages([{ image, factIndex: 0 }]);

    await session.steer("[media attached: /tmp/a.png (image/png)]", images, undefined, media, [
      ...imageOrder,
    ]);

    const runtimeMessage = steer.mock.calls[0]?.[0];
    expect(runtimeMessage).toBeDefined();
    const mediaSymbol = Object.getOwnPropertySymbols(runtimeMessage ?? {}).find(
      (symbol) => Symbol.keyFor(symbol) === "openclaw.runtimePromptMediaFacts",
    );
    expect(mediaSymbol).toBeDefined();
    if (!runtimeMessage || !mediaSymbol) {
      throw new Error("expected runtime prompt media message and symbol");
    }
    expect((runtimeMessage as unknown as Record<PropertyKey, unknown>)[mediaSymbol]).toEqual([
      expect.objectContaining({ path: "/tmp/a.png", contentType: "image/png", kind: "image" }),
    ]);
    expect(readRuntimePromptImageOrder(runtimeMessage)).toEqual(imageOrder);
    expect((runtimeMessage as unknown as Record<string, unknown>)["__openclaw"]).toEqual({
      mediaImageBlockFactIndexes: [0],
    });
    expect(JSON.stringify(runtimeMessage)).not.toContain("runtimePromptMediaFacts");
    await session.followUp("inspect queued attachment", images);
    expect(followUp.mock.calls[0]?.[0]).toMatchObject({
      __openclaw: { mediaImageBlockFactIndexes: [0] },
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
      resourceLoader: createResourceLoader(),
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
      resourceLoader: createResourceLoader(),
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
      resourceLoader: createResourceLoader(),
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
      resourceLoader: createResourceLoader(),
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

  it("keeps the public manual compaction result inside its write settlement", async () => {
    const observed: unknown[] = [];
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({
      role: "user",
      content: "Earlier context. ".repeat(100),
      timestamp: 1,
    });
    sessionManager.appendMessage({
      role: "user",
      content: "Current question",
      timestamp: 2,
    });
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(testModel.provider, "test-api-key");
    const { session } = await createAgentSession({
      model: testModel,
      sessionManager,
      modelRegistry: createTestModelRegistry(authStorage),
      settingsManager: SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } }),
      resourceLoader: createResourceLoader(createCompactionHandlers()),
      withSessionWriteSettlement: async (run) => {
        const result = await run();
        observed.push(result);
        return result;
      },
    });
    try {
      const result = await session.compact();
      expect(result.summary).toBe("condensed history");
      expect(observed).toEqual([result]);
    } finally {
      session.dispose();
    }
  });

  it("runs session message persistence under the configured write settlement", async () => {
    // Transcript writes share the caller-provided settlement boundary so
    // concurrent event handlers cannot interleave persistence.
    const events: string[] = [];
    const sessionManager = SessionManager.inMemory();
    const { session } = await createAgentSession({
      model: testModel,
      resourceLoader: createResourceLoader(),
      sessionManager,
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
      withSessionWriteSettlement: async (run) => {
        events.push("settlement:start");
        try {
          return await run();
        } finally {
          events.push("settlement:end");
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

    expect(events).toEqual(["settlement:start", "settlement:end"]);
    expect(sessionManager.getEntries().some((entry) => entry.type === "message")).toBe(true);
  });

  it("runs provider response hooks under the configured write settlement", async () => {
    const events: string[] = [];
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      [
        "after_provider_response",
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
      resourceLoader: createResourceLoader(handlers),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
      withSessionWriteSettlement: async (run) => {
        events.push("settlement:start");
        try {
          return await run();
        } finally {
          events.push("settlement:end");
        }
      },
    });

    await session.agent.onResponse?.({ status: 200, headers: {} }, testModel);

    expect(events).toEqual(["settlement:start", "hook", "settlement:end"]);
  });

  it("runs write-capable tool hooks under the configured write settlement", async () => {
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
      resourceLoader: createResourceLoader(handlers),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
      withSessionWriteSettlement: async (run) => {
        events.push("settlement:start");
        try {
          return await run();
        } finally {
          events.push("settlement:end");
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
        usage: createZeroUsageFixture(),
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

    expect(events).toEqual(["settlement:start", "hook", "settlement:end"]);
  });

  it("fences tool execution when no extension hook is registered", async () => {
    // Write-capable tools still enter the settlement boundary even without hooks;
    // it covers shared session state, not just extension execution.
    const events: string[] = [];
    const { session } = await createAgentSession({
      model: testModel,
      resourceLoader: createResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
      withSessionWriteSettlement: async (run) => {
        events.push("settlement:start");
        try {
          return await run();
        } finally {
          events.push("settlement:end");
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
        usage: createZeroUsageFixture(),
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

    expect(events).toEqual(["settlement:start", "settlement:end"]);
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
      resourceLoader: createResourceLoader(),
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
      resourceLoader: createResourceLoader(),
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
      resourceLoader: createResourceLoader(),
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
        resourceLoader: createResourceLoader(),
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
      resourceLoader: createResourceLoader(),
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
      // Retry-only cases need room for the default SDK prompt and reserve.
      model: { ...testModel, contextWindow: 32_768 },
      resourceLoader: createResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        retry: retry ?? { baseDelayMs: 0, maxRetries: 1 },
      }),
      modelRegistry: createTestModelRegistry(authStorage),
    });
  }

  it.each(["permanent", "transient", "refusal"])("handles %s provider errors", async (kind) => {
    const error = createAssistantError(
      kind === "permanent"
        ? "model model-x-500-preview not found"
        : "HTTP 503 temporary provider response",
    );
    if (kind === "refusal") {
      error.diagnostics = [
        {
          type: "provider_refusal",
          timestamp: 0,
          details: { provider: "anthropic", category: "cyber" },
        },
      ];
    }
    streamMocks.streamSimple
      .mockReset()
      .mockImplementationOnce(() => createAssistantResultStream(error))
      .mockImplementation(createRecoveredAssistantStream);
    const { session } = await createRetrySession();
    const events: string[] = [];
    session.subscribe((event) => events.push(event.type));
    try {
      await session.prompt(`test ${kind} error`);
      expect(streamMocks.streamSimple).toHaveBeenCalledTimes(kind === "transient" ? 2 : 1);
      expect(events.filter((event) => event.startsWith("auto_retry_"))).toEqual(
        kind === "transient" ? ["auto_retry_start", "auto_retry_end"] : [],
      );
    } finally {
      session.dispose();
    }
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
        .mockImplementationOnce(createRecoveredAssistantStream);
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
