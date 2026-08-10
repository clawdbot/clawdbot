import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamMocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
}));

import {
  bindAgentSessionAccounting,
  type AgentSubmissionObserver,
} from "./agent-session-accounting.js";
import { agentSessionAutomaticCompaction } from "./agent-session-compaction.js";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { LoadExtensionsResult } from "./extensions/types.js";
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
  contextWindow: 100,
  maxTokens: 100,
};

const sessions: AgentSession[] = [];

function createAssistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: testModel.api,
    provider: testModel.provider,
    model: testModel.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      contextUsage: {
        state: "available",
        promptTokens: 1,
        totalTokens: 2,
      },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
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

function appendHistory(sessionManager: SessionManager): void {
  sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: Date.now() - 2 });
  sessionManager.appendMessage({
    ...createAssistant([{ type: "text", text: "historical answer" }]),
    timestamp: Date.now() - 1,
  });
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
              summary: "extension summary",
              firstKeptEntryId: preparation.firstKeptEntryId,
              tokensBefore: preparation.tokensBefore,
            },
          };
        },
      ],
    ],
  ]);
}

async function createTestSession(params: {
  onCoreCompactionInvocation: () => void;
  onExtensionCompactionInvocation?: () => void;
  onAgentSubmission?: AgentSubmissionObserver;
  authStorage?: AuthStorage;
  installApiKey?: boolean;
  sessionManager?: SessionManager;
  settingsManager?: SettingsManager;
  resourceLoader?: ResourceLoader;
}) {
  const authStorage = params.authStorage ?? AuthStorage.inMemory();
  if (params.installApiKey !== false) {
    authStorage.setRuntimeApiKey(testModel.provider, "test-api-key");
  }
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(testModel.provider, {
    api: testModel.api,
    streamSimple: streamMocks.streamSimple,
  });
  const sessionOptions = bindAgentSessionAccounting(
    {
      model: testModel,
      noTools: "builtin" as const,
      resourceLoader: params.resourceLoader ?? createResourceLoader(),
      sessionManager: params.sessionManager ?? SessionManager.inMemory(),
      settingsManager:
        params.settingsManager ??
        SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
      modelRegistry,
    },
    {
      onCoreCompactionInvocation: params.onCoreCompactionInvocation,
      onExtensionCompactionInvocation: params.onExtensionCompactionInvocation,
      onAgentSubmission: params.onAgentSubmission,
    },
  );
  const result = await createAgentSession(sessionOptions);
  sessions.push(result.session);
  return result.session;
}

function createAutoCompactionSettings() {
  return SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
    retry: { enabled: false },
  });
}

function mockInvalidThenTextSummary(recoveredText: string) {
  let requests = 0;
  streamMocks.streamSimple.mockImplementation(() =>
    createAssistantResultStream(
      createAssistant(
        ++requests === 1
          ? [{ type: "thinking", thinking: "internal summary reasoning" }]
          : [{ type: "text", text: recoveredText }],
      ),
    ),
  );
  return () => requests;
}

beforeEach(() => {
  streamMocks.streamSimple.mockReset();
});

afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.dispose();
  }
});

