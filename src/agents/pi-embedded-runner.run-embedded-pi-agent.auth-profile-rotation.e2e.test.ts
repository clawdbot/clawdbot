import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { redactIdentifier } from "../logging/redact-identifier.js";
import type { AuthProfileFailureReason } from "./auth-profiles.js";
import { buildAttemptReplayMetadata } from "./pi-embedded-runner/run/incomplete-turn.js";
import type { EmbeddedRunAttemptResult } from "./pi-embedded-runner/run/types.js";
import {
  installEmbeddedRunnerBackoffE2eMocks,
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "./test-helpers/pi-embedded-runner-e2e-mocks.js";

const runEmbeddedAttemptMock = vi.fn<(params: unknown) => Promise<EmbeddedRunAttemptResult>>();
const resolveCopilotApiTokenMock = vi.fn();
const { computeBackoffMock, sleepWithAbortMock } = vi.hoisted(() => ({
  computeBackoffMock: vi.fn(
    (
      _policy: { initialMs: number; maxMs: number; factor: number; jitter: number },
      _attempt: number,
    ) => 321,
  ),
  sleepWithAbortMock: vi.fn(async (_ms: number, _abortSignal?: AbortSignal) => undefined),
}));

const installRunEmbeddedMocks = () => {
  installEmbeddedRunnerBaseE2eMocks();
  installEmbeddedRunnerFastRunE2eMocks({
    runEmbeddedAttempt: (params) => runEmbeddedAttemptMock(params),
    prepareProviderRuntimeAuth: async (params) => {
      if (params.provider !== "github-copilot") {
        return undefined;
      }
      const token = await resolveCopilotApiTokenMock(params.context.apiKey);
      return {
        apiKey: token.token,
        baseUrl: token.baseUrl,
        expiresAt: token.expiresAt,
      };
    },
  });
  vi.doMock("./pi-embedded-runner/model.js", () => ({
    resolveModelAsync: async (provider: string, modelId: string) => ({
      model: {
        id: modelId,
        name: modelId,
        api: "openai-responses",
        provider,
        baseUrl:
          provider === "github-copilot" ? "https://api.copilot.example" : "https://example.com",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16_000,
        maxTokens: 2048,
      },
      error: undefined,
      authStorage: {
        setRuntimeApiKey: vi.fn(),
      },
      modelRegistry: {},
    }),
  }));
  installEmbeddedRunnerBackoffE2eMocks({
    computeBackoff: (policy, attempt) => computeBackoffMock(policy, attempt),
    sleepWithAbort: (ms, abortSignal) => sleepWithAbortMock(ms, abortSignal),
  });
  vi.doMock("./pi-embedded-runner/compact.js", () => ({
    compactEmbeddedPiSessionDirect: vi.fn(async () => {
      throw new Error("compact should not run in auth profile rotation tests");
    }),
  }));
  vi.doMock("./models-config.js", async () => {
    const mod = await vi.importActual<typeof import("./models-config.js")>("./models-config.js");
    return {
      ...mod,
      ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
    };
  });
};

let runEmbeddedPiAgent: typeof import("./pi-embedded-runner/run.js").runEmbeddedPiAgent;
let createDiagnosticLogRecordCaptureFn: typeof import("../logging/test-helpers/diagnostic-log-capture.js").createDiagnosticLogRecordCapture;
let cleanupLogCapture: (() => void) | undefined;
let resetLoggerFn: typeof import("../logging/logger.js").resetLogger;
let setLoggerOverrideFn: typeof import("../logging/logger.js").setLoggerOverride;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  vi.resetModules();
  installRunEmbeddedMocks();
  ({ runEmbeddedPiAgent } = await import("./pi-embedded-runner/run.js"));
  ({ createDiagnosticLogRecordCapture: createDiagnosticLogRecordCaptureFn } =
    await import("../logging/test-helpers/diagnostic-log-capture.js"));
  ({ resetLogger: resetLoggerFn, setLoggerOverride: setLoggerOverrideFn } =
    await import("../logging/logger.js"));
});

async function runEmbeddedPiAgentInline(
  params: Parameters<typeof runEmbeddedPiAgent>[0],
): Promise<Awaited<ReturnType<typeof runEmbeddedPiAgent>>> {
  return await runEmbeddedPiAgent({
    ...params,
    enqueue: async (task) => await task(),
  });
}

beforeEach(() => {
  vi.useRealTimers();
  runEmbeddedAttemptMock.mockReset();
  runEmbeddedAttemptMock.mockImplementation(async () => {
    throw new Error("unexpected extra runEmbeddedAttempt call");
  });
  resolveCopilotApiTokenMock.mockReset();
  resolveCopilotApiTokenMock.mockImplementation(async () => {
    throw new Error("unexpected extra Copilot token refresh");
  });
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as unknown as typeof fetch;
  computeBackoffMock.mockClear();
  sleepWithAbortMock.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanupLogCapture?.();
  cleanupLogCapture = undefined;
  setLoggerOverrideFn(null);
  resetLoggerFn();
});

const baseUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const buildAssistant = (overrides: Partial<AssistantMessage>): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "openai-responses",
  provider: "openai",
  model: "mock-1",
  usage: baseUsage,
  stopReason: "stop",
  timestamp: Date.now(),
  ...overrides,
});

