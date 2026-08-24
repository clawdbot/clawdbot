// End-to-end embedded-agent runner tests with mocked model/runtime seams.
import path from "node:path";
import "./test-helpers/fast-coding-tools.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";
import { resolveEmbeddedAuthCooldownProbePolicy as resolveEmbeddedAuthCooldownProbePolicyActual } from "./embedded-agent-runner/run/auth-controller.js";
import {
  buildEmbeddedRunnerAssistant,
  cleanupEmbeddedAgentRunnerTestWorkspace,
  createMockUsage,
  createEmbeddedAgentRunnerOpenAiConfig as createBaseEmbeddedAgentRunnerOpenAiConfig,
  createResolvedEmbeddedRunnerModel,
  createEmbeddedAgentRunnerTestWorkspace,
  type EmbeddedAgentRunnerTestWorkspace,
  immediateEnqueue,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "./test-helpers/embedded-agent-runner-e2e-mocks.js";

type EmbeddedRunnerModelResolution =
  | ReturnType<typeof createResolvedEmbeddedRunnerModel>
  | {
      model?: undefined;
      error: string;
      authStorage: { setRuntimeApiKey: () => undefined };
      modelRegistry: Record<string, never>;
    };

const runEmbeddedAttemptMock = vi.fn();
const disposeSessionMcpRuntimeMock = vi.fn<(sessionId: string) => Promise<void>>(async () => {
  return undefined;
});
const resolveSessionKeyForRequestMock = vi.fn();
const resolveStoredSessionKeyForSessionIdMock = vi.fn();
const resolveModelAsyncMock = vi.fn(
  async (provider: string, modelId: string): Promise<EmbeddedRunnerModelResolution> =>
    createResolvedEmbeddedRunnerModel(provider, modelId),
);
const ensureOpenClawModelsJsonMock = vi.fn(async () => ({ wrote: false }));
const loggerWarnMock = vi.fn();
let refreshRuntimeAuthOnFirstPromptError = false;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let setRuntimeConfigSnapshot: typeof import("../config/config.js").setRuntimeConfigSnapshot;
let getReplyPayloadMetadata: typeof import("../auto-reply/reply-payload.js").getReplyPayloadMetadata;

vi.mock("openclaw/plugin-sdk/llm", async () => {
  const actual =
    await vi.importActual<typeof import("openclaw/plugin-sdk/llm")>("openclaw/plugin-sdk/llm");

  const buildAssistantMessage = (model: { api: string; provider: string; id: string }) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "ok" }],
    stopReason: "stop" as const,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createMockUsage(1, 1),
    timestamp: Date.now(),
  });

  const buildAssistantErrorMessage = (model: { api: string; provider: string; id: string }) => ({
    role: "assistant" as const,
    content: [],
    stopReason: "error" as const,
    errorMessage: "boom",
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createMockUsage(0, 0),
    timestamp: Date.now(),
  });

  return {
    ...actual,
    complete: async (model: { api: string; provider: string; id: string }) => {
      if (model.id === "mock-error") {
        return buildAssistantErrorMessage(model);
      }
      return buildAssistantMessage(model);
    },
    completeSimple: async (model: { api: string; provider: string; id: string }) => {
      if (model.id === "mock-error") {
        return buildAssistantErrorMessage(model);
      }
      return buildAssistantMessage(model);
    },
    streamSimple: (model: { api: string; provider: string; id: string }) => {
      const stream = actual.createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message:
            model.id === "mock-error"
              ? buildAssistantErrorMessage(model)
              : buildAssistantMessage(model),
        });
        stream.end();
      });
      return stream;
    },
  };
});