describe("agent session core compaction accounting", () => {
  it("preserves prompt accounting through the SDK session handoff", async () => {
    streamMocks.streamSimple.mockImplementation(() =>
      createAssistantResultStream(createAssistant([{ type: "text", text: "done" }])),
    );
    const settle = vi.fn();
    const onAgentSubmission = vi.fn(() => ({ settle }));
    const session = await createTestSession({
      onCoreCompactionInvocation: vi.fn(),
      onAgentSubmission,
    });

    await session.prompt("new prompt");

    expect(onAgentSubmission).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith("completed");
  });

  it("does not mark extension dispatch when no handler is installed", async () => {
    const sessionManager = SessionManager.inMemory();
    appendHistory(sessionManager);
    streamMocks.streamSimple.mockImplementation(() =>
      createAssistantResultStream(createAssistant([{ type: "text", text: "core summary" }])),
    );
    const onCoreCompactionInvocation = vi.fn();
    const onExtensionCompactionInvocation = vi.fn();
    const session = await createTestSession({
      onCoreCompactionInvocation,
      onExtensionCompactionInvocation,
      sessionManager,
    });

    await expect(session.compact()).resolves.toMatchObject({
      summary: expect.stringContaining("core summary"),
    });

    expect(onExtensionCompactionInvocation).not.toHaveBeenCalled();
    expect(onCoreCompactionInvocation).toHaveBeenCalledOnce();
  });

  it("marks extension dispatch without marking core compaction", async () => {
    const sessionManager = SessionManager.inMemory();
    appendHistory(sessionManager);
    const onCoreCompactionInvocation = vi.fn();
    const onExtensionCompactionInvocation = vi.fn();
    const session = await createTestSession({
      onCoreCompactionInvocation,
      onExtensionCompactionInvocation,
      sessionManager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 10_000 },
        retry: { enabled: false },
      }),
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });

    await expect(session.compact()).resolves.toMatchObject({ summary: "extension summary" });

    expect(onExtensionCompactionInvocation).toHaveBeenCalledOnce();
    expect(onCoreCompactionInvocation).not.toHaveBeenCalled();
  });

  it("marks extension dispatch before cancellation without marking core compaction", async () => {
    const sessionManager = SessionManager.inMemory();
    appendHistory(sessionManager);
    const onCoreCompactionInvocation = vi.fn();
    const onExtensionCompactionInvocation = vi.fn();
    const session = await createTestSession({
      onCoreCompactionInvocation,
      onExtensionCompactionInvocation,
      sessionManager,
      resourceLoader: createResourceLoader(
        new Map([["session_before_compact", [async () => ({ cancel: true })]]]),
      ),
    });

    await expect(session.compact()).rejects.toThrow("Compaction cancelled");

    expect(onExtensionCompactionInvocation).toHaveBeenCalledOnce();
    expect(onCoreCompactionInvocation).not.toHaveBeenCalled();
  });

  it("marks extension dispatch before a thrown handler falls back to core compaction", async () => {
    const sessionManager = SessionManager.inMemory();
    appendHistory(sessionManager);
    streamMocks.streamSimple.mockImplementation(() =>
      createAssistantResultStream(
        createAssistant([{ type: "text", text: "throw fallback summary" }]),
      ),
    );
    const onCoreCompactionInvocation = vi.fn();
    const onExtensionCompactionInvocation = vi.fn();
    const session = await createTestSession({
      onCoreCompactionInvocation,
      onExtensionCompactionInvocation,
      sessionManager,
      resourceLoader: createResourceLoader(
        new Map([
          [
            "session_before_compact",
            [
              async () => {
                throw new Error("extension compaction failed");
              },
            ],
          ],
        ]),
      ),
    });

    await expect(session.compact()).resolves.toMatchObject({
      summary: expect.stringContaining("throw fallback summary"),
    });

    expect(onExtensionCompactionInvocation).toHaveBeenCalledOnce();
    expect(onCoreCompactionInvocation).toHaveBeenCalledOnce();
  });

  it("marks extension dispatch once before falling back to core compaction", async () => {
    const sessionManager = SessionManager.inMemory();
    appendHistory(sessionManager);
    streamMocks.streamSimple.mockImplementation(() =>
      createAssistantResultStream(createAssistant([{ type: "text", text: "fallback summary" }])),
    );
    const onCoreCompactionInvocation = vi.fn();
    const onExtensionCompactionInvocation = vi.fn();
    const session = await createTestSession({
      onCoreCompactionInvocation,
      onExtensionCompactionInvocation,
      sessionManager,
      resourceLoader: createResourceLoader(
        new Map([["session_before_compact", [async () => undefined]]]),
      ),
    });

    await expect(session.compact()).resolves.toMatchObject({
      summary: expect.stringContaining("fallback summary"),
    });

    expect(onExtensionCompactionInvocation).toHaveBeenCalledOnce();
    expect(onCoreCompactionInvocation).toHaveBeenCalledOnce();
  });

  it("does not mark before model preflight succeeds", async () => {
    const sessionManager = SessionManager.inMemory();
    appendHistory(sessionManager);
    const onCoreCompactionInvocation = vi.fn();
    const onExtensionCompactionInvocation = vi.fn();
    const session = await createTestSession({
      onCoreCompactionInvocation,
      onExtensionCompactionInvocation,
      sessionManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });
    vi.spyOn(session, "model", "get").mockReturnValue(undefined);

    await expect(session.compact()).rejects.toThrow("No model selected");

    expect(onCoreCompactionInvocation).not.toHaveBeenCalled();
    expect(onExtensionCompactionInvocation).not.toHaveBeenCalled();
  });

  it("does not mark when manual compaction auth preflight rejects", async () => {
    const sessionManager = SessionManager.inMemory();
    appendHistory(sessionManager);
    const onCoreCompactionInvocation = vi.fn();
    const onExtensionCompactionInvocation = vi.fn();
    const session = await createTestSession({
      onCoreCompactionInvocation,
      onExtensionCompactionInvocation,
      installApiKey: false,
      sessionManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });
    session.agent.streamFn = getModelRegistryRuntime(session.modelRegistry).llmRuntime.streamSimple;

    await expect(session.compact()).rejects.toThrow(/api key/i);

    expect(onCoreCompactionInvocation).not.toHaveBeenCalled();
    expect(onExtensionCompactionInvocation).not.toHaveBeenCalled();
  });

  it("does not mark when automatic compaction auth preflight skips", async () => {
    const authStorage = AuthStorage.inMemory();
    const sessionManager = SessionManager.inMemory();
    appendHistory(sessionManager);
    const onCoreCompactionInvocation = vi.fn();
    const onExtensionCompactionInvocation = vi.fn();
    streamMocks.streamSimple.mockImplementation(() => {
      authStorage.removeRuntimeApiKey(testModel.provider);
      const message = createAssistant([{ type: "text", text: "complete answer" }]);
      message.usage = {
        ...message.usage,
        input: 100,
        totalTokens: 101,
        contextUsage: {
          state: "available",
          promptTokens: 100,
          totalTokens: 101,
        },
      };
      return createAssistantResultStream(message);
    });
    const session = await createTestSession({
      onCoreCompactionInvocation,
      onExtensionCompactionInvocation,
      authStorage,
      sessionManager,
      settingsManager: createAutoCompactionSettings(),
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });
    session.agent.streamFn = getModelRegistryRuntime(session.modelRegistry).llmRuntime.streamSimple;

    await session.prompt("new prompt");

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(onCoreCompactionInvocation).not.toHaveBeenCalled();
    expect(onExtensionCompactionInvocation).not.toHaveBeenCalled();
  });

  it("does not mark before compaction preparation succeeds", async () => {
    const onCoreCompactionInvocation = vi.fn();
    const onExtensionCompactionInvocation = vi.fn();
    const session = await createTestSession({
      onCoreCompactionInvocation,
      onExtensionCompactionInvocation,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });

    await expect(session.compact()).rejects.toThrow();

    expect(onCoreCompactionInvocation).not.toHaveBeenCalled();
    expect(onExtensionCompactionInvocation).not.toHaveBeenCalled();
  });

  it("marks both automatic invalid-summary attempts", async () => {
    const sessionManager = SessionManager.inMemory();
    appendHistory(sessionManager);
    const getSummaryRequests = mockInvalidThenTextSummary("recovered summary");
    const onCoreCompactionInvocation = vi.fn();
    const session = await createTestSession({
      onCoreCompactionInvocation,
      sessionManager,
      settingsManager: createAutoCompactionSettings(),
    });

    await expect(session[agentSessionAutomaticCompaction]()).resolves.toMatchObject({
      summary: expect.stringContaining("recovered summary"),
    });

    expect(getSummaryRequests()).toBe(2);
    expect(onCoreCompactionInvocation).toHaveBeenCalledTimes(2);
  });

  it("marks one manual invalid-summary attempt", async () => {
    const sessionManager = SessionManager.inMemory();
    appendHistory(sessionManager);
    const getSummaryRequests = mockInvalidThenTextSummary("must not be requested");
    const onCoreCompactionInvocation = vi.fn();
    const session = await createTestSession({
      onCoreCompactionInvocation,
      sessionManager,
      settingsManager: createAutoCompactionSettings(),
    });

    await expect(session.compact()).rejects.toThrow(
      "Turn prefix summarization failed: model returned no summary text",
    );

    expect(getSummaryRequests()).toBe(1);
    expect(onCoreCompactionInvocation).toHaveBeenCalledOnce();
  });
});