const makeAttempt = (overrides: Partial<EmbeddedRunAttemptResult>): EmbeddedRunAttemptResult => {
  const toolMetas = overrides.toolMetas ?? [];
  const didSendViaMessagingTool = overrides.didSendViaMessagingTool ?? false;
  const messagingToolSentTexts = overrides.messagingToolSentTexts ?? [];
  const messagingToolSentMediaUrls = overrides.messagingToolSentMediaUrls ?? [];
  const successfulCronAdds = overrides.successfulCronAdds;
  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    promptError: null,
    promptErrorSource: null,
    sessionIdUsed: "session:test",
    systemPromptReport: undefined,
    messagesSnapshot: [],
    assistantTexts: [],
    toolMetas,
    lastAssistant: undefined,
    replayMetadata:
      overrides.replayMetadata ??
      buildAttemptReplayMetadata({
        toolMetas,
        didSendViaMessagingTool,
        messagingToolSentTexts,
        messagingToolSentMediaUrls,
        successfulCronAdds,
      }),
    didSendViaMessagingTool,
    messagingToolSentTexts,
    messagingToolSentMediaUrls,
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    ...overrides,
  };
};

const makeConfig = (opts?: {
  fallbacks?: string[];
  apiKey?: string;
  overloadedBackoffMs?: number;
  overloadedProfileRotations?: number;
}): OpenClawConfig =>
  ({
    auth:
      opts?.overloadedBackoffMs != null || opts?.overloadedProfileRotations != null
        ? {
            cooldowns: {
              ...(opts?.overloadedBackoffMs != null
                ? { overloadedBackoffMs: opts.overloadedBackoffMs }
                : {}),
              ...(opts?.overloadedProfileRotations != null
                ? { overloadedProfileRotations: opts.overloadedProfileRotations }
                : {}),
            },
          }
        : undefined,
    agents: {
      defaults: {
        model: {
          fallbacks: opts?.fallbacks ?? [],
        },
      },
    },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          apiKey: opts?.apiKey ?? "sk-test",
          baseUrl: "https://example.com",
          models: [
            {
              id: "mock-1",
              name: "Mock 1",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16_000,
              maxTokens: 2048,
            },
          ],
        },
      },
    },
  }) satisfies OpenClawConfig;

const makeAgentOverrideOnlyFallbackConfig = (agentId: string): OpenClawConfig =>
  ({
    agents: {
      defaults: {
        model: {
          fallbacks: [],
        },
      },
      list: [
        {
          id: agentId,
          model: {
            fallbacks: ["openai/mock-2"],
          },
        },
      ],
    },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          apiKey: "sk-test", // pragma: allowlist secret
          baseUrl: "https://example.com",
          models: [
            {
              id: "mock-1",
              name: "Mock 1",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16_000,
              maxTokens: 2048,
            },
          ],
        },
      },
    },
  }) satisfies OpenClawConfig;

const copilotModelId = "gpt-4o";

const makeCopilotConfig = (): OpenClawConfig =>
  ({
    models: {
      providers: {
        "github-copilot": {
          api: "openai-responses",
          baseUrl: "https://api.copilot.example",
          models: [
            {
              id: copilotModelId,
              name: "Copilot GPT-4o",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16_000,
              maxTokens: 2048,
            },
          ],
        },
      },
    },
  }) satisfies OpenClawConfig;

const writeAuthStore = async (
  agentDir: string,
  opts?: {
    includeAnthropic?: boolean;
    order?: Record<string, string[]>;
    usageStats?: Record<
      string,
      {
        lastUsed?: number;
        cooldownUntil?: number;
        disabledUntil?: number;
        disabledReason?: AuthProfileFailureReason;
        failureCounts?: Partial<Record<AuthProfileFailureReason, number>>;
      }
    >;
  },
) => {
  const authPath = path.join(agentDir, "auth-profiles.json");
  const statePath = path.join(agentDir, "auth-state.json");
  const authPayload = {
    version: 1,
    profiles: {
      "openai:p1": { type: "api_key", provider: "openai", key: "sk-one" },
      "openai:p2": { type: "api_key", provider: "openai", key: "sk-two" },
      ...(opts?.includeAnthropic
        ? { "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-anth" } }
        : {}),
    },
  };
  const statePayload = {
    version: 1,
    ...(opts?.order ? { order: opts.order } : {}),
    usageStats:
      opts?.usageStats ??
      ({
        "openai:p1": { lastUsed: 1 },
        "openai:p2": { lastUsed: 2 },
      } as Record<string, { lastUsed?: number }>),
  };
  await fs.writeFile(authPath, JSON.stringify(authPayload));
  await fs.writeFile(statePath, JSON.stringify(statePayload));
};

const writeCopilotAuthStore = async (agentDir: string, token = "gh-token") => {
  const authPath = path.join(agentDir, "auth-profiles.json");
  const payload = {
    version: 1,
    profiles: {
      "github-copilot:github": { type: "token", provider: "github-copilot", token },
    },
  };
  await fs.writeFile(authPath, JSON.stringify(payload));
};

const writeOpenAiCodexAuthStore = async (agentDir: string) => {
  const authPath = path.join(agentDir, "auth-profiles.json");
  const payload = {
    version: 1,
    profiles: {
      "openai-codex:work": {
        type: "api_key",
        provider: "openai-codex",
        key: "sk-codex",
      },
    },
  };
  await fs.writeFile(authPath, JSON.stringify(payload));
};

const buildCopilotAssistant = (overrides: Partial<AssistantMessage> = {}) =>
  buildAssistant({ provider: "github-copilot", model: copilotModelId, ...overrides });