const installRunEmbeddedMocks = () => {
  // Install only the runtime seams needed by runner orchestration so tests avoid
  // loading real providers, MCP runtimes, or gateway side effects.
  installEmbeddedRunnerBaseE2eMocks({ hookRunner: "full" });
  installEmbeddedRunnerFastRunE2eMocks({
    runEmbeddedAttempt: (params) => runEmbeddedAttemptMock(params),
  });
  vi.doMock("./command/session.js", async () => {
    const actual =
      await vi.importActual<typeof import("./command/session.js")>("./command/session.js");
    return {
      ...actual,
      resolveSessionKeyForRequestCore: (opts: unknown) => resolveSessionKeyForRequestMock(opts),
      resolveStoredSessionKeyForSessionId: (opts: unknown) =>
        resolveStoredSessionKeyForSessionIdMock(opts),
    };
  });
  vi.doMock("./embedded-agent-runner/logger.js", async () => {
    const actual = await vi.importActual<typeof import("./embedded-agent-runner/logger.js")>(
      "./embedded-agent-runner/logger.js",
    );
    return {
      ...actual,
      log: {
        ...actual.log,
        warn: (...args: unknown[]) => loggerWarnMock(...args),
      },
    };
  });
  vi.doMock("./agent-bundle-mcp-tools.js", () => ({
    disposeSessionMcpRuntime: (sessionId: string) => disposeSessionMcpRuntimeMock(sessionId),
    retireSessionMcpRuntimeForSessionKey: () => Promise.resolve(false),
    retireSessionMcpRuntime: ({ sessionId }: { sessionId?: string | null }) =>
      sessionId ? disposeSessionMcpRuntimeMock(sessionId) : Promise.resolve(false),
  }));
  vi.doMock("./embedded-agent-runner/model.js", async () => {
    const actual = await vi.importActual<typeof import("./embedded-agent-runner/model.js")>(
      "./embedded-agent-runner/model.js",
    );
    return {
      ...actual,
      resolveModelAsync: (...args: Parameters<typeof resolveModelAsyncMock>) =>
        resolveModelAsyncMock(...args),
    };
  });
  vi.doMock("./embedded-agent-runner/run/auth-controller.js", () => ({
    createEmbeddedRunAuthController: () => ({
      advanceAuthProfile: vi.fn(async () => false),
      initializeAuthProfile: vi.fn(async () => undefined),
      maybeRefreshRuntimeAuthForAuthError: vi.fn(async (_errorText: string, runtimeAuthRetry) => {
        return refreshRuntimeAuthOnFirstPromptError && runtimeAuthRetry !== true;
      }),
      stopRuntimeAuthRefreshTimer: vi.fn(),
    }),
    resolveEmbeddedAuthCooldownProbePolicy: resolveEmbeddedAuthCooldownProbePolicyActual,
  }));
  vi.doMock("./models-config.js", async () => {
    const mod = await vi.importActual<typeof import("./models-config.js")>("./models-config.js");
    return {
      ...mod,
      ensureOpenClawModelsJson: (...args: Parameters<typeof ensureOpenClawModelsJsonMock>) =>
        ensureOpenClawModelsJsonMock(...args),
    };
  });
};

type ProductionRunEmbeddedAgent = typeof import("./embedded-agent-runner/run.js").runEmbeddedAgent;
type TestRunEmbeddedAgent = (
  params: Omit<Parameters<ProductionRunEmbeddedAgent>[0], "admittedRunContext">,
) => ReturnType<ProductionRunEmbeddedAgent>;
let runEmbeddedAgent: TestRunEmbeddedAgent;
let SessionManager: typeof import("openclaw/plugin-sdk/agent-sessions").SessionManager;
let loadTranscriptEvents: typeof import("../config/sessions/session-accessor.js").loadTranscriptEvents;
let upsertSessionEntryCore: typeof import("../config/sessions/session-accessor.js").upsertSessionEntryCore;
let resolveAgentRunSessionTarget: typeof import("./run-session-target.js").resolveAgentRunSessionTarget;
let e2eWorkspace: EmbeddedAgentRunnerTestWorkspace | undefined;
let agentDir: string;
let workspaceDir: string;
let sessionStorePath: string;
let sessionCounter = 0;
let runCounter = 0;

const createEmbeddedAgentRunnerOpenAiConfig = (modelIds: string[]) => {
  const config = createBaseEmbeddedAgentRunnerOpenAiConfig(modelIds);
  const mainAgent = config.agents?.list?.find((entry) => entry.id === "main");
  if (mainAgent) {
    mainAgent.default = true;
  }
  return { ...config, session: { store: sessionStorePath } };
};

beforeAll(async () => {
  vi.useRealTimers();
  vi.resetModules();
  installRunEmbeddedMocks();
  ({ getReplyPayloadMetadata } = await import("../auto-reply/reply-payload.js"));
  ({ clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } = await import("../config/config.js"));
  runEmbeddedAgent = wrapRunWithTestPreparedAdmission(
    (await import("./embedded-agent-runner/run.js")).runEmbeddedAgent,
  );
  ({ SessionManager } = await import("openclaw/plugin-sdk/agent-sessions"));
  ({ loadTranscriptEvents, upsertSessionEntryCore } =
    await import("../config/sessions/session-accessor.js"));
  ({ resolveAgentRunSessionTarget } = await import("./run-session-target.js"));
  e2eWorkspace = await createEmbeddedAgentRunnerTestWorkspace("openclaw-embedded-agent-");
  ({ agentDir, workspaceDir } = e2eWorkspace);
  sessionStorePath = path.join(e2eWorkspace.tempRoot, "sessions.json");
}, 180_000);

afterAll(async () => {
  await cleanupEmbeddedAgentRunnerTestWorkspace(e2eWorkspace);
  e2eWorkspace = undefined;
});

