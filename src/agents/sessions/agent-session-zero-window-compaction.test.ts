import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";

const streamMocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
}));

import type { AgentSessionEvent } from "./agent-session-types.js";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { LoadExtensionsResult } from "./extensions/types.js";
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
    noTools: "builtin" as const,
    resourceLoader: options.resourceLoader ?? createResourceLoader(),
    sessionManager,
    settingsManager,
    modelRegistry,
  });
  sessions.push(result.session);
  return { ...result, settingsManager, sessionManager };
}

afterEach(() => {
  for (const session of sessions) {
    session.dispose();
  }
  sessions.length = 0;
  streamMocks.streamSimple.mockReset();
});

describe("AgentSession zero-contextWindow compaction regression", () => {
  it("does not compact when the resolved model contextWindow is zero (#86684)", async () => {
    const zeroWindowModel = { ...testModel, contextWindow: 0 };
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
    const { session, sessionManager } = await createTestSession({
      model: zeroWindowModel,
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
    expect(compactionEvents).toEqual([]);
    expect(sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
    expect(session.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "complete answer" }],
    });
  });
});