const mockFailedThenSuccessfulAttempt = (errorMessage = "rate limit") => {
  runEmbeddedAttemptMock
    .mockResolvedValueOnce(
      makeAttempt({
        assistantTexts: [],
        lastAssistant: buildAssistant({
          stopReason: "error",
          errorMessage,
        }),
      }),
    )
    .mockResolvedValueOnce(
      makeAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildAssistant({
          stopReason: "stop",
          content: [{ type: "text", text: "ok" }],
        }),
      }),
    );
};

const mockPromptErrorThenSuccessfulAttempt = (errorMessage: string) => {
  runEmbeddedAttemptMock
    .mockResolvedValueOnce(
      makeAttempt({
        promptError: new Error(errorMessage),
      }),
    )
    .mockResolvedValueOnce(
      makeAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildAssistant({
          stopReason: "stop",
          content: [{ type: "text", text: "ok" }],
        }),
      }),
    );
};

async function runAutoPinnedOpenAiTurn(params: {
  agentDir: string;
  workspaceDir: string;
  sessionKey: string;
  runId: string;
  authProfileId?: string;
  config?: OpenClawConfig;
}) {
  await runEmbeddedPiAgentInline({
    sessionId: "session:test",
    sessionKey: params.sessionKey,
    sessionFile: path.join(params.workspaceDir, "session.jsonl"),
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    config: params.config ?? makeConfig(),
    prompt: "hello",
    provider: "openai",
    model: "mock-1",
    authProfileId: params.authProfileId ?? "openai:p1",
    authProfileIdSource: "auto",
    timeoutMs: 5_000,
    runId: params.runId,
  });
}

async function readUsageStats(agentDir: string) {
  const stored = JSON.parse(await fs.readFile(path.join(agentDir, "auth-state.json"), "utf-8")) as {
    usageStats?: Record<
      string,
      {
        lastUsed?: number;
        cooldownUntil?: number;
        disabledUntil?: number;
        disabledReason?: AuthProfileFailureReason;
      }
    >;
  };
  return stored.usageStats ?? {};
}

async function expectProfileP2UsageUnchanged(agentDir: string) {
  const usageStats = await readUsageStats(agentDir);
  expect(usageStats["openai:p2"]?.lastUsed).toBe(2);
}

async function runAutoPinnedRotationCase(params: {
  errorMessage: string;
  sessionKey: string;
  runId: string;
  config?: OpenClawConfig;
}) {
  runEmbeddedAttemptMock.mockReset();
  return withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
    await writeAuthStore(agentDir);
    mockFailedThenSuccessfulAttempt(params.errorMessage);
    await runAutoPinnedOpenAiTurn({
      agentDir,
      workspaceDir,
      sessionKey: params.sessionKey,
      runId: params.runId,
      config: params.config,
    });

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
    const usageStats = await readUsageStats(agentDir);
    return { usageStats };
  });
}

async function runAutoPinnedPromptErrorRotationCase(params: {
  errorMessage: string;
  sessionKey: string;
  runId: string;
  config?: OpenClawConfig;
}) {
  runEmbeddedAttemptMock.mockReset();
  return withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
    await writeAuthStore(agentDir);
    mockPromptErrorThenSuccessfulAttempt(params.errorMessage);
    await runAutoPinnedOpenAiTurn({
      agentDir,
      workspaceDir,
      sessionKey: params.sessionKey,
      runId: params.runId,
      config: params.config,
    });

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
    const usageStats = await readUsageStats(agentDir);
    return { usageStats };
  });
}

function mockSingleSuccessfulAttempt() {
  runEmbeddedAttemptMock.mockResolvedValueOnce(
    makeAttempt({
      assistantTexts: ["ok"],
      lastAssistant: buildAssistant({
        stopReason: "stop",
        content: [{ type: "text", text: "ok" }],
      }),
    }),
  );
}

function mockSingleErrorAttempt(params: {
  errorMessage: string;
  provider?: string;
  model?: string;
}) {
  runEmbeddedAttemptMock.mockResolvedValueOnce(
    makeAttempt({
      assistantTexts: [],
      lastAssistant: buildAssistant({
        stopReason: "error",
        errorMessage: params.errorMessage,
        ...(params.provider ? { provider: params.provider } : {}),
        ...(params.model ? { model: params.model } : {}),
      }),
    }),
  );
}