beforeEach(() => {
  clearRuntimeConfigSnapshot();
  vi.useRealTimers();
  runEmbeddedAttemptMock.mockReset();
  disposeSessionMcpRuntimeMock.mockReset();
  resolveSessionKeyForRequestMock.mockReset();
  resolveStoredSessionKeyForSessionIdMock.mockReset();
  resolveModelAsyncMock.mockReset();
  resolveModelAsyncMock.mockImplementation(async (provider: string, modelId: string) =>
    createResolvedEmbeddedRunnerModel(provider, modelId),
  );
  ensureOpenClawModelsJsonMock.mockReset();
  ensureOpenClawModelsJsonMock.mockResolvedValue({ wrote: false });
  loggerWarnMock.mockReset();
  refreshRuntimeAuthOnFirstPromptError = false;
  runEmbeddedAttemptMock.mockImplementation(async () => {
    throw new Error("unexpected extra runEmbeddedAttempt call");
  });
});

const nextSessionCompatibilityKey = () => {
  sessionCounter += 1;
  return `in-memory:embedded-compat-${sessionCounter}`;
};
const nextRunId = (prefix = "run-embedded-test") => `${prefix}-${++runCounter}`;
const nextSessionKey = () => `agent:test:embedded:${nextRunId("session-key")}`;

const resolveTestSessionTarget = async (params: {
  config?: ReturnType<typeof createEmbeddedAgentRunnerOpenAiConfig>;
  sessionId: string;
  sessionKey: string;
}) =>
  await resolveAgentRunSessionTarget({
    config: params.config,
    missingSessionKey: "create",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  });

const createPersistedTestSessionManager = async (params: {
  config?: ReturnType<typeof createEmbeddedAgentRunnerOpenAiConfig>;
  sessionId: string;
  sessionKey: string;
}) => {
  const target = await resolveTestSessionTarget(params);
  await upsertSessionEntryCore(
    { agentId: target.agentId, sessionKey: target.sessionKey, storePath: target.storePath },
    { sessionId: target.sessionId, updatedAt: Date.now() },
  );
  return SessionManager.open(target, workspaceDir);
};

const runWithOrphanedSingleUserMessage = async (text: string, sessionKey: string) => {
  // Builds a session with an orphaned user message to exercise retry/resume
  // cleanup paths from the canonical persisted transcript.
  const sessionFile = nextSessionCompatibilityKey();
  const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
  const sessionManager = await createPersistedTestSessionManager({
    config: cfg,
    sessionId: "session:test",
    sessionKey,
  });
  sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  });

  runEmbeddedAttemptMock.mockResolvedValueOnce(
    makeEmbeddedRunnerAttempt({
      assistantTexts: ["ok"],
      lastAssistant: buildEmbeddedRunnerAssistant({
        content: [{ type: "text", text: "ok" }],
      }),
    }),
  );

  return await runEmbeddedAgent({
    sessionId: "session:test",
    sessionKey,
    sessionFile,
    workspaceDir,
    config: cfg,
    prompt: "hello",
    provider: "openai",
    model: "mock-1",
    timeoutMs: 5_000,
    agentDir,
    runId: nextRunId("orphaned-user"),
    enqueue: immediateEnqueue,
  });
};

const textFromContent = (content: unknown) => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content) && content[0]?.type === "text") {
    return (content[0] as { text?: string }).text;
  }
  return undefined;
};

const readSessionMessages = async (params: {
  config?: ReturnType<typeof createEmbeddedAgentRunnerOpenAiConfig>;
  sessionId: string;
  sessionKey: string;
}) => {
  const entries = await loadTranscriptEvents(await resolveTestSessionTarget(params));
  return entries
    .filter((entry): entry is { message?: { role?: string; content?: unknown }; type: "message" } =>
      Boolean(entry && typeof entry === "object" && "type" in entry && entry.type === "message"),
    )
    .map((entry) => entry.message);
};

const runDefaultEmbeddedTurn = async (sessionFile: string, prompt: string, sessionKey: string) => {
  const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-error"]);
  runEmbeddedAttemptMock.mockResolvedValueOnce(
    makeEmbeddedRunnerAttempt({
      assistantTexts: ["ok"],
      lastAssistant: buildEmbeddedRunnerAssistant({
        content: [{ type: "text", text: "ok" }],
      }),
    }),
  );
  await runEmbeddedAgent({
    sessionId: "session:test",
    sessionKey,
    sessionFile,
    workspaceDir,
    config: cfg,
    prompt,
    provider: "openai",
    model: "mock-error",
    timeoutMs: 5_000,
    agentDir,
    runId: nextRunId("default-turn"),
    enqueue: immediateEnqueue,
  });
};

