// Exercises model fallback through the embedded runner integration surface.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AuthProfileFailureReason } from "./auth-profiles.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./auth-profiles/store.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./embedded-agent-runner/result-fallback-classifier.js";
import type { EmbeddedRunAttemptResult } from "./embedded-agent-runner/run/types.js";
import { FailoverError } from "./failover-error.js";
import {
  buildEmbeddedRunnerAssistant,
  createResolvedEmbeddedRunnerModel,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBackoffE2eMocks,
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "./test-helpers/embedded-agent-runner-e2e-mocks.js";

const runEmbeddedAttemptMock = vi.fn<(params: unknown) => Promise<EmbeddedRunAttemptResult>>();
const suspendSessionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const { computeBackoffMock, sleepWithAbortMock } = vi.hoisted(() => ({
  computeBackoffMock: vi.fn(
    (
      _policy: { initialMs: number; maxMs: number; factor: number; jitter: number },
      _attempt: number,
    ) => 321,
  ),
  sleepWithAbortMock: vi.fn(async (_ms: number, _abortSignal?: AbortSignal) => undefined),
}));

vi.mock("./models-config.js", async () => {
  const mod = await vi.importActual<typeof import("./models-config.js")>("./models-config.js");
  return {
    ...mod,
    ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
  };
});

const installRunEmbeddedMocks = () => {
  // Install the runner mocks before importing runEmbeddedAgent so the e2e path
  // exercises fallback orchestration without live model/provider calls.
  installEmbeddedRunnerBaseE2eMocks();
  installEmbeddedRunnerFastRunE2eMocks({
    runEmbeddedAttempt: (params) => runEmbeddedAttemptMock(params),
  });
  installEmbeddedRunnerBackoffE2eMocks({
    computeBackoff: (policy, attempt) => computeBackoffMock(policy, attempt),
    sleepWithAbort: (ms, abortSignal) => sleepWithAbortMock(ms, abortSignal),
  });
  vi.doMock("./embedded-agent-runner/model.js", () => ({
    resolveModelAsync: async (provider: string, modelId: string) =>
      createResolvedEmbeddedRunnerModel(provider, modelId),
  }));
  vi.doMock("./session-suspension.js", async () => {
    const actual =
      await vi.importActual<typeof import("./session-suspension.js")>("./session-suspension.js");
    return { ...actual, suspendSession: suspendSessionMock };
  });
};

let runEmbeddedAgent: typeof import("./embedded-agent-runner/run.js").runEmbeddedAgent;
let runWithModelFallback: typeof import("./model-fallback.js").runWithModelFallback;

beforeAll(async () => {
  vi.resetModules();
  installRunEmbeddedMocks();
  ({ runEmbeddedAgent } = await import("./embedded-agent-runner/run.js"));
  ({ runWithModelFallback } = await import("./model-fallback.js"));
});

beforeEach(() => {
  runEmbeddedAttemptMock.mockReset();
  suspendSessionMock.mockClear();
  computeBackoffMock.mockClear();
  sleepWithAbortMock.mockClear();
});

const OVERLOADED_ERROR_PAYLOAD =
  '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
const RATE_LIMIT_ERROR_MESSAGE = "rate limit exceeded";
const NO_ENDPOINTS_FOUND_ERROR_MESSAGE = "404 No endpoints found for deepseek/deepseek-r1:free.";
const NO_ERROR_DETAILS_MESSAGE = "Unknown error (no error details in response)";

type EmbeddedAttemptParams = {
  provider: string;
  modelId?: string;
  authProfileId?: string;
};

function makeConfig(primaryProvider = "openai"): OpenClawConfig {
  const apiKeyField = ["api", "Key"].join("");
  return {
    agents: {
      defaults: {
        model: {
          primary: `${primaryProvider}/mock-1`,
          fallbacks: ["groq/mock-2"],
        },
      },
    },
    models: {
      providers: {
        [primaryProvider]: {
          api: "openai-responses",
          [apiKeyField]: `${primaryProvider}-test-key`, // pragma: allowlist secret
          baseUrl: `https://example.com/${primaryProvider}`,
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
        groq: {
          api: "openai-responses",
          [apiKeyField]: "groq-test-key", // pragma: allowlist secret
          baseUrl: "https://example.com/groq",
          models: [
            {
              id: "mock-2",
              name: "Mock 2",
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
  } satisfies OpenClawConfig;
}

async function withAgentWorkspace<T>(
  fn: (ctx: { agentDir: string; workspaceDir: string }) => Promise<T>,
): Promise<T> {
  // Each e2e case gets isolated agent/workspace dirs because usage stats and
  // transcripts are part of the fallback behavior under test.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-model-fallback-"));
  const agentDir = path.join(root, "agent");
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  try {
    return await fn({ agentDir, workspaceDir });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeAuthStore(
  agentDir: string,
  usageStats?: Record<
    string,
    {
      lastUsed?: number;
      cooldownUntil?: number;
      disabledUntil?: number;
      disabledReason?: AuthProfileFailureReason;
      failureCounts?: Partial<Record<AuthProfileFailureReason, number>>;
    }
  >,
  options?: { primaryProvider?: string },
) {
  const primaryProvider = options?.primaryProvider ?? "openai";
  const primaryProfileId = `${primaryProvider}:p1`;
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        [primaryProfileId]: {
          type: "api_key",
          provider: primaryProvider,
          key: "sk-primary",
        },
        "groq:p1": { type: "api_key", provider: "groq", key: "sk-groq" },
      },
      usageStats:
        usageStats ??
        ({
          [primaryProfileId]: { lastUsed: 1 },
          "groq:p1": { lastUsed: 2 },
        } as const),
    },
    agentDir,
  );
}

async function readUsageStats(agentDir: string) {
  return ensureAuthProfileStore(agentDir, { syncExternalCli: false }).usageStats ?? {};
}

function expectFailureCount(
  usageStats: Record<string, Record<string, unknown> | undefined>,
  profileId: string,
  reason: AuthProfileFailureReason,
  expected: number,
) {
  const failureCounts = usageStats[profileId]?.failureCounts as Record<string, unknown> | undefined;
  expect(failureCounts?.[reason]).toBe(expected);
}

async function writeMultiProfileAuthStore(
  agentDir: string,
  options?: { openAiProfileCount?: 2 | 3 },
) {
  const includeThirdOpenAiProfile = options?.openAiProfileCount !== 2;
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        "openai:p1": { type: "api_key", provider: "openai", key: "sk-openai-1" },
        "openai:p2": { type: "api_key", provider: "openai", key: "sk-openai-2" },
        ...(includeThirdOpenAiProfile
          ? { "openai:p3": { type: "api_key" as const, provider: "openai", key: "placeholder" } }
          : {}),
        "groq:p1": { type: "api_key", provider: "groq", key: "sk-groq" },
      },
      usageStats: {
        "openai:p1": { lastUsed: 1 },
        "openai:p2": { lastUsed: 2 },
        ...(includeThirdOpenAiProfile ? { "openai:p3": { lastUsed: 3 } } : {}),
        "groq:p1": { lastUsed: 4 },
      },
    },
    agentDir,
  );
}

async function runEmbeddedFallback(params: {
  agentDir: string;
  workspaceDir: string;
  sessionKey: string;
  runId: string;
  provider?: string;
  sessionId?: string;
  lane?: string;
  abortSignal?: AbortSignal;
  config?: OpenClawConfig;
}) {
  // Runs the same embedded-agent entrypoint that production fallback uses while
  // keeping provider/model attempts deterministic through mocks.
  const cfg = params.config ?? makeConfig();
  const sessionId = params.sessionId ?? `session:${params.runId}`;
  return await runWithModelFallback({
    cfg,
    provider: params.provider ?? "openai",
    model: "mock-1",
    runId: params.runId,
    sessionId: params.sessionId,
    lane: params.lane,
    agentDir: params.agentDir,
    abortSignal: params.abortSignal,
    run: (provider, model, options) =>
      runEmbeddedAgent({
        sessionId,
        sessionKey: params.sessionKey,
        sessionFile: path.join(params.workspaceDir, `${params.runId}.jsonl`),
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        config: cfg,
        prompt: "hello",
        provider,
        model,
        lane: params.lane,
        authProfileIdSource: "auto",
        allowTransientCooldownProbe: options?.allowTransientCooldownProbe,
        isFinalFallbackAttempt: options?.isFinalFallbackAttempt,
        timeoutMs: 5_000,
        runId: params.runId,
        abortSignal: params.abortSignal,
        enqueue: async (task) => await task(),
      }),
  });
}

function mockPrimaryOverloadedThenFallbackSuccess() {
  mockPrimaryErrorThenFallbackSuccess(OVERLOADED_ERROR_PAYLOAD);
}

function makeFallbackSuccessAttempt(): EmbeddedRunAttemptResult {
  return makeEmbeddedRunnerAttempt({
    assistantTexts: ["fallback ok"],
    lastAssistant: buildEmbeddedRunnerAssistant({
      provider: "groq",
      model: "mock-2",
      stopReason: "stop",
      content: [{ type: "text", text: "fallback ok" }],
    }),
  });
}

function mockPrimaryFailureThenFallbackSuccess(
  makePrimaryAttempt: (
    attemptParams: EmbeddedAttemptParams,
  ) => EmbeddedRunAttemptResult | Promise<EmbeddedRunAttemptResult>,
  options?: { primaryProvider?: string },
) {
  const primaryProvider = options?.primaryProvider ?? "openai";
  runEmbeddedAttemptMock.mockImplementation(async (params: unknown) => {
    const attemptParams = params as EmbeddedAttemptParams;
    if (attemptParams.provider === primaryProvider) {
      return await makePrimaryAttempt(attemptParams);
    }
    if (attemptParams.provider === "groq") {
      return makeFallbackSuccessAttempt();
    }
    throw new Error(`Unexpected provider ${attemptParams.provider}`);
  });
}

function mockPrimaryPromptErrorThenFallbackSuccess(errorMessage: string) {
  mockPrimaryFailureThenFallbackSuccess(() =>
    makeEmbeddedRunnerAttempt({
      promptError: new Error(errorMessage),
    }),
  );
}

function mockPrimarySuspendingPromptErrorThenFallbackSuccess(sessionId: string) {
  mockPrimaryFailureThenFallbackSuccess(() =>
    makeEmbeddedRunnerAttempt({
      sessionIdUsed: sessionId,
      promptError: new FailoverError(RATE_LIMIT_ERROR_MESSAGE, {
        reason: "rate_limit",
        provider: "openai",
        model: "mock-1",
        suspend: true,
      }),
    }),
  );
}

function mockPrimaryErrorThenFallbackSuccess(
  errorMessage: string,
  options?: { primaryProvider?: string },
) {
  mockPrimaryFailureThenFallbackSuccess(
    (attemptParams) =>
      makeEmbeddedRunnerAttempt({
        assistantTexts: [],
        lastAssistant: buildEmbeddedRunnerAssistant({
          provider: attemptParams.provider,
          model: attemptParams.modelId ?? "mock-1",
          stopReason: "error",
          errorMessage,
        }),
      }),
    options,
  );
}

function mockPrimaryStaleRateLimitTextSuccess(errorMessage: string) {
  mockPrimaryFailureThenFallbackSuccess(() =>
    makeEmbeddedRunnerAttempt({
      assistantTexts: ["primary ok"],
      lastAssistant: buildEmbeddedRunnerAssistant({
        provider: "openai",
        model: "mock-1",
        stopReason: "stop",
        content: [{ type: "text", text: "primary ok" }],
        errorMessage,
      }),
    }),
  );
}

function expectOpenAiThenGroqAttemptOrder(params?: { expectOpenAiAuthProfileId?: string }) {
  expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
  const firstCall = runEmbeddedAttemptMock.mock.calls[0]?.[0] as
    | { provider?: string; authProfileId?: string }
    | undefined;
  const secondCall = runEmbeddedAttemptMock.mock.calls[1]?.[0] as { provider?: string } | undefined;
  if (!firstCall || !secondCall) {
    throw new Error("expected primary and fallback embedded run attempts");
  }
  expect(firstCall.provider).toBe("openai");
  if (params?.expectOpenAiAuthProfileId) {
    expect(firstCall.authProfileId).toBe(params.expectOpenAiAuthProfileId);
  }
  expect(secondCall.provider).toBe("groq");
}

function mockAllProvidersOverloaded() {
  runEmbeddedAttemptMock.mockImplementation(async (params: unknown) => {
    const attemptParams = params as { provider: string; modelId: string; authProfileId?: string };
    if (attemptParams.provider === "openai" || attemptParams.provider === "groq") {
      return makeEmbeddedRunnerAttempt({
        assistantTexts: [],
        lastAssistant: buildEmbeddedRunnerAssistant({
          provider: attemptParams.provider,
          model: attemptParams.provider === "openai" ? "mock-1" : "mock-2",
          stopReason: "error",
          errorMessage: OVERLOADED_ERROR_PAYLOAD,
        }),
      });
    }
    throw new Error(`Unexpected provider ${attemptParams.provider}`);
  });
}

function countProviderAttempts(provider: string) {
  return runEmbeddedAttemptMock.mock.calls.filter(
    (call) => (call[0] as { provider?: string })?.provider === provider,
  ).length;
}

function expectProviderAttemptCounts(expected: { openai: number; groq: number }) {
  expect(countProviderAttempts("openai")).toBe(expected.openai);
  expect(countProviderAttempts("groq")).toBe(expected.groq);
}

describe("runWithModelFallback + runEmbeddedAgent failover behavior", () => {
  it("keeps tool summary on incomplete side-effect terminal results", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir);
      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeEmbeddedRunnerAttempt({
          toolMetas: [{ toolName: "write", meta: "path=out.txt" }],
          lastAssistant: buildEmbeddedRunnerAssistant({
            provider: "openai",
            model: "mock-1",
            stopReason: "stop",
            content: [],
          }),
        }),
      );

      const result = await runEmbeddedAgent({
        sessionId: "session:tool-side-effect-terminal",
        sessionKey: "agent:test:tool-side-effect-terminal",
        sessionFile: path.join(workspaceDir, "tool-side-effect-terminal.jsonl"),
        workspaceDir,
        agentDir,
        config: makeConfig(),
        prompt: "write the file",
        provider: "openai",
        model: "mock-1",
        authProfileIdSource: "auto",
        timeoutMs: 5_000,
        runId: "run:tool-side-effect-terminal",
        enqueue: async (task) => await task(),
      });

      expect(result.meta.toolSummary?.calls).toBe(1);
      expect(result.meta.toolSummary?.tools).toEqual(["write"]);
      expect(
        classifyEmbeddedAgentRunResultForModelFallback({
          provider: "openai",
          model: "gpt-5.4",
          result,
        }),
      ).toBeNull();
    });
  });

  it("falls back on OpenRouter-style no-endpoints assistant errors", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir);
      mockPrimaryErrorThenFallbackSuccess(NO_ENDPOINTS_FOUND_ERROR_MESSAGE);

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:model-not-found-no-endpoints",
        runId: "run:model-not-found-no-endpoints",
      });

      expect(result.provider).toBe("groq");
      expect(result.model).toBe("mock-2");
      expect(result.attempts[0]?.reason).toBe("model_not_found");
      expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");

      expectOpenAiThenGroqAttemptOrder();
    });
  });

  it("falls back on timeout errors using defaults-only model fallbacks", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir);
      mockPrimaryErrorThenFallbackSuccess("LLM request timed out.");

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:timeout-defaults-fallback",
        runId: "run:timeout-defaults-fallback",
      });

      expect(result.provider).toBe("groq");
      expect(result.model).toBe("mock-2");
      expect(result.attempts[0]?.reason).toBe("timeout");
      expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");

      expectOpenAiThenGroqAttemptOrder();
    });
  });

  it("falls back after Azure Foundry omits error details without cooling down the profile", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir, undefined, { primaryProvider: "azure-foundry" });
      mockPrimaryErrorThenFallbackSuccess(NO_ERROR_DETAILS_MESSAGE, {
        primaryProvider: "azure-foundry",
      });

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:no-error-details-no-cooldown",
        runId: "run:no-error-details-no-cooldown",
        config: makeConfig("azure-foundry"),
        provider: "azure-foundry",
      });

      expect(result.provider).toBe("groq");
      expect(result.model).toBe("mock-2");
      expect(result.attempts[0]?.reason).toBe("no_error_details");
      expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");

      const usageStats = await readUsageStats(agentDir);
      expect(usageStats["azure-foundry:p1"]?.cooldownUntil).toBeUndefined();
      expect(usageStats["azure-foundry:p1"]?.failureCounts?.no_error_details).toBeUndefined();
      expect(typeof usageStats["groq:p1"]?.lastUsed).toBe("number");

      expect(countProviderAttempts("azure-foundry")).toBeGreaterThan(0);
      expect(countProviderAttempts("openai")).toBe(0);
      expect(countProviderAttempts("groq")).toBe(1);
      expect(computeBackoffMock).not.toHaveBeenCalled();
      expect(sleepWithAbortMock).not.toHaveBeenCalled();
    });
  });

  it("falls back across providers after overloaded primary failure and persists transient cooldown", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir);
      mockPrimaryOverloadedThenFallbackSuccess();

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:overloaded-cross-provider",
        runId: "run:overloaded-cross-provider",
      });

      expect(result.provider).toBe("groq");
      expect(result.model).toBe("mock-2");
      expect(result.attempts[0]?.reason).toBe("overloaded");
      expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");

      const usageStats = await readUsageStats(agentDir);
      expect(typeof usageStats["openai:p1"]?.cooldownUntil).toBe("number");
      expectFailureCount(usageStats, "openai:p1", "overloaded", 1);
      expect(typeof usageStats["groq:p1"]?.lastUsed).toBe("number");

      expectOpenAiThenGroqAttemptOrder();
      expect(computeBackoffMock).not.toHaveBeenCalled();
      expect(sleepWithAbortMock).not.toHaveBeenCalled();
    });
  });

  it("falls back across providers after bare Codex/Undici transport failures", async () => {
    const cases = [
      {
        name: "undici-terminated",
        message: "terminated",
      },
      {
        name: "stream-read-error",
        message: "stream_read_error",
      },
      {
        name: "codex-empty-transport-response",
        message: "Request failed",
      },
    ] as const;

    for (const { name, message } of cases) {
      await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
        await writeAuthStore(agentDir);
        runEmbeddedAttemptMock.mockClear();
        computeBackoffMock.mockClear();
        sleepWithAbortMock.mockClear();
        mockPrimaryErrorThenFallbackSuccess(message);

        const result = await runEmbeddedFallback({
          agentDir,
          workspaceDir,
          sessionKey: `agent:test:transport-fallback:${name}`,
          runId: `run:transport-fallback:${name}`,
        });

        expect(result.provider).toBe("groq");
        expect(result.model).toBe("mock-2");
        expect(result.attempts[0]?.reason).toBe("timeout");
        expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");

        const usageStats = await readUsageStats(agentDir);
        expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
        expect(usageStats["openai:p1"]?.failureCounts).toBeUndefined();
        expect(typeof usageStats["groq:p1"]?.lastUsed).toBe("number");

        expectOpenAiThenGroqAttemptOrder();
        expect(computeBackoffMock).not.toHaveBeenCalled();
        expect(sleepWithAbortMock).not.toHaveBeenCalled();
      });
    }
  });

  it("keeps direct embedded-run lane suspension outside the outer fallback loop", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir);
      const sessionId = "session:direct-embedded-suspension";
      mockPrimarySuspendingPromptErrorThenFallbackSuccess(sessionId);

      await expect(
        runEmbeddedAgent({
          sessionId,
          sessionKey: "agent:test:direct-embedded-suspension",
          sessionFile: path.join(workspaceDir, "direct-embedded-suspension.jsonl"),
          workspaceDir,
          agentDir,
          config: {
            ...makeConfig(),
          },
          prompt: "hello",
          provider: "openai",
          model: "mock-1",
          lane: "direct-lane",
          authProfileIdSource: "auto",
          timeoutMs: 5_000,
          runId: "run:direct-embedded-suspension",
          enqueue: async (task) => await task(),
        }),
      ).rejects.toThrow();

      expect(suspendSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({ laneId: "direct-lane" }),
      );
    });
  });

  it("does not suspend the session while an outer fallback candidate remains", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir);
      const sessionId = "session:outer-fallback-suspension";
      mockPrimarySuspendingPromptErrorThenFallbackSuccess(sessionId);

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionId,
        sessionKey: "agent:test:outer-fallback-suspension",
        lane: "outer-fallback-lane",
        runId: "run:outer-fallback-suspension",
        config: {
          ...makeConfig(),
        },
      });

      expect(result.provider).toBe("groq");
      expect(suspendSessionMock).not.toHaveBeenCalled();
    });
  });

  it("falls back across providers after a bare leading 402 quota-refresh assistant error", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir);
      mockPrimaryErrorThenFallbackSuccess(
        "402 You have reached your subscription quota limit. Please wait for automatic quota refresh in the rolling time window, upgrade to a higher plan, or use a Pay-As-You-Go API Key for unlimited access.",
      );

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:bare-402-cross-provider",
        runId: "run:bare-402-cross-provider",
      });

      expect(result.provider).toBe("groq");
      expect(result.model).toBe("mock-2");
      expect(result.attempts[0]?.reason).toBe("rate_limit");
      expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");
      expectOpenAiThenGroqAttemptOrder();
    });
  });

  it("surfaces a bounded overloaded summary when every fallback candidate is overloaded", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir);
      mockAllProvidersOverloaded();

      let thrown: unknown;
      try {
        await runEmbeddedFallback({
          agentDir,
          workspaceDir,
          sessionKey: "agent:test:all-overloaded",
          runId: "run:all-overloaded",
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/^All models failed \(2\): /);
      expect((thrown as Error).message).toMatch(
        /openai\/mock-1: .* \(overloaded\) \| groq\/mock-2: .* \(overloaded\)/,
      );

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
      expect(computeBackoffMock).not.toHaveBeenCalled();
      expect(sleepWithAbortMock).not.toHaveBeenCalled();
    });
  });

  it("probes a provider already in overloaded cooldown before falling back", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      const now = Date.now();
      await writeAuthStore(agentDir, {
        "openai:p1": {
          lastUsed: 1,
          cooldownUntil: now + 60_000,
          failureCounts: { overloaded: 2 },
        },
        "groq:p1": { lastUsed: 2 },
      });
      mockPrimaryOverloadedThenFallbackSuccess();

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:overloaded-probe-fallback",
        runId: "run:overloaded-probe-fallback",
      });

      expect(result.provider).toBe("groq");
      expectOpenAiThenGroqAttemptOrder({ expectOpenAiAuthProfileId: "openai:p1" });
    });
  });

  it("persists overloaded cooldown across turns while still allowing one probe and fallback", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir);
      mockPrimaryOverloadedThenFallbackSuccess();

      const firstResult = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:overloaded-two-turns:first",
        runId: "run:overloaded-two-turns:first",
      });

      expect(firstResult.provider).toBe("groq");

      runEmbeddedAttemptMock.mockClear();
      computeBackoffMock.mockClear();
      sleepWithAbortMock.mockClear();

      mockPrimaryOverloadedThenFallbackSuccess();

      const secondResult = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:overloaded-two-turns:second",
        runId: "run:overloaded-two-turns:second",
      });

      expect(secondResult.provider).toBe("groq");
      expectOpenAiThenGroqAttemptOrder({ expectOpenAiAuthProfileId: "openai:p1" });

      const usageStats = await readUsageStats(agentDir);
      expect(typeof usageStats["openai:p1"]?.cooldownUntil).toBe("number");
      expectFailureCount(usageStats, "openai:p1", "overloaded", 2);
      expect(computeBackoffMock).not.toHaveBeenCalled();
      expect(sleepWithAbortMock).not.toHaveBeenCalled();
    });
  });

  it("keeps bare service-unavailable failures in the timeout lane without persisting cooldown", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir);
      mockPrimaryErrorThenFallbackSuccess("LLM error: service unavailable");

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:timeout-cross-provider",
        runId: "run:timeout-cross-provider",
      });

      expect(result.provider).toBe("groq");
      expect(result.attempts[0]?.reason).toBe("timeout");

      const usageStats = await readUsageStats(agentDir);
      expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
      expect(usageStats["openai:p1"]?.failureCounts).toBeUndefined();
      expect(computeBackoffMock).not.toHaveBeenCalled();
      expect(sleepWithAbortMock).not.toHaveBeenCalled();
    });
  });

  it("caps overloaded profile rotations and escalates to cross-provider fallback (#58348)", async () => {
    // When a provider has multiple auth profiles and all return overloaded_error,
    // the runner should not exhaust all profiles before falling back. It should
    // cap profile rotations at overloadedProfileRotations=1 and escalate
    // to cross-provider fallback immediately.
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeMultiProfileAuthStore(agentDir);
      mockPrimaryOverloadedThenFallbackSuccess();

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:overloaded-multi-profile-cap",
        runId: "run:overloaded-multi-profile-cap",
      });

      // Should fall back to groq instead of exhausting all 3 openai profiles
      expect(result.provider).toBe("groq");
      expect(result.model).toBe("mock-2");
      expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");

      // With overloadedProfileRotations=1, we expect:
      // - 1 initial openai attempt (p1)
      // - 1 rotation to p2 (capped)
      // - escalation to groq (1 attempt)
      // Total: 3 attempts, NOT 4 (which would mean all 3 openai profiles tried)
      expectProviderAttemptCounts({ openai: 2, groq: 1 });
    });
  });

  it("caps rate-limit profile rotations and escalates to cross-provider fallback (#58572)", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeMultiProfileAuthStore(agentDir);

      mockPrimaryErrorThenFallbackSuccess(RATE_LIMIT_ERROR_MESSAGE);

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:rate-limit-multi-profile-cap",
        runId: "run:rate-limit-multi-profile-cap",
      });

      expect(result.provider).toBe("groq");
      expect(result.model).toBe("mock-2");
      expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");

      expectProviderAttemptCounts({ openai: 2, groq: 1 });
    });
  });

  it("ignores stale classified rate-limit text when stopReason is not error", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeMultiProfileAuthStore(agentDir);

      mockPrimaryStaleRateLimitTextSuccess(RATE_LIMIT_ERROR_MESSAGE);

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:rate-limit-retry-limit-fallback",
        runId: "run:rate-limit-retry-limit-fallback",
        config: {
          ...makeConfig(),
        },
      });

      expect(result.provider).toBe("openai");
      expect(result.model).toBe("mock-1");
      expect(result.attempts).toEqual([]);

      expectProviderAttemptCounts({ openai: 1, groq: 0 });
    });
  });

  it("caps prompt-side rate-limit profile rotations before cross-provider fallback", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeMultiProfileAuthStore(agentDir);

      mockPrimaryPromptErrorThenFallbackSuccess(RATE_LIMIT_ERROR_MESSAGE);

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:prompt-rate-limit-multi-profile-cap",
        runId: "run:prompt-rate-limit-multi-profile-cap",
      });

      expect(result.provider).toBe("groq");
      expect(result.model).toBe("mock-2");

      expectProviderAttemptCounts({ openai: 2, groq: 1 });
    });
  });

  it("rotates Codex profiles on structured prompt rate limits before model fallback", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeMultiProfileAuthStore(agentDir, { openAiProfileCount: 2 });
      mockPrimaryFailureThenFallbackSuccess(() => {
        return makeEmbeddedRunnerAttempt({
          promptError: Object.assign(
            new Error("You've reached your Codex subscription usage limit."),
            { status: 429 as const },
          ),
          promptErrorSource: "prompt",
        });
      });

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:codex-structured-prompt-rate-limit",
        runId: "run:codex-structured-prompt-rate-limit",
      });

      expect(result.provider).toBe("groq");
      expect(result.model).toBe("mock-2");
      expect(result.attempts[0]?.reason).toBe("rate_limit");
      expectProviderAttemptCounts({ openai: 2, groq: 1 });
      const primaryCalls = runEmbeddedAttemptMock.mock.calls
        .map(([params]) => params as EmbeddedAttemptParams)
        .filter((params) => params.provider === "openai");
      expect(primaryCalls.map((params) => params.authProfileId)).toStrictEqual([
        "openai:p1",
        "openai:p2",
      ]);
      expect(primaryCalls.map((params) => params.modelId)).toStrictEqual(["mock-1", "mock-1"]);
    });
  });
});