async function withTimedAgentWorkspace<T>(
  run: (ctx: { agentDir: string; workspaceDir: string; now: number }) => Promise<T>,
) {
  vi.useFakeTimers();
  try {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    const now = Date.now();
    vi.setSystemTime(now);

    try {
      return await run({ agentDir, workspaceDir, now });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  } finally {
    vi.useRealTimers();
  }
}

async function withAgentWorkspace<T>(
  run: (ctx: { agentDir: string; workspaceDir: string }) => Promise<T>,
) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
  try {
    return await run({ agentDir, workspaceDir });
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
}

async function runTurnWithCooldownSeed(params: {
  sessionKey: string;
  runId: string;
  authProfileId: string | undefined;
  authProfileIdSource: "auto" | "user";
}) {
  return await withTimedAgentWorkspace(async ({ agentDir, workspaceDir, now }) => {
    await writeAuthStore(agentDir, {
      usageStats: {
        "openai:p1": { lastUsed: 1, cooldownUntil: now + 60 * 60 * 1000 },
        "openai:p2": { lastUsed: 2 },
      },
    });
    mockSingleSuccessfulAttempt();

    await runEmbeddedPiAgentInline({
      sessionId: "session:test",
      sessionKey: params.sessionKey,
      sessionFile: path.join(workspaceDir, "session.jsonl"),
      workspaceDir,
      agentDir,
      config: makeConfig(),
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      authProfileId: params.authProfileId,
      authProfileIdSource: params.authProfileIdSource,
      timeoutMs: 5_000,
      runId: params.runId,
    });

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
    return { usageStats: await readUsageStats(agentDir), now };
  });
}

describe("runEmbeddedPiAgent auth profile rotation", () => {
  it("refreshes copilot token after auth error and retries once", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    try {
      await writeCopilotAuthStore(agentDir);
      const now = Date.now();

      resolveCopilotApiTokenMock
        .mockResolvedValueOnce({
          token: "copilot-initial",
          // Keep expiry beyond the runtime refresh margin so the test only
          // exercises auth-error refresh, not the background scheduler.
          expiresAt: now + 10 * 60 * 1000,
          source: "mock",
          baseUrl: "https://api.copilot.example",
        })
        .mockResolvedValueOnce({
          token: "copilot-refresh",
          expiresAt: now + 60 * 60 * 1000,
          source: "mock",
          baseUrl: "https://api.copilot.example",
        });

      runEmbeddedAttemptMock
        .mockResolvedValueOnce(
          makeAttempt({
            assistantTexts: [],
            lastAssistant: buildCopilotAssistant({
              stopReason: "error",
              errorMessage: "unauthorized",
            }),
          }),
        )
        .mockResolvedValueOnce(
          makeAttempt({
            assistantTexts: ["ok"],
            lastAssistant: buildCopilotAssistant({
              stopReason: "stop",
              content: [{ type: "text", text: "ok" }],
            }),
          }),
        );

      await runEmbeddedPiAgentInline({
        sessionId: "session:test",
        sessionKey: "agent:test:copilot-auth-error",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        workspaceDir,
        agentDir,
        config: makeCopilotConfig(),
        prompt: "hello",
        provider: "github-copilot",
        model: copilotModelId,
        authProfileIdSource: "auto",
        timeoutMs: 5_000,
        runId: "run:copilot-auth-error",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
      expect(resolveCopilotApiTokenMock).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("allows another auth refresh after a successful retry", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    try {
      await writeCopilotAuthStore(agentDir);
      const now = Date.now();

      resolveCopilotApiTokenMock
        .mockResolvedValueOnce({
          token: "copilot-initial",
          // Avoid an immediate scheduled refresh racing the explicit auth retry.
          expiresAt: now + 10 * 60 * 1000,
          source: "mock",
          baseUrl: "https://api.copilot.example",
        })
        .mockResolvedValueOnce({
          token: "copilot-refresh-1",
          expiresAt: now + 10 * 60 * 1000,
          source: "mock",
          baseUrl: "https://api.copilot.example",
        })
        .mockResolvedValueOnce({
          token: "copilot-refresh-2",
          expiresAt: now + 40 * 60 * 1000,
          source: "mock",
          baseUrl: "https://api.copilot.example",
        });

      runEmbeddedAttemptMock
        .mockResolvedValueOnce(
          makeAttempt({
            assistantTexts: [],
            lastAssistant: buildCopilotAssistant({
              stopReason: "error",
              errorMessage: "401 unauthorized",
            }),
          }),
        )
        .mockResolvedValueOnce(
          makeAttempt({
            promptError: new Error("supported values are: low, medium"),
          }),
        )
        .mockResolvedValueOnce(
          makeAttempt({
            assistantTexts: [],
            lastAssistant: buildCopilotAssistant({
              stopReason: "error",
              errorMessage: "token has expired",
            }),
          }),
        )
        .mockResolvedValueOnce(
          makeAttempt({
            assistantTexts: ["ok"],
            lastAssistant: buildCopilotAssistant({
              stopReason: "stop",
              content: [{ type: "text", text: "ok" }],
            }),
          }),
        );

      await runEmbeddedPiAgentInline({
        sessionId: "session:test",
        sessionKey: "agent:test:copilot-auth-repeat",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        workspaceDir,
        agentDir,
        config: makeCopilotConfig(),
        prompt: "hello",
        provider: "github-copilot",
        model: copilotModelId,
        authProfileIdSource: "auto",
        timeoutMs: 5_000,
        runId: "run:copilot-auth-repeat",
      });
      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(4);
      expect(resolveCopilotApiTokenMock).toHaveBeenCalledTimes(3);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not reschedule copilot refresh after shutdown", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    vi.useFakeTimers();
    try {
      await writeCopilotAuthStore(agentDir);
      const now = Date.now();
      vi.setSystemTime(now);

      resolveCopilotApiTokenMock.mockResolvedValue({
        token: "copilot-initial",
        expiresAt: now + 60 * 60 * 1000,
        source: "mock",
        baseUrl: "https://api.copilot.example",
      });

      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeAttempt({
          assistantTexts: ["ok"],
          lastAssistant: buildCopilotAssistant({
            stopReason: "stop",
            content: [{ type: "text", text: "ok" }],
          }),
        }),
      );

      const runPromise = runEmbeddedPiAgentInline({
        sessionId: "session:test",
        sessionKey: "agent:test:copilot-shutdown",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        workspaceDir,
        agentDir,
        config: makeCopilotConfig(),
        prompt: "hello",
        provider: "github-copilot",
        model: copilotModelId,
        authProfileIdSource: "auto",
        timeoutMs: 5_000,
        runId: "run:copilot-shutdown",
      });

      await vi.advanceTimersByTimeAsync(1);
      await runPromise;
      const refreshCalls = resolveCopilotApiTokenMock.mock.calls.length;

      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      expect(resolveCopilotApiTokenMock.mock.calls.length).toBe(refreshCalls);
    } finally {
      vi.useRealTimers();
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rotates for auto-pinned profiles across retryable stream failures", async () => {
    const { usageStats } = await runAutoPinnedRotationCase({
      errorMessage: "rate limit",
      sessionKey: "agent:test:auto",
      runId: "run:auto",
    });
    expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
  });

  it("rotates for overloaded assistant failures across auto-pinned profiles", async () => {
    const { usageStats } = await runAutoPinnedRotationCase({
      errorMessage: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      sessionKey: "agent:test:overloaded-rotation",
      runId: "run:overloaded-rotation",
    });
    expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
    expect(typeof usageStats["openai:p1"]?.cooldownUntil).toBe("number");
    expect(computeBackoffMock).not.toHaveBeenCalled();
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
  });

  it("logs structured failover decision metadata for overloaded assistant rotation", async () => {
    const logCapture = createDiagnosticLogRecordCaptureFn();
    cleanupLogCapture = logCapture.cleanup;
    setLoggerOverrideFn({
      level: "trace",
      consoleLevel: "silent",
      file: path.join(os.tmpdir(), `openclaw-auth-rotation-${Date.now()}.log`),
    });

    await runAutoPinnedRotationCase({
      errorMessage:
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_overload"}',
      sessionKey: "agent:test:overloaded-logging",
      runId: "run:overloaded-logging",
    });
    await logCapture.flush();

    const decisionRecord = logCapture.records.find(
      (record) =>
        record.message === "embedded run failover decision" &&
        record.attributes?.decision === "rotate_profile",
    );

    expect(decisionRecord).toBeDefined();
    const safeProfileId = redactIdentifier("openai:p1", { len: 12 });
    expect(decisionRecord?.attributes).toMatchObject({
      event: "embedded_run_failover_decision",
      runId: "run:overloaded-logging",
      decision: "rotate_profile",
      failoverReason: "overloaded",
      profileId: safeProfileId,
      sourceProvider: "openai",
      sourceModel: "mock-1",
      providerErrorType: "overloaded_error",
      rawErrorPreview: expect.stringContaining('"request_id":"sha256:'),
    });

    const stateRecord = logCapture.records.find(
      (record) =>
        record.message === "auth profile failure state updated" &&
        record.attributes?.profileId === safeProfileId,
    );

    expect(stateRecord).toBeDefined();
    expect(stateRecord?.attributes).toMatchObject({
      event: "auth_profile_failure_state_updated",
      runId: "run:overloaded-logging",
      profileId: safeProfileId,
      reason: "overloaded",
    });
  });

  it("rotates for overloaded prompt failures across auto-pinned profiles", async () => {
    const { usageStats } = await runAutoPinnedPromptErrorRotationCase({
      errorMessage: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      sessionKey: "agent:test:overloaded-prompt-rotation",
      runId: "run:overloaded-prompt-rotation",
    });
    expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
    expect(typeof usageStats["openai:p1"]?.cooldownUntil).toBe("number");
    expect(computeBackoffMock).not.toHaveBeenCalled();
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
  });

  it("uses configured overload backoff before rotating profiles", async () => {
    const { usageStats } = await runAutoPinnedRotationCase({
      errorMessage: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      sessionKey: "agent:test:overloaded-configured-backoff",
      runId: "run:overloaded-configured-backoff",
      config: makeConfig({ overloadedBackoffMs: 321 }),
    });
    expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
    expect(computeBackoffMock).not.toHaveBeenCalled();
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).toHaveBeenCalledWith(321, undefined);
  });

  it("rotates on timeout without cooling down the timed-out profile", async () => {
    const { usageStats } = await runAutoPinnedRotationCase({
      errorMessage: "request ended without sending any chunks",
      sessionKey: "agent:test:timeout-no-cooldown",
      runId: "run:timeout-no-cooldown",
    });
    expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
    expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
    expect(computeBackoffMock).not.toHaveBeenCalled();
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
  });

  it("rotates on bare service unavailable without cooling down the profile", async () => {
    const { usageStats } = await runAutoPinnedRotationCase({
      errorMessage: "LLM error: service unavailable",
      sessionKey: "agent:test:service-unavailable-no-cooldown",
      runId: "run:service-unavailable-no-cooldown",
    });
    expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
    expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
  });

  it("does not rotate for compaction timeouts", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir);

      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeAttempt({
          aborted: true,
          timedOut: true,
          timedOutDuringCompaction: true,
          assistantTexts: ["partial"],
          lastAssistant: buildAssistant({
            stopReason: "stop",
            content: [{ type: "text", text: "partial" }],
          }),
        }),
      );

      const result = await runEmbeddedPiAgentInline({
        sessionId: "session:test",
        sessionKey: "agent:test:compaction-timeout",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        workspaceDir,
        agentDir,
        config: makeConfig(),
        prompt: "hello",
        provider: "openai",
        model: "mock-1",
        authProfileId: "openai:p1",
        authProfileIdSource: "auto",
        timeoutMs: 5_000,
        runId: "run:compaction-timeout",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      expect(result.meta.aborted).toBe(true);

      await expectProfileP2UsageUnchanged(agentDir);
    });
  });

  it("does not rotate when failover-looking prompt errors came from compaction wait", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir);

      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeAttempt({
          promptError: new Error("rate limit exceeded"),
          promptErrorSource: "compaction",
          assistantTexts: ["partial"],
          lastAssistant: buildAssistant({
            stopReason: "stop",
            content: [{ type: "text", text: "partial" }],
          }),
        }),
      );

      const result = await runEmbeddedPiAgentInline({
        sessionId: "session:test",
        sessionKey: "agent:test:compaction-wait-abort",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        workspaceDir,
        agentDir,
        config: makeConfig(),
        prompt: "hello",
        provider: "openai",
        model: "mock-1",
        authProfileId: "openai:p1",
        authProfileIdSource: "auto",
        timeoutMs: 5_000,
        runId: "run:compaction-wait-abort",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      expect(result.payloads?.[0]?.text).toContain("partial");
      await expectProfileP2UsageUnchanged(agentDir);
    });
  });

  it("surfaces rate limits without rotating for user-pinned profiles", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir);

      mockSingleErrorAttempt({ errorMessage: "rate limit" });

      await expect(
        runEmbeddedPiAgentInline({
          sessionId: "session:test",
          sessionKey: "agent:test:user",
          sessionFile: path.join(workspaceDir, "session.jsonl"),
          workspaceDir,
          agentDir,
          config: makeConfig(),
          prompt: "hello",
          provider: "openai",
          model: "mock-1",
          authProfileId: "openai:p1",
          authProfileIdSource: "user",
          timeoutMs: 5_000,
          runId: "run:user",
        }),
      ).rejects.toMatchObject({
        name: "FailoverError",
        profileId: "openai:p1",
        reason: "rate_limit",
        provider: "openai",
        model: "mock-1",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      await expectProfileP2UsageUnchanged(agentDir);
    });
  });

  it("honors user-pinned profiles even when in cooldown", async () => {
    const { usageStats } = await runTurnWithCooldownSeed({
      sessionKey: "agent:test:user-cooldown",
      runId: "run:user-cooldown",
      authProfileId: "openai:p1",
      authProfileIdSource: "user",
    });

    expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
    expect(usageStats["openai:p1"]?.lastUsed).not.toBe(1);
    expect(usageStats["openai:p2"]?.lastUsed).toBe(2);
  });

  it("honors user-pinned profiles even when stored order excludes them", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir, {
        order: {
          openai: ["openai:p1"],
        },
      });
      mockSingleSuccessfulAttempt();

      await runEmbeddedPiAgentInline({
        sessionId: "session:test",
        sessionKey: "agent:test:user-order-excluded",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        workspaceDir,
        agentDir,
        config: makeConfig(),
        prompt: "hello",
        provider: "openai",
        model: "mock-1",
        authProfileId: "openai:p2",
        authProfileIdSource: "user",
        timeoutMs: 5_000,
        runId: "run:user-order-excluded",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      const usageStats = await readUsageStats(agentDir);
      expect(usageStats["openai:p1"]?.lastUsed).toBe(1);
      expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
      expect(usageStats["openai:p2"]?.lastUsed).not.toBe(2);
    });
  });

  it("preserves user-pinned auth profiles across provider aliases", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeOpenAiCodexAuthStore(agentDir);
      mockSingleSuccessfulAttempt();

      await runEmbeddedPiAgentInline({
        sessionId: "session:test",
        sessionKey: "agent:test:user-auth-alias",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        workspaceDir,
        agentDir,
        config: makeConfig(),
        prompt: "hello",
        provider: "codex-cli",
        model: "gpt-5.4",
        authProfileId: "openai-codex:work",
        authProfileIdSource: "user",
        timeoutMs: 5_000,
        runId: "run:user-auth-alias",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      expect(runEmbeddedAttemptMock.mock.calls[0]?.[0]).toMatchObject({
        authProfileId: "openai-codex:work",
        authProfileIdSource: "user",
        provider: "codex-cli",
      });
    });
  });

  it("ignores user-locked profile when provider mismatches", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir, { includeAnthropic: true });

      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeAttempt({
          assistantTexts: ["ok"],
          lastAssistant: buildAssistant({
            stopReason: "stop",
            content: [{ type: "text", text: "ok" }],
          }),
        }),
      );

      await runEmbeddedPiAgentInline({
        sessionId: "session:test",
        sessionKey: "agent:test:mismatch",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        workspaceDir,
        agentDir,
        config: makeConfig(),
        prompt: "hello",
        provider: "openai",
        model: "mock-1",
        authProfileId: "anthropic:default",
        authProfileIdSource: "user",
        timeoutMs: 5_000,
        runId: "run:mismatch",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
    });
  });

  it("skips profiles in cooldown during initial selection", async () => {
    const { usageStats, now } = await runTurnWithCooldownSeed({
      sessionKey: "agent:test:skip-cooldown",
      runId: "run:skip-cooldown",
      authProfileId: undefined,
      authProfileIdSource: "auto",
    });

    expect(usageStats["openai:p1"]?.cooldownUntil).toBe(now + 60 * 60 * 1000);
    expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
  });

  it("fails over when all profiles are in cooldown and fallbacks are configured", async () => {
    await withTimedAgentWorkspace(async ({ agentDir, workspaceDir, now }) => {
      await writeAuthStore(agentDir, {
        usageStats: {
          "openai:p1": { lastUsed: 1, cooldownUntil: now + 60 * 60 * 1000 },
          "openai:p2": { lastUsed: 2, cooldownUntil: now + 60 * 60 * 1000 },
        },
      });

      await expect(
        runEmbeddedPiAgentInline({
          sessionId: "session:test",
          sessionKey: "agent:test:cooldown-failover",
          sessionFile: path.join(workspaceDir, "session.jsonl"),
          workspaceDir,
          agentDir,
          config: makeConfig({ fallbacks: ["openai/mock-2"] }),
          prompt: "hello",
          provider: "openai",
          model: "mock-1",
          authProfileIdSource: "auto",
          timeoutMs: 5_000,
          runId: "run:cooldown-failover",
        }),
      ).rejects.toMatchObject({
        name: "FailoverError",
        reason: "unknown",
        provider: "openai",
        model: "mock-1",
      });

      expect(runEmbeddedAttemptMock).not.toHaveBeenCalled();
    });
  });

  it("can probe one cooldowned profile when transient cooldown probe is explicitly allowed", async () => {
    await withTimedAgentWorkspace(async ({ agentDir, workspaceDir, now }) => {
      await writeAuthStore(agentDir, {
        usageStats: {
          "openai:p1": { lastUsed: 1, cooldownUntil: now + 60 * 60 * 1000 },
          "openai:p2": { lastUsed: 2, cooldownUntil: now + 60 * 60 * 1000 },
        },
      });

      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeAttempt({
          assistantTexts: ["ok"],
          lastAssistant: buildAssistant({
            stopReason: "stop",
            content: [{ type: "text", text: "ok" }],
          }),
        }),
      );

      const result = await runEmbeddedPiAgentInline({
        sessionId: "session:test",
        sessionKey: "agent:test:cooldown-probe",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        workspaceDir,
        agentDir,
        config: makeConfig({ fallbacks: ["openai/mock-2"] }),
        prompt: "hello",
        provider: "openai",
        model: "mock-1",
        authProfileIdSource: "auto",
        allowTransientCooldownProbe: true,
        timeoutMs: 5_000,
        runId: "run:cooldown-probe",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      expect(result.payloads?.[0]?.text ?? "").toContain("ok");
    });
  });

  it("can probe one cooldowned profile when overloaded cooldown is explicitly probeable", async () => {
    await withTimedAgentWorkspace(async ({ agentDir, workspaceDir, now }) => {
      await writeAuthStore(agentDir, {
        usageStats: {
          "openai:p1": {
            lastUsed: 1,
            cooldownUntil: now + 60 * 60 * 1000,
            failureCounts: { overloaded: 4 },
          },
          "openai:p2": {
            lastUsed: 2,
            cooldownUntil: now + 60 * 60 * 1000,
            failureCounts: { overloaded: 4 },
          },
        },
      });

      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeAttempt({
          assistantTexts: ["ok"],
          lastAssistant: buildAssistant({
            stopReason: "stop",
            content: [{ type: "text", text: "ok" }],
          }),
        }),
      );

      const result = await runEmbeddedPiAgentInline({
        sessionId: "session:test",
        sessionKey: "agent:test:overloaded-cooldown-probe",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        workspaceDir,
        agentDir,
        config: makeConfig({ fallbacks: ["openai/mock-2"] }),
        prompt: "hello",
        provider: "openai",
        model: "mock-1",
        authProfileIdSource: "auto",
        allowTransientCooldownProbe: true,
        timeoutMs: 5_000,
        runId: "run:overloaded-cooldown-probe",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      expect(result.payloads?.[0]?.text ?? "").toContain("ok");
    });
  });

  it("can probe one billing-disabled profile when transient cooldown probe is allowed without fallback models", async () => {
    await withTimedAgentWorkspace(async ({ agentDir, workspaceDir, now }) => {
      await writeAuthStore(agentDir, {
        usageStats: {
          "openai:p1": {
            lastUsed: 1,
            disabledUntil: now + 60 * 60 * 1000,
            disabledReason: "billing",
          },
          "openai:p2": {
            lastUsed: 2,
            disabledUntil: now + 60 * 60 * 1000,
            disabledReason: "billing",
          },
        },
      });

      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeAttempt({
          assistantTexts: ["ok"],
          lastAssistant: buildAssistant({
            stopReason: "stop",
            content: [{ type: "text", text: "ok" }],
          }),
        }),
      );

      const result = await runEmbeddedPiAgentInline({
        sessionId: "session:test",
        sessionKey: "agent:test:billing-cooldown-probe-no-fallbacks",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        workspaceDir,
        agentDir,
        config: makeConfig(),
        prompt: "hello",
        provider: "openai",
        model: "mock-1",
        authProfileIdSource: "auto",
        allowTransientCooldownProbe: true,
        timeoutMs: 5_000,
        runId: "run:billing-cooldown-probe-no-fallbacks",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      expect(result.payloads?.[0]?.text ?? "").toContain("ok");
    });
  });

  it("treats agent-level fallbacks as configured when defaults have none", async () => {
    await withTimedAgentWorkspace(async ({ agentDir, workspaceDir, now }) => {
      await writeAuthStore(agentDir, {
        usageStats: {
          "openai:p1": { lastUsed: 1, cooldownUntil: now + 60 * 60 * 1000 },
          "openai:p2": { lastUsed: 2, cooldownUntil: now + 60 * 60 * 1000 },
        },
      });

      await expect(
        runEmbeddedPiAgentInline({
          sessionId: "session:test",
          sessionKey: "agent:support:cooldown-failover",
          sessionFile: path.join(workspaceDir, "session.jsonl"),
          workspaceDir,
          agentDir,
          config: makeAgentOverrideOnlyFallbackConfig("support"),
          prompt: "hello",
          provider: "openai",
          model: "mock-1",
          authProfileIdSource: "auto",
          timeoutMs: 5_000,
          runId: "run:agent-override-fallback",
          agentId: "support",
        }),
      ).rejects.toMatchObject({
        name: "FailoverError",
        reason: "unknown",
        provider: "openai",
        model: "mock-1",
      });

      expect(runEmbeddedAttemptMock).not.toHaveBeenCalled();
    });
  });

  it("fails over with disabled reason when all profiles are unavailable", async () => {
    await withTimedAgentWorkspace(async ({ agentDir, workspaceDir, now }) => {
      await writeAuthStore(agentDir, {
        usageStats: {
          "openai:p1": {
            lastUsed: 1,
            disabledUntil: now + 60 * 60 * 1000,
            disabledReason: "billing",
            failureCounts: { rate_limit: 4 },
          },
          "openai:p2": {
            lastUsed: 2,
            disabledUntil: now + 60 * 60 * 1000,
            disabledReason: "billing",
          },
        },
      });

      await expect(
        runEmbeddedPiAgentInline({
          sessionId: "session:test",
          sessionKey: "agent:test:disabled-failover",
          sessionFile: path.join(workspaceDir, "session.jsonl"),
          workspaceDir,
          agentDir,
          config: makeConfig({ fallbacks: ["openai/mock-2"] }),
          prompt: "hello",
          provider: "openai",
          model: "mock-1",
          authProfileIdSource: "auto",
          timeoutMs: 5_000,
          runId: "run:disabled-failover",
        }),
      ).rejects.toMatchObject({
        name: "FailoverError",
        reason: "billing",
        provider: "openai",
        model: "mock-1",
      });

      expect(runEmbeddedAttemptMock).not.toHaveBeenCalled();
    });
  });

  it("fails over when auth is unavailable and fallbacks are configured", async () => {
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
        const authPath = path.join(agentDir, "auth-profiles.json");
        const authStatePath = path.join(agentDir, "auth-state.json");
        await fs.writeFile(authPath, JSON.stringify({ version: 1, profiles: {} }));
        await fs.writeFile(authStatePath, JSON.stringify({ version: 1, usageStats: {} }));

        await expect(
          runEmbeddedPiAgentInline({
            sessionId: "session:test",
            sessionKey: "agent:test:auth-unavailable",
            sessionFile: path.join(workspaceDir, "session.jsonl"),
            workspaceDir,
            agentDir,
            config: makeConfig({ fallbacks: ["openai/mock-2"], apiKey: "" }),
            prompt: "hello",
            provider: "openai",
            model: "mock-1",
            authProfileIdSource: "auto",
            timeoutMs: 5_000,
            runId: "run:auth-unavailable",
          }),
        ).rejects.toMatchObject({ name: "FailoverError", reason: "auth" });

        expect(runEmbeddedAttemptMock).not.toHaveBeenCalled();
      });
    } finally {
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
    }
  });

  it("uses the active erroring model in billing failover errors", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir);
      mockSingleErrorAttempt({
        errorMessage: "insufficient credits",
        provider: "openai",
        model: "mock-rotated",
      });

      let thrown: unknown;
      try {
        await runEmbeddedPiAgentInline({
          sessionId: "session:test",
          sessionKey: "agent:test:billing-failover-active-model",
          sessionFile: path.join(workspaceDir, "session.jsonl"),
          workspaceDir,
          agentDir,
          config: makeConfig({ fallbacks: ["openai/mock-2"] }),
          prompt: "hello",
          provider: "openai",
          model: "mock-1",
          authProfileId: "openai:p1",
          authProfileIdSource: "user",
          timeoutMs: 5_000,
          runId: "run:billing-failover-active-model",
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toMatchObject({
        name: "FailoverError",
        reason: "billing",
        provider: "openai",
        model: "mock-rotated",
      });
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("openai (mock-rotated) returned a billing error");
      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
    });
  });

  it("skips profiles in cooldown when rotating after failure", async () => {
    await withTimedAgentWorkspace(async ({ agentDir, workspaceDir, now }) => {
      const authPath = path.join(agentDir, "auth-profiles.json");
      const payload = {
        version: 1,
        profiles: {
          "openai:p1": { type: "api_key", provider: "openai", key: "sk-one" },
          "openai:p2": { type: "api_key", provider: "openai", key: "sk-two" },
          "openai:p3": { type: "api_key", provider: "openai", key: "sk-three" },
        },
        usageStats: {
          "openai:p1": { lastUsed: 1 },
          "openai:p2": { cooldownUntil: now + 60 * 60 * 1000 }, // p2 in cooldown
          "openai:p3": { lastUsed: 3 },
        },
      };
      await fs.writeFile(authPath, JSON.stringify(payload));

      mockFailedThenSuccessfulAttempt("rate limit");
      await runAutoPinnedOpenAiTurn({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:rotate-skip-cooldown",
        runId: "run:rotate-skip-cooldown",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
      const usageStats = await readUsageStats(agentDir);
      expect(typeof usageStats["openai:p1"]?.lastUsed).toBe("number");
      expect(typeof usageStats["openai:p3"]?.lastUsed).toBe("number");
      expect(usageStats["openai:p2"]?.cooldownUntil).toBe(now + 60 * 60 * 1000);
    });
  });
});
