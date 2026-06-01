import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Model } from "../../llm/types.js";
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
  contextWindow: 1000,
  maxTokens: 1000,
};

function createEmptyResourceLoader(): ResourceLoader {
  return createResourceLoaderWithHandlers(new Map());
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
