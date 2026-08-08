import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { vi } from "vitest";
import type { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { LoadExtensionsResult, ToolDefinition } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import { createAgentSession, createAgentSessionForEmbeddedRunner } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { createSyntheticSourceInfo } from "./source-info.js";

export const testModel: Model = {
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

export function createUsage(contextTokens: number) {
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

export function createAssistant(
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

export function createAssistantResultStream(message: AssistantMessage) {
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

export function createResourceLoader(
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

export function createAgentSessionLoopTestHarness() {
  const streamMocks = { streamSimple: vi.fn() };
  const sessions: AgentSession[] = [];

  async function createTestSession(
    options: {
      model?: Model;
      settingsManager?: SettingsManager;
      sessionManager?: SessionManager;
      resourceLoader?: ResourceLoader;
      customTools?: ToolDefinition[];
      contextOverflowRecoveryOwner?: "session" | "caller";
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
    const sessionOptions = {
      model,
      noTools: "builtin" as const,
      customTools: options.customTools,
      resourceLoader: options.resourceLoader ?? createResourceLoader(),
      sessionManager,
      settingsManager,
      modelRegistry,
    };
    const result = options.contextOverflowRecoveryOwner
      ? await createAgentSessionForEmbeddedRunner(sessionOptions, {
          contextOverflowRecoveryOwner: options.contextOverflowRecoveryOwner,
        })
      : await createAgentSession(sessionOptions);
    sessions.push(result.session);
    return { ...result, settingsManager, sessionManager };
  }

  return {
    createTestSession,
    disposeSessions() {
      for (const session of sessions.splice(0)) {
        session.dispose();
      }
    },
    resetMocks() {
      streamMocks.streamSimple.mockReset();
    },
    streamMocks,
  };
}
