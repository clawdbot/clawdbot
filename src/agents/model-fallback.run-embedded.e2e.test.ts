import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AuthProfileFailureReason } from "./auth-profiles.js";
import { runWithModelFallback } from "./model-fallback.js";
import type { EmbeddedRunAttemptResult } from "./pi-embedded-runner/run/types.js";
import {
  buildEmbeddedRunnerAssistant,
  createResolvedEmbeddedRunnerModel,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/pi-embedded-runner-e2e-fixtures.js";
import { installEmbeddedRunnerBaseE2eMocks } from "./test-helpers/pi-embedded-runner-e2e-mocks.js";

const runEmbeddedAttemptMock = vi.fn<(params: unknown) => Promise<EmbeddedRunAttemptResult>>();
const { computeBackoffMock, sleepWithAbortMock } = vi.hoisted(() => ({
  computeBackoffMock: vi.fn(
    (
      _policy: { initialMs: number; maxMs: number; factor: number; jitter: number },
      _attempt: number,
    ) => 321,
  ),
  sleepWithAbortMock: vi.fn(async (_ms: number, _abortSignal?: AbortSignal) => undefined),
}));

vi.mock("./pi-embedded-runner/run/attempt.js", async () => {
  const actual = await vi.importActual<typeof import("./pi-embedded-runner/run/attempt.js")>(
    "./pi-embedded-runner/run/attempt.js",
  );
  return {
    ...actual,
    runEmbeddedAttempt: (params: unknown) => runEmbeddedAttemptMock(params),
  };
});

vi.mock("../infra/backoff.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/backoff.js")>("../infra/backoff.js");
  return {
    ...actual,
    computeBackoff: (
      policy: { initialMs: number; maxMs: number; factor: number; jitter: number },
      attempt: number,
    ) => computeBackoffMock(policy, attempt),
    sleepWithAbort: (ms: number, abortSignal?: AbortSignal) => sleepWithAbortMock(ms, abortSignal),
  };
});

vi.mock("./models-config.js", async () => {
  const mod = await vi.importActual<typeof import("./models-config.js")>("./models-config.js");
  return {
    ...mod,
    ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
  };
});

const installRunEmbeddedMocks = () => {
  installEmbeddedRunnerBaseE2eMocks();
  vi.doMock("./pi-embedded-runner/model.js", () => ({
    resolveModelAsync: async (provider: string, modelId: string) =>
      createResolvedEmbeddedRunnerModel(provider, modelId),
  }));
  vi.doMock("../plugins/provider-runtime.js", async () => {
    const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
      "../plugins/provider-runtime.js",
    );
    return {
      ...actual,
      prepareProviderRuntimeAuth: vi.fn(async () => undefined),
      resolveProviderCapabilitiesWithPlugin: vi.fn(() => undefined),
    };
  });
};

let runEmbeddedPiAgent: typeof import("./pi-embedded-runner/run.js").runEmbeddedPiAgent;

beforeAll(async () => {
  vi.resetModules();
  installRunEmbeddedMocks();
  ({ runEmbeddedPiAgent } = await import("./pi-embedded-runner/run.js"));
});

beforeEach(() => {
  runEmbeddedAttemptMock.mockReset();
  computeBackoffMock.mockClear();
  sleepWithAbortMock.mockClear();
});

const OVERLOADED_ERROR_PAYLOAD =
  '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
const RATE_LIMIT_ERROR_MESSAGE = "rate limit exceeded";
const NO_ENDPOINTS_FOUND_ERROR_MESSAGE = "404 No endpoints found for deepseek/deepseek-r1:free.";

type EmbeddedAttemptParams = {
  provider: string;
  modelId?: string;
  authProfileId?: string;
};

