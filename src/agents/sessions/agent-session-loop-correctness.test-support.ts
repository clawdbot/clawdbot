import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, vi } from "vitest";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import type { ToolDefinition } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import { createAgentSession, createAgentSessionForEmbeddedRunner } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const hoistedStreamMocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
}));

export const streamMocks = hoistedStreamMocks;

export const testModel: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 8_192,
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

export function createOverflowAssistant(activeModel: Model) {
  const contextWindow = activeModel.contextWindow;
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new Error("Overflow fixture requires a finite positive model context window");
  }
  return {
    ...createAssistant(
      activeModel,
      [{ type: "text", text: "truncated answer" }],
      "length",
      contextWindow,
    ),
    usage: { ...createUsage(contextWindow), output: 0 },
  };
}

export const createAutoCompactionSettings = () =>
  SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
    retry: { enabled: false },
  });

export function mockInvalidThenTextSummary(recoveredText: string) {
  let requests = 0;
  streamMocks.streamSimple.mockImplementation((activeModel: Model) => {
    return createAssistantResultStream(
      createAssistant(
        activeModel,
        ++requests === 1
          ? [{ type: "thinking", thinking: "internal summary reasoning" }]
          : [{ type: "text", text: recoveredText }],
      ),
    );
  });
  return () => requests;
}

export async function createTestSession(
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
  return { ...result, modelRegistry, settingsManager, sessionManager };
}

export function appendHistory(sessionManager: SessionManager, assistant: AssistantMessage): void {
  sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: Date.now() - 2 });
  sessionManager.appendMessage({ ...assistant, timestamp: Date.now() - 1 });
}

export function registerAgentSessionLoopTestLifecycle(): void {
  beforeEach(() => {
    streamMocks.streamSimple.mockReset();
  });

  afterEach(() => {
    for (const session of sessions.splice(0)) {
      session.dispose();
    }
  });
}