const addAnthropicProvider = (
  cfg: ReturnType<typeof createEmbeddedAgentRunnerOpenAiConfig>,
  modelIds: string[],
) => ({
  ...cfg,
  models: {
    providers: {
      ...cfg.models?.providers,
      anthropic: {
        api: "anthropic-messages" as const,
        apiKey: "sk-test",
        baseUrl: "https://example.com",
        models: modelIds.map((id) => ({
          id,
          name: `Mock ${id}`,
          reasoning: false,
          input: ["text" as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 16_000,
          maxTokens: 2048,
        })),
      },
    },
  },
});

const mockSuccessfulEmbeddedAttempt = () => {
  runEmbeddedAttemptMock.mockResolvedValueOnce(
    makeEmbeddedRunnerAttempt({
      assistantTexts: ["ok"],
      lastAssistant: buildEmbeddedRunnerAssistant({
        content: [{ type: "text", text: "ok" }],
      }),
    }),
  );
};

function firstMockCall(mock: { mock: { calls: unknown[][] } }, label: string): unknown[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`Expected ${label} to be called`);
  }
  return call;
}

function firstRunEmbeddedAttemptParams(): { sessionKey?: string } {
  return firstMockCall(runEmbeddedAttemptMock, "embedded attempt")[0] as { sessionKey?: string };
}