function makeConfig(): OpenClawConfig {
  const apiKeyField = ["api", "Key"].join("");
  return {
    agents: {
      defaults: {
        model: {
          primary: "openai/mock-1",
          fallbacks: ["groq/mock-2"],
        },
      },
    },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          [apiKeyField]: "openai-test-key", // pragma: allowlist secret
          baseUrl: "https://example.com/openai",
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
) {
  await fs.writeFile(
    path.join(agentDir, "auth-profiles.json"),
    JSON.stringify({
      version: 1,
      profiles: {
        "openai:p1": { type: "api_key", provider: "openai", key: "sk-openai" },
        "groq:p1": { type: "api_key", provider: "groq", key: "sk-groq" },
      },
    }),
  );
  await fs.writeFile(
    path.join(agentDir, "auth-state.json"),
    JSON.stringify({
      version: 1,
      usageStats:
        usageStats ??
        ({
          "openai:p1": { lastUsed: 1 },
          "groq:p1": { lastUsed: 2 },
        } as const),
    }),
  );
}

async function readUsageStats(agentDir: string) {
  const raw = await fs.readFile(path.join(agentDir, "auth-state.json"), "utf-8");
  return JSON.parse(raw).usageStats as Record<string, Record<string, unknown> | undefined>;
}

async function writeMultiProfileAuthStore(agentDir: string) {
  await fs.writeFile(
    path.join(agentDir, "auth-profiles.json"),
    JSON.stringify({
      version: 1,
      profiles: {
        "openai:p1": { type: "api_key", provider: "openai", key: "sk-openai-1" },
        "openai:p2": { type: "api_key", provider: "openai", key: "sk-openai-2" },
        "openai:p3": { type: "api_key", provider: "openai", key: "sk-openai-3" },
        "groq:p1": { type: "api_key", provider: "groq", key: "sk-groq" },
      },
    }),
  );
  await fs.writeFile(
    path.join(agentDir, "auth-state.json"),
    JSON.stringify({
      version: 1,
      usageStats: {
        "openai:p1": { lastUsed: 1 },
        "openai:p2": { lastUsed: 2 },
        "openai:p3": { lastUsed: 3 },
        "groq:p1": { lastUsed: 4 },
      },
    }),
  );
}

async function runEmbeddedFallback(params: {
  agentDir: string;
  workspaceDir: string;
  sessionKey: string;
  runId: string;
  abortSignal?: AbortSignal;
  config?: OpenClawConfig;
}) {
  const cfg = params.config ?? makeConfig();
  return await runWithModelFallback({
    cfg,
    provider: "openai",
    model: "mock-1",
    runId: params.runId,
    agentDir: params.agentDir,
    run: (provider, model, options) =>
      runEmbeddedPiAgent({
        sessionId: `session:${params.runId}`,
        sessionKey: params.sessionKey,
        sessionFile: path.join(params.workspaceDir, `${params.runId}.jsonl`),
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        config: cfg,
        prompt: "hello",
        provider,
        model,
        authProfileIdSource: "auto",
        allowTransientCooldownProbe: options?.allowTransientCooldownProbe,
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
) {
  runEmbeddedAttemptMock.mockImplementation(async (params: unknown) => {
    const attemptParams = params as EmbeddedAttemptParams;
    if (attemptParams.provider === "openai") {
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

function mockPrimaryErrorThenFallbackSuccess(errorMessage: string) {
  mockPrimaryFailureThenFallbackSuccess(() =>
    makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: buildEmbeddedRunnerAssistant({
        provider: "openai",
        model: "mock-1",
        stopReason: "error",
        errorMessage,
      }),
    }),
  );
}

function mockPrimaryRunLoopRateLimitThenFallbackSuccess(errorMessage: string) {
  mockPrimaryFailureThenFallbackSuccess(() =>
    makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: buildEmbeddedRunnerAssistant({
        provider: "openai",
        model: "mock-1",
        stopReason: "length",
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
  expect(firstCall).toBeDefined();
  expect(secondCall).toBeDefined();
  expect(firstCall?.provider).toBe("openai");
  if (params?.expectOpenAiAuthProfileId) {
    expect(firstCall?.authProfileId).toBe(params.expectOpenAiAuthProfileId);
  }
  expect(secondCall?.provider).toBe("groq");
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

describe("runWithModelFallback + runEmbeddedPiAgent failover behavior", () => {
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
      expect(usageStats["openai:p1"]?.failureCounts).toMatchObject({ overloaded: 1 });
      expect(typeof usageStats["groq:p1"]?.lastUsed).toBe("number");

      expectOpenAiThenGroqAttemptOrder();
      expect(computeBackoffMock).not.toHaveBeenCalled();
      expect(sleepWithAbortMock).not.toHaveBeenCalled();
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

      const usageStats = await readUsageStats(agentDir);
      expect(typeof usageStats["openai:p1"]?.cooldownUntil).toBe("number");
      expect(typeof usageStats["groq:p1"]?.cooldownUntil).toBe("number");
      expect(usageStats["openai:p1"]?.failureCounts).toMatchObject({ overloaded: 1 });
      expect(usageStats["groq:p1"]?.failureCounts).toMatchObject({ overloaded: 1 });
      expect(usageStats["openai:p1"]?.disabledUntil).toBeUndefined();
      expect(usageStats["groq:p1"]?.disabledUntil).toBeUndefined();

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
      expect(usageStats["openai:p1"]?.failureCounts).toMatchObject({ overloaded: 2 });
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

  it("rethrows AbortError during overload backoff instead of falling through fallback", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir);
      const controller = new AbortController();
      mockPrimaryOverloadedThenFallbackSuccess();
      sleepWithAbortMock.mockImplementationOnce(async () => {
        controller.abort();
        throw new Error("aborted");
      });

      await expect(
        runEmbeddedFallback({
          agentDir,
          workspaceDir,
          sessionKey: "agent:test:overloaded-backoff-abort",
          runId: "run:overloaded-backoff-abort",
          abortSignal: controller.signal,
          config: {
            ...makeConfig(),
            auth: { cooldowns: { overloadedBackoffMs: 321 } },
          },
        }),
      ).rejects.toMatchObject({
        name: "AbortError",
        message: "Operation aborted",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      const firstCall = runEmbeddedAttemptMock.mock.calls[0]?.[0] as
        | { provider?: string }
        | undefined;
      expect(firstCall?.provider).toBe("openai");
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

  it("respects overloadedProfileRotations=0 and falls back immediately", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeMultiProfileAuthStore(agentDir);
      mockPrimaryOverloadedThenFallbackSuccess();

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:overloaded-no-rotation",
        runId: "run:overloaded-no-rotation",
        config: {
          ...makeConfig(),
          auth: { cooldowns: { overloadedProfileRotations: 0 } },
        },
      });

      expect(result.provider).toBe("groq");
      expectProviderAttemptCounts({ openai: 1, groq: 1 });
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

  it("falls back on classified rate limits even when stopReason is not error", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeMultiProfileAuthStore(agentDir);

      mockPrimaryRunLoopRateLimitThenFallbackSuccess(RATE_LIMIT_ERROR_MESSAGE);

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:rate-limit-retry-limit-fallback",
        runId: "run:rate-limit-retry-limit-fallback",
        config: {
          ...makeConfig(),
          auth: { cooldowns: { rateLimitedProfileRotations: 999 } },
        },
      });

      expect(result.provider).toBe("groq");
      expect(result.model).toBe("mock-2");
      expect(result.attempts[0]?.reason).toBe("rate_limit");
      expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");

      expectProviderAttemptCounts({ openai: 3, groq: 1 });
    });
  });

  it("respects rateLimitedProfileRotations=0 and falls back immediately", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeMultiProfileAuthStore(agentDir);

      mockPrimaryErrorThenFallbackSuccess(RATE_LIMIT_ERROR_MESSAGE);

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:rate-limit-no-rotation",
        runId: "run:rate-limit-no-rotation",
        config: {
          ...makeConfig(),
          auth: { cooldowns: { rateLimitedProfileRotations: 0 } },
        },
      });

      expect(result.provider).toBe("groq");
      expectProviderAttemptCounts({ openai: 1, groq: 1 });
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

  it("respects prompt-side rateLimitedProfileRotations=0 and falls back immediately", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeMultiProfileAuthStore(agentDir);

      mockPrimaryPromptErrorThenFallbackSuccess(RATE_LIMIT_ERROR_MESSAGE);

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:prompt-rate-limit-no-rotation",
        runId: "run:prompt-rate-limit-no-rotation",
        config: {
          ...makeConfig(),
          auth: { cooldowns: { rateLimitedProfileRotations: 0 } },
        },
      });

      expect(result.provider).toBe("groq");
      expectProviderAttemptCounts({ openai: 1, groq: 1 });
    });
  });
});