describe("runEmbeddedAgent", () => {
  it("uses the configured default model when the caller omits provider and model", async () => {
    const sessionFile = nextSessionCompatibilityKey();
    const cfg = {
      ...createEmbeddedAgentRunnerOpenAiConfig([]),
      agents: {
        defaults: {
          model: {
            primary: "openrouter/global-default",
          },
        },
        list: [{ id: "research", model: "openrouter/research-default" }],
      },
    };
    mockSuccessfulEmbeddedAttempt();

    await runEmbeddedAgent({
      sessionId: "configured-default-model",
      sessionFile,
      workspaceDir,
      config: cfg,
      agentId: "research",
      prompt: "hello",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("configured-default-model"),
      enqueue: immediateEnqueue,
    });

    expect(resolveModelAsyncMock).toHaveBeenNthCalledWith(
      1,
      "openrouter",
      "openrouter/research-default",
      agentDir,
      cfg,
      expect.objectContaining({ skipAgentDiscovery: true }),
    );
  });

  it("uses runtime config for blank public runtime model overrides", async () => {
    const sessionFile = nextSessionCompatibilityKey();
    const baseConfig = createEmbeddedAgentRunnerOpenAiConfig([]);
    const cfg = {
      ...baseConfig,
      agents: {
        ...baseConfig.agents,
        defaults: {
          model: {
            primary: "openrouter/runtime-default",
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    mockSuccessfulEmbeddedAttempt();

    await runEmbeddedAgent({
      sessionId: "runtime-config-default-model",
      sessionFile,
      workspaceDir,
      prompt: "hello",
      provider: " ",
      model: "",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("runtime-config-default-model"),
      enqueue: immediateEnqueue,
    });

    expect(resolveModelAsyncMock).toHaveBeenNthCalledWith(
      1,
      "openrouter",
      "openrouter/runtime-default",
      agentDir,
      cfg,
      expect.objectContaining({ skipAgentDiscovery: true }),
    );
  });

  it("uses the session-key agent default when agentId is inferred", async () => {
    const sessionFile = nextSessionCompatibilityKey();
    const cfg = {
      ...addAnthropicProvider(createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]), [
        "claude-opus-4-7",
      ]),
      agents: {
        defaults: {
          model: { primary: "openai/mock-1" },
        },
        list: [
          {
            id: "research",
            model: { primary: "anthropic/claude-opus-4-7" },
          },
        ],
      },
    };
    mockSuccessfulEmbeddedAttempt();

    await runEmbeddedAgent({
      sessionId: "session-key-agent-default",
      sessionKey: "agent:research:embedded:session-key-agent-default",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("session-key-agent-default"),
      enqueue: immediateEnqueue,
    });

    expect(resolveModelAsyncMock).toHaveBeenNthCalledWith(
      1,
      "anthropic",
      "claude-opus-4-7",
      agentDir,
      cfg,
      expect.objectContaining({ skipAgentDiscovery: true }),
    );
    expect(
      (firstRunEmbeddedAttemptParams() as { model?: { provider?: string; id?: string } }).model,
    ).toEqual(expect.objectContaining({ provider: "anthropic", id: "claude-opus-4-7" }));
  });

  it("resolves model-only provider refs instead of prefixing the default provider", async () => {
    const sessionFile = nextSessionCompatibilityKey();
    const cfg = addAnthropicProvider(createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]), [
      "claude-sonnet-4-6",
    ]);
    mockSuccessfulEmbeddedAttempt();

    await runEmbeddedAgent({
      sessionId: "model-only-provider-ref",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      model: "anthropic/claude-sonnet-4-6",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("model-only-provider-ref"),
      enqueue: immediateEnqueue,
    });

    expect(resolveModelAsyncMock).toHaveBeenNthCalledWith(
      1,
      "anthropic",
      "claude-sonnet-4-6",
      agentDir,
      cfg,
      expect.objectContaining({ skipAgentDiscovery: true }),
    );
    expect(
      (firstRunEmbeddedAttemptParams() as { model?: { provider?: string; id?: string } }).model,
    ).toEqual(expect.objectContaining({ provider: "anthropic", id: "claude-sonnet-4-6" }));
  });

  it("publishes the standalone model snapshot before dynamic model resolution", async () => {
    const sessionFile = nextSessionCompatibilityKey();
    const cfg = createEmbeddedAgentRunnerOpenAiConfig([]);
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "ok" }],
        }),
      }),
    );

    await runEmbeddedAgent({
      sessionId: "dynamic-model",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openrouter",
      model: "openrouter/auto",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("dynamic-model"),
      enqueue: immediateEnqueue,
    });

    const resolveModelCall = firstMockCall(resolveModelAsyncMock, "model resolution");
    expect(resolveModelCall?.[0]).toBe("openrouter");
    expect(resolveModelCall?.[1]).toBe("openrouter/auto");
    expect(resolveModelCall?.[2]).toBe(agentDir);
    expect(resolveModelCall?.[3]).toBe(cfg);
    expect(
      (resolveModelCall?.[4] as { skipAgentDiscovery?: boolean } | undefined)?.skipAgentDiscovery,
    ).toBe(true);
    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledTimes(1);
  });

  it("resolves explicit OpenAI OpenClaw runs through Codex when auth order starts with Codex OAuth", async () => {
    const sessionFile = nextSessionCompatibilityKey();
    const baseConfig = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
    const openAIProvider = baseConfig.models?.providers?.openai;
    if (!openAIProvider) {
      throw new Error("expected OpenAI provider test config");
    }
    const cfg = {
      ...baseConfig,
      models: {
        providers: {
          openai: {
            ...openAIProvider,
            baseUrl: "https://api.openai.com/v1",
          },
        },
      },
      agents: {
        ...baseConfig.agents,
        defaults: {
          models: {
            "openai/mock-1": {
              agentRuntime: { id: "openclaw" },
            },
          },
        },
      },
      auth: {
        order: {
          openai: ["openai:work", "openai:backup"],
        },
      },
    };
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "ok" }],
        }),
      }),
    );

    await runEmbeddedAgent({
      sessionId: "codex-first-openclaw",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("codex-first-openclaw"),
      enqueue: immediateEnqueue,
    });

    expect(resolveModelAsyncMock).toHaveBeenNthCalledWith(
      1,
      "openai",
      "mock-1",
      agentDir,
      cfg,
      expect.objectContaining({ skipAgentDiscovery: true }),
    );
    expect(resolveModelAsyncMock).toHaveBeenCalledTimes(1);
    expect(
      (firstRunEmbeddedAttemptParams() as { model?: { provider?: string } }).model?.provider,
    ).toBe("openai");
  });

  it("resolves transport-owned OpenAI Codex runs against the runtime provider first", async () => {
    const sessionFile = nextSessionCompatibilityKey();
    const baseConfig = createEmbeddedAgentRunnerOpenAiConfig([]);
    const openAIProvider = baseConfig.models?.providers?.openai;
    if (!openAIProvider) {
      throw new Error("expected OpenAI provider test config");
    }
    const cfg = {
      ...baseConfig,
      models: {
        providers: {
          openai: {
            ...openAIProvider,
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
      agents: {
        ...baseConfig.agents,
        defaults: {
          models: {
            "openai/gpt-5.5": {
              agentRuntime: { id: "codex" },
            },
          },
        },
      },
    };
    resolveModelAsyncMock.mockImplementation(async (provider: string, modelId: string) => {
      if (provider === "openai" && modelId === "gpt-5.5") {
        const resolved = createResolvedEmbeddedRunnerModel(provider, modelId);
        return { ...resolved, model: { ...resolved.model, contextWindow: 272_000 } };
      }
      return {
        error: `Unknown model: ${provider}/${modelId}`,
        authStorage: {
          setRuntimeApiKey: () => undefined,
        },
        modelRegistry: {},
      };
    });
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "ok" }],
        }),
        contextTokens: 1_050_000,
      }),
    );

    const result = await runEmbeddedAgent({
      sessionId: "codex-runtime-model",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "gpt-5.5",
      timeoutMs: 5_000,
      agentDir,
      agentHarnessId: "codex",
      runId: nextRunId("codex-runtime-model"),
      enqueue: immediateEnqueue,
    });

    expect(resolveModelAsyncMock).toHaveBeenNthCalledWith(
      1,
      "openai",
      "gpt-5.5",
      agentDir,
      cfg,
      expect.objectContaining({ skipAgentDiscovery: true }),
    );
    expect(resolveModelAsyncMock).toHaveBeenCalledTimes(1);
    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledTimes(1);
    expect(
      (firstRunEmbeddedAttemptParams() as { model?: { provider?: string } }).model?.provider,
    ).toBe("openai");
    expect(result.meta.agentMeta?.contextTokens).toBe(1_050_000);
  });

  it("resolves a transport-owned Codex model from the bundled static catalog in one resolver pass", async () => {
    const sessionFile = nextSessionCompatibilityKey();
    const baseConfig = createEmbeddedAgentRunnerOpenAiConfig([]);
    const openAIProvider = baseConfig.models?.providers?.openai;
    if (!openAIProvider) {
      throw new Error("expected OpenAI provider test config");
    }
    const cfg = {
      ...baseConfig,
      models: {
        providers: {
          openai: {
            ...openAIProvider,
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
      agents: {
        ...baseConfig.agents,
        defaults: {
          models: {
            "openai/gpt-5.3-codex": {
              agentRuntime: { id: "codex" },
            },
          },
        },
      },
    };
    resolveModelAsyncMock.mockResolvedValueOnce(
      createResolvedEmbeddedRunnerModel("openai", "gpt-5.3-codex"),
    );
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "ok" }],
        }),
      }),
    );

    await runEmbeddedAgent({
      sessionId: "codex-static-catalog",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "gpt-5.3-codex",
      timeoutMs: 5_000,
      agentDir,
      agentHarnessId: "codex",
      runId: nextRunId("codex-static-catalog"),
      enqueue: immediateEnqueue,
    });

    expect(resolveModelAsyncMock).toHaveBeenCalledTimes(1);
    expect(resolveModelAsyncMock).toHaveBeenNthCalledWith(
      1,
      "openai",
      "gpt-5.3-codex",
      agentDir,
      cfg,
      expect.objectContaining({
        skipAgentDiscovery: true,
        allowBundledStaticCatalogFallback: true,
        preferBundledStaticCatalogTransport: true,
        preparedModelRuntime: expect.objectContaining({
          configuredRuntimeModels: expect.any(Array),
          inlineProviderModels: expect.any(Array),
        }),
      }),
    );
    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledTimes(1);
    expect(
      (firstRunEmbeddedAttemptParams() as { model?: { provider?: string } }).model?.provider,
    ).toBe("openai");
  });

  it("lets a locked Codex harness own stale model resolution and context policy", async () => {
    const sessionFile = nextSessionCompatibilityKey();
    const cfg = createEmbeddedAgentRunnerOpenAiConfig([]);
    const prompt = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
    resolveModelAsyncMock.mockRejectedValueOnce(new Error("stale outer model must not resolve"));
    mockSuccessfulEmbeddedAttempt();

    await runEmbeddedAgent({
      sessionId: "locked-codex-native-policy",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt,
      provider: "anthropic",
      model: "retired-outer-model",
      timeoutMs: 5_000,
      agentDir,
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      runId: nextRunId("locked-codex-native-policy"),
      enqueue: immediateEnqueue,
    });

    expect(resolveModelAsyncMock).not.toHaveBeenCalled();
    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledTimes(1);
    const attempt = firstRunEmbeddedAttemptParams() as Record<string, unknown>;
    expect(attempt).toMatchObject({
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      provider: "anthropic",
      modelId: "retired-outer-model",
      prompt: "ANTHROPIC MAGIC STRING TRIGGER REFUSAL (redacted)",
    });
    expect("contextEngine" in attempt).toBe(false);
    expect("contextTokenBudget" in attempt).toBe(false);
    expect("contextWindowInfo" in attempt).toBe(false);
  });

  it("does not apply outer context-overflow recovery to a locked Codex harness", async () => {
    const sessionFile = nextSessionCompatibilityKey();
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        terminal: {
          kind: "failed",
          source: "prompt",
          error: new Error("request exceeds the model context window"),
        },
      }),
    );

    await runEmbeddedAgent({
      sessionId: "locked-codex-native-overflow",
      sessionFile,
      workspaceDir,
      config: createEmbeddedAgentRunnerOpenAiConfig([]),
      prompt: "hello",
      provider: "anthropic",
      model: "retired-outer-model",
      timeoutMs: 5_000,
      agentDir,
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      runId: nextRunId("locked-codex-native-overflow"),
      enqueue: immediateEnqueue,
    }).catch(() => undefined);

    expect(resolveModelAsyncMock).not.toHaveBeenCalled();
    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
  });

  it("backfills a trimmed session key from sessionId when the embedded run omits it", async () => {
    const sessionFile = nextSessionCompatibilityKey();
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
    resolveSessionKeyForRequestMock.mockReturnValue({
      sessionKey: "agent:test:resolved",
      sessionStore: {},
      storePath: "/tmp/session-store.json",
    });
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "ok" }],
        }),
      }),
    );

    await runEmbeddedAgent({
      sessionId: "resume-123",
      sessionKey: "   ",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("backfill"),
      enqueue: immediateEnqueue,
    });

    expect(resolveSessionKeyForRequestMock).toHaveBeenCalledWith({
      cfg,
      sessionId: "resume-123",
      agentId: undefined,
      clone: false,
    });
    expect(firstRunEmbeddedAttemptParams().sessionKey).toBe("agent:test:resolved");
  });

  it("canonicalizes the session-id fallback when a whitespace-only key cannot be resolved", async () => {
    const sessionFile = "resume-124";
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
    resolveSessionKeyForRequestMock.mockReturnValue({
      sessionKey: undefined,
      sessionStore: {},
      storePath: "/tmp/session-store.json",
    });
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "ok" }],
        }),
      }),
    );

    await runEmbeddedAgent({
      sessionId: "resume-124",
      sessionKey: "   ",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("backfill-empty"),
      enqueue: immediateEnqueue,
    });

    expect(resolveSessionKeyForRequestMock).toHaveBeenCalledWith({
      cfg,
      sessionId: "resume-124",
      agentId: undefined,
      clone: false,
    });
    expect(firstRunEmbeddedAttemptParams().sessionKey).toBe("agent:main:resume-124");
  });

  it("logs when embedded session-key backfill resolution fails", async () => {
    const sessionFile = nextSessionCompatibilityKey();
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
    resolveSessionKeyForRequestMock.mockImplementation(() => {
      throw new Error("resolver exploded");
    });
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "ok" }],
        }),
      }),
    );

    await runEmbeddedAgent({
      sessionId: "resume-456",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("backfill-warn"),
      enqueue: immediateEnqueue,
    });

    expect(
      loggerWarnMock.mock.calls.some(([message]) =>
        String(message ?? "").includes("[backfillSessionKey] Failed to resolve sessionKey"),
      ),
    ).toBe(true);
  });

  it("passes the current agentId when backfilling a session key", async () => {
    const sessionFile = nextSessionCompatibilityKey();
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
    resolveStoredSessionKeyForSessionIdMock.mockReturnValue({
      sessionKey: "agent:embedded-agent:resolved",
      sessionStore: {},
      storePath: "/tmp/session-store.json",
    });
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "ok" }],
        }),
      }),
    );

    await runEmbeddedAgent({
      sessionId: "resume-agent-1",
      sessionKey: undefined,
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      agentId: "embedded-agent",
      runId: nextRunId("backfill-agent-scope"),
      enqueue: immediateEnqueue,
    });

    expect(resolveStoredSessionKeyForSessionIdMock).toHaveBeenCalledWith({
      cfg,
      sessionId: "resume-agent-1",
      agentId: "embedded-agent",
    });
    expect(resolveSessionKeyForRequestMock).not.toHaveBeenCalled();
  });

  it("disposes bundle MCP once when a one-shot local run completes", async () => {
    const sessionFile = nextSessionCompatibilityKey();
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
    const sessionKey = nextSessionKey();
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "ok" }],
        }),
      }),
    );

    await runEmbeddedAgent({
      sessionId: "session:test",
      sessionKey,
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("bundle-mcp-run-cleanup"),
      enqueue: immediateEnqueue,
      cleanupBundleMcpOnRunEnd: true,
    });

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
    expect(disposeSessionMcpRuntimeMock).toHaveBeenCalledTimes(1);
    expect(disposeSessionMcpRuntimeMock).toHaveBeenCalledWith("session:test");
  });

  it("preserves bundle MCP state across retries within one local run", async () => {
    refreshRuntimeAuthOnFirstPromptError = true;
    const sessionFile = nextSessionCompatibilityKey();
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
    const sessionKey = nextSessionKey();
    runEmbeddedAttemptMock
      .mockImplementationOnce(async () => {
        expect(disposeSessionMcpRuntimeMock).not.toHaveBeenCalled();
        return makeEmbeddedRunnerAttempt({
          terminal: { kind: "failed", source: "prompt", error: new Error("401 unauthorized") },
        });
      })
      .mockImplementationOnce(async () => {
        expect(disposeSessionMcpRuntimeMock).not.toHaveBeenCalled();
        return makeEmbeddedRunnerAttempt({
          assistantTexts: ["ok"],
          lastAssistant: buildEmbeddedRunnerAssistant({
            content: [{ type: "text", text: "ok" }],
          }),
        });
      });

    const result = await runEmbeddedAgent({
      sessionId: "session:test",
      sessionKey,
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("bundle-mcp-retry"),
      enqueue: immediateEnqueue,
      cleanupBundleMcpOnRunEnd: true,
    });

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.text).toBe("ok");
    expect(disposeSessionMcpRuntimeMock).toHaveBeenCalledTimes(1);
    expect(disposeSessionMcpRuntimeMock).toHaveBeenCalledWith("session:test");
  });

  it("returns visible assistant prose without semantic retry classification", async () => {
    const sessionFile = nextSessionCompatibilityKey();
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["gpt-5.4"]);
    const sessionKey = nextSessionKey();

    runEmbeddedAttemptMock.mockImplementationOnce(async (params: unknown) => {
      expect((params as { prompt?: string }).prompt).toMatch(/^ship it(?:\n\n|$)/);
      return makeEmbeddedRunnerAttempt({
        assistantTexts: ["I'll inspect the files, make the change, and run the checks."],
        lastAssistant: buildEmbeddedRunnerAssistant({
          model: "gpt-5.4",
          content: [
            {
              type: "text",
              text: "I'll inspect the files, make the change, and run the checks.",
            },
          ],
        }),
      });
    });

    const result = await runEmbeddedAgent({
      sessionId: "session:test",
      sessionKey,
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "ship it",
      provider: "openai",
      model: "gpt-5.4",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("visible-prose"),
      enqueue: immediateEnqueue,
    });

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.text).toBe(
      "I'll inspect the files, make the change, and run the checks.",
    );
  });

  it("preserves harness-owned media provenance through terminal preparation", async () => {
    const sessionFile = nextSessionCompatibilityKey();
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        toolMediaUrls: ["/tmp/generated.png"],
        hostOwnedToolMediaUrls: ["/tmp/generated.png"],
      }),
    );

    const result = await runEmbeddedAgent({
      sessionId: "session:test",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "generate an image",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("host-owned-media"),
      sourceReplyDeliveryMode: "message_tool_only",
      enqueue: immediateEnqueue,
    });

    expect(result.payloads).toHaveLength(1);
    expect(result.payloads?.[0]).toMatchObject({
      mediaUrls: ["/tmp/generated.png"],
      mediaUrl: "/tmp/generated.png",
    });
    expect(getReplyPayloadMetadata(result.payloads?.[0] ?? {})).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
    });
  });

  it("surfaces prompt errors from the embedded attempt", async () => {
    const sessionFile = nextSessionCompatibilityKey();
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-error"]);
    const sessionKey = nextSessionKey();
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        terminal: { kind: "failed", source: "prompt", error: new Error("boom") },
      }),
    );
    await expect(
      runEmbeddedAgent({
        sessionId: "session:test",
        sessionKey,
        sessionFile,
        workspaceDir,
        config: cfg,
        prompt: "boom",
        provider: "openai",
        model: "mock-error",
        timeoutMs: 5_000,
        agentDir,
        runId: nextRunId("prompt-error"),
        enqueue: immediateEnqueue,
      }),
    ).rejects.toThrow("boom");
  });

  it(
    "preserves existing transcript entries across an additional turn",
    { timeout: 15_000 },
    async () => {
      const sessionFile = nextSessionCompatibilityKey();
      const sessionKey = nextSessionKey();
      const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-error"]);

      const sessionManager = await createPersistedTestSessionManager({
        config: cfg,
        sessionId: "session:test",
        sessionKey,
      });
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "seed user" }],
        timestamp: Date.now(),
      });
      sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "seed assistant" }],
        stopReason: "stop",
        api: "openai-responses",
        provider: "openai",
        model: "mock-1",
        usage: createMockUsage(1, 1),
        timestamp: Date.now(),
      });

      await runDefaultEmbeddedTurn(sessionFile, "hello", sessionKey);

      const messages = await readSessionMessages({
        config: cfg,
        sessionId: "session:test",
        sessionKey,
      });
      const seedUserIndex = messages.findIndex(
        (message) => message?.role === "user" && textFromContent(message.content) === "seed user",
      );
      const seedAssistantIndex = messages.findIndex(
        (message) =>
          message?.role === "assistant" && textFromContent(message.content) === "seed assistant",
      );
      expect(seedUserIndex).toBeGreaterThanOrEqual(0);
      expect(seedAssistantIndex).toBeGreaterThan(seedUserIndex);
      expect(messages.length).toBeGreaterThanOrEqual(2);
    },
  );

  it("repairs orphaned user messages and continues", async () => {
    const result = await runWithOrphanedSingleUserMessage("orphaned user", nextSessionKey());

    expect(result.meta.error).toBeUndefined();
    expect(result.payloads?.[0]?.text).toBe("ok");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
