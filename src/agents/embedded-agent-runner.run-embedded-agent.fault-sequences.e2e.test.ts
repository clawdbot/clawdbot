// Exercises ordered provider faults through the embedded runner failover boundary.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./auth-profiles/store.js";
import {
  classifyEmbeddedAgentRunResultForModelFallback,
  mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
} from "./embedded-agent-runner/result-fallback-classifier.js";
import type { EmbeddedRunAttemptResult } from "./embedded-agent-runner/run/types.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { isFailoverError } from "./failover-error.js";
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

type ProviderFault =
  | { status: 200; text: string }
  | { status: 401 }
  | { status: 402 }
  | { status: 429; window: "short" | "long" }
  | { status: 500 }
  | { status: "context_overflow" };

type AttemptObservation = {
  provider: string;
  model: string;
  profileId?: string;
  fault: ProviderFault;
};

type ScenarioOutcome =
  | {
      kind: "result";
      provider: string;
      model: string;
      attempts: unknown[];
      result: EmbeddedAgentRunResult;
    }
  | { kind: "error"; error: Error & { attempts?: unknown[] } };

const runEmbeddedAttemptMock = vi.fn<(params: unknown) => Promise<EmbeddedRunAttemptResult>>();
const { computeBackoffMock, sleepWithAbortMock } = vi.hoisted(() => ({
  computeBackoffMock: vi.fn(
    (
      _policy: { initialMs: number; maxMs: number; factor: number; jitter: number },
      _attempt: number,
    ) => 0,
  ),
  sleepWithAbortMock: vi.fn(async (_ms: number, _abortSignal?: AbortSignal) => undefined),
}));

vi.mock("./models-config.js", async () => {
  const actual = await vi.importActual<typeof import("./models-config.js")>("./models-config.js");
  return { ...actual, ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })) };
});

let runEmbeddedAgent: typeof import("./embedded-agent-runner/run.js").runEmbeddedAgent;
let runWithModelFallback: typeof import("./model-fallback-runner.js").runWithModelFallback;

beforeAll(async () => {
  vi.resetModules();
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

  ({ runEmbeddedAgent } = await import("./embedded-agent-runner/run.js"));
  ({ runWithModelFallback } = await import("./model-fallback-runner.js"));
});

beforeEach(() => {
  runEmbeddedAttemptMock.mockReset();
  computeBackoffMock.mockClear();
  sleepWithAbortMock.mockClear();
});

function makeProviderConfig(fallbacks: string[]): OpenClawConfig {
  const provider = (modelIds: string[]) => ({
    api: "openai-responses" as const,
    apiKey: "test-key",
    baseUrl: "https://example.test",
    models: modelIds.map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_000,
      maxTokens: 2_048,
    })),
  });
  return {
    agents: {
      defaults: { model: { primary: "openai/mock-1", fallbacks } },
      list: [{ id: "test" }],
    },
    models: {
      providers: {
        openai: provider(["mock-1"]),
        groq: provider(["mock-2", "mock-3"]),
      },
    },
  };
}

async function withScenarioWorkspace<T>(
  run: (paths: { agentDir: string; workspaceDir: string }) => Promise<T>,
): Promise<T> {
  const rawRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fault-sequences-"));
  const root = await fs.realpath(rawRoot);
  const agentDir = path.join(root, "agent");
  const workspaceDir = path.join(root, "workspace");
  await Promise.all([
    fs.mkdir(agentDir, { recursive: true }),
    fs.mkdir(workspaceDir, { recursive: true }),
  ]);
  try {
    return await run({ agentDir, workspaceDir });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function writeProfiles(agentDir: string, profiles: { openai: 1 | 2; groq?: boolean }): void {
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        "openai:p1": { type: "api_key", provider: "openai", key: "openai-one" },
        ...(profiles.openai === 2
          ? { "openai:p2": { type: "api_key" as const, provider: "openai", key: "openai-two" } }
          : {}),
        ...(profiles.groq
          ? { "groq:p1": { type: "api_key" as const, provider: "groq", key: "groq-one" } }
          : {}),
      },
      usageStats: {
        "openai:p1": { lastUsed: 1 },
        ...(profiles.openai === 2 ? { "openai:p2": { lastUsed: 2 } } : {}),
        ...(profiles.groq ? { "groq:p1": { lastUsed: 3 } } : {}),
      },
    },
    agentDir,
  );
}

function makeAttemptForFault(
  fault: ProviderFault,
  ref: { provider: string; model: string },
): EmbeddedRunAttemptResult {
  if (fault.status === 200) {
    return makeEmbeddedRunnerAttempt({
      assistantTexts: [fault.text],
      lastAssistant: buildEmbeddedRunnerAssistant({
        provider: ref.provider,
        model: ref.model,
        stopReason: "stop",
        content: [{ type: "text", text: fault.text }],
      }),
    });
  }
  if (fault.status === 500) {
    return makeEmbeddedRunnerAttempt({
      terminal: {
        kind: "failed",
        source: "prompt",
        error: Object.assign(
          new Error(
            '500 Internal Server Error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request."}}',
          ),
          { status: 500 },
        ),
      },
    });
  }
  const errorMessage =
    fault.status === 401
      ? "401 Unauthorized: invalid API key"
      : fault.status === 402
        ? "402 Payment Required: insufficient credits"
        : fault.status === 429
          ? fault.window === "short"
            ? "429 Too Many Requests: rate limit exceeded"
            : "429 Too Many Requests: subscription usage limit reached"
          : "Prompt is too long for this model's context window";
  return makeEmbeddedRunnerAttempt({
    lastAssistant: buildEmbeddedRunnerAssistant({
      provider: ref.provider,
      model: ref.model,
      stopReason: "error",
      errorMessage,
    }),
  });
}

function installFaultScript(faults: ProviderFault[], observations: AttemptObservation[]): void {
  let index = 0;
  runEmbeddedAttemptMock.mockImplementation(async (rawParams: unknown) => {
    const params = rawParams as { provider: string; modelId?: string; authProfileId?: string };
    const fault = faults[index];
    if (!fault) {
      throw new Error(`unexpected provider attempt ${index + 1}`);
    }
    index += 1;
    const ref = { provider: params.provider, model: params.modelId ?? "unknown" };
    observations.push({ ...ref, profileId: params.authProfileId, fault });
    return makeAttemptForFault(fault, ref);
  });
}

async function runScenario(params: {
  agentDir: string;
  workspaceDir: string;
  config: OpenClawConfig;
  runId: string;
}): Promise<ScenarioOutcome> {
  try {
    const outcome = await runWithModelFallback<EmbeddedAgentRunResult>({
      cfg: params.config,
      provider: "openai",
      model: "mock-1",
      runId: params.runId,
      sessionId: `session:${params.runId}`,
      sessionKey: `agent:test:${params.runId}`,
      agentDir: params.agentDir,
      classifyResult: ({ provider, model, result }) =>
        classifyEmbeddedAgentRunResultForModelFallback({ provider, model, result }),
      mergeExhaustedResult: ({ latestResult, preferredResult }) =>
        mergeEmbeddedAgentRunResultForModelFallbackExhaustion({
          latestResult,
          preferredResult,
        }),
      run: async (provider, model, options) =>
        await runEmbeddedAgent({
          sessionId: `session:${params.runId}`,
          sessionKey: `agent:test:${params.runId}`,
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          config: params.config,
          prompt: "hello",
          provider,
          model,
          authProfileIdSource: "auto",
          allowTransientCooldownProbe: options?.allowTransientCooldownProbe,
          isFinalFallbackAttempt: options?.isFinalFallbackAttempt,
          timeoutMs: 250,
          runId: params.runId,
          enqueue: async (task) => await task(),
        }),
    });
    return {
      kind: "result",
      provider: outcome.provider,
      model: outcome.model,
      attempts: outcome.attempts,
      result: outcome.result,
    };
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return { kind: "error", error };
  }
}

async function readUsageStats(agentDir: string) {
  return ensureAuthProfileStore(agentDir, { syncExternalCli: false }).usageStats ?? {};
}

function expectResult(outcome: ScenarioOutcome): Extract<ScenarioOutcome, { kind: "result" }> {
  expect(outcome.kind).toBe("result");
  if (outcome.kind !== "result") {
    throw outcome.error;
  }
  return outcome;
}

function expectError(outcome: ScenarioOutcome): Error & { attempts?: unknown[] } {
  expect(outcome.kind).toBe("error");
  if (outcome.kind !== "error") {
    throw new Error("expected fault sequence to fail");
  }
  return outcome.error;
}

describe("runEmbeddedAgent provider fault sequences", () => {
  it("429 -> 429 -> 200 consumes two same-model retries without rotating", async () => {
    const faults = [
      { status: 429, window: "short" },
      { status: 429, window: "short" },
      { status: 200, text: "third attempt ok" },
    ] satisfies ProviderFault[];

    await withScenarioWorkspace(async ({ agentDir, workspaceDir }) => {
      writeProfiles(agentDir, { openai: 1 });
      const observations: AttemptObservation[] = [];
      installFaultScript(faults, observations);

      const outcome = expectResult(
        await runScenario({
          agentDir,
          workspaceDir,
          config: makeProviderConfig([]),
          runId: `same-model-${faults.length}`,
        }),
      );

      expect(observations).toHaveLength(faults.length);
      expect(
        observations.map(({ provider, model, profileId }) => ({ provider, model, profileId })),
      ).toEqual(
        faults.map(() => ({ provider: "openai", model: "mock-1", profileId: "openai:p1" })),
      );
      expect(sleepWithAbortMock.mock.calls.map(([delay]) => delay)).toEqual([10_000, 20_000]);
      expect(outcome.provider).toBe("openai");
      expect(outcome.model).toBe("mock-1");
      expect(outcome.attempts).toEqual([]);
      expect(outcome.result.payloads?.[0]?.text).toContain("third attempt ok");
      const usageStats = await readUsageStats(agentDir);
      expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
      expect(usageStats["openai:p1"]?.disabledUntil).toBeUndefined();
    });
  });

  it("walks 429 -> 401 -> 500 -> 200 across profile rotation and model fallback", async () => {
    await withScenarioWorkspace(async ({ agentDir, workspaceDir }) => {
      writeProfiles(agentDir, { openai: 2, groq: true });
      const observations: AttemptObservation[] = [];
      installFaultScript(
        [
          { status: 429, window: "long" },
          { status: 401 },
          { status: 500 },
          { status: 200, text: "fallback chain ok" },
        ],
        observations,
      );

      const outcome = expectResult(
        await runScenario({
          agentDir,
          workspaceDir,
          config: makeProviderConfig(["groq/mock-2", "groq/mock-3"]),
          runId: "mixed-fault-chain",
        }),
      );

      expect(
        observations.map(({ provider, model, profileId }) => [provider, model, profileId]),
      ).toEqual([
        ["openai", "mock-1", "openai:p1"],
        ["openai", "mock-1", "openai:p2"],
        ["groq", "mock-2", "groq:p1"],
        ["groq", "mock-3", "groq:p1"],
      ]);
      expect(sleepWithAbortMock).not.toHaveBeenCalled();
      expect(outcome.provider).toBe("groq");
      expect(outcome.model).toBe("mock-3");
      expect(outcome.attempts).toMatchObject([
        { provider: "openai", model: "mock-1", reason: expect.stringMatching(/^auth/) },
        // FIXED(refactor-02): shared message evidence keeps the concrete server-error reason.
        { provider: "groq", model: "mock-2", reason: "server_error" },
      ]);
      expect(outcome.result.payloads?.[0]?.text).toContain("fallback chain ok");

      const usageStats = await readUsageStats(agentDir);
      expect(usageStats["openai:p1"]?.cooldownReason).toBe("rate_limit");
      expect(usageStats["openai:p1"]?.failureCounts?.rate_limit).toBe(1);
      expect(usageStats["openai:p2"]?.cooldownReason).toMatch(/^auth/);
      expect(usageStats["openai:p2"]?.failureCounts?.auth).toBe(1);
      expect(usageStats["groq:p1"]?.cooldownUntil).toBeUndefined();
    });
  });

  it("persists long-TTL billing cooldown and surfaces billing copy for 402", async () => {
    await withScenarioWorkspace(async ({ agentDir, workspaceDir }) => {
      writeProfiles(agentDir, { openai: 1 });
      const observations: AttemptObservation[] = [];
      installFaultScript([{ status: 402 }], observations);
      const startedAt = Date.now();

      const error = expectError(
        await runScenario({
          agentDir,
          workspaceDir,
          config: makeProviderConfig([]),
          runId: "billing-402",
        }),
      );

      expect(observations).toMatchObject([
        { provider: "openai", model: "mock-1", profileId: "openai:p1", fault: { status: 402 } },
      ]);
      expect(error.message).toContain("returned a billing error");
      expect(error.message).toContain("insufficient balance");
      const usageStats = await readUsageStats(agentDir);
      expect(usageStats["openai:p1"]?.disabledReason).toBe("billing");
      expect(usageStats["openai:p1"]?.failureCounts?.billing).toBe(1);
      expect(usageStats["openai:p1"]?.disabledUntil).toBeGreaterThanOrEqual(
        startedAt + 5 * 60 * 60 * 1_000,
      );
      expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
    });
  });

  it("surfaces context overflow as the current blocked outcome after recovery is exhausted", async () => {
    await withScenarioWorkspace(async ({ agentDir, workspaceDir }) => {
      writeProfiles(agentDir, { openai: 1 });
      const observations: AttemptObservation[] = [];
      installFaultScript([{ status: "context_overflow" }], observations);

      const outcome = expectResult(
        await runScenario({
          agentDir,
          workspaceDir,
          config: makeProviderConfig([]),
          runId: "context-overflow",
        }),
      );

      // Current behavior: legacy compaction reports no compactable transcript, so the runner
      // returns a blocked context_overflow payload instead of rotating credentials or models.
      expect(observations).toHaveLength(1);
      expect(outcome.result.meta.error).toMatchObject({ kind: "context_overflow" });
      expect(outcome.result.payloads?.[0]).toMatchObject({
        isError: true,
        text: expect.stringContaining("Context overflow: prompt too large for the model"),
      });
      expect(outcome.attempts).toEqual([]);
      const usageStats = await readUsageStats(agentDir);
      expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
    });
  });

  it("preserves the current exhausted-fallback prose for an all-fault sequence", async () => {
    await withScenarioWorkspace(async ({ agentDir, workspaceDir }) => {
      writeProfiles(agentDir, { openai: 2, groq: true });
      const observations: AttemptObservation[] = [];
      installFaultScript(
        [{ status: 429, window: "long" }, { status: 401 }, { status: 500 }, { status: 402 }],
        observations,
      );

      const error = expectError(
        await runScenario({
          agentDir,
          workspaceDir,
          config: makeProviderConfig(["groq/mock-2", "groq/mock-3"]),
          runId: "all-faults",
        }),
      );

      expect(
        observations.map(({ provider, model, profileId }) => [provider, model, profileId]),
      ).toEqual([
        ["openai", "mock-1", "openai:p1"],
        ["openai", "mock-1", "openai:p2"],
        ["groq", "mock-2", "groq:p1"],
        ["groq", "mock-3", "groq:p1"],
      ]);
      // FIXED(refactor-02): the shared concrete reason propagates through exhaustion prose and attempts.
      expect(error.message).toMatch(/^All models failed \(3\): /);
      expect(error.message).toMatch(
        /openai\/mock-1: .* \(auth(?:_permanent)?\) \| groq\/mock-2: .* \(server_error\) \| groq\/mock-3: .* \(billing\)/,
      );
      expect(isFailoverError(error)).toBe(true);
      if (!isFailoverError(error)) {
        throw new Error("expected typed failover exhaustion");
      }
      expect(error.attempts).toMatchObject([
        { provider: "openai", model: "mock-1", reason: "auth" },
        { provider: "groq", model: "mock-2", reason: "server_error" },
        { provider: "groq", model: "mock-3", reason: "billing" },
      ]);
      const usageStats = await readUsageStats(agentDir);
      expect(usageStats["openai:p1"]?.cooldownReason).toBe("rate_limit");
      expect(usageStats["openai:p2"]?.cooldownReason).toMatch(/^auth/);
      expect(usageStats["groq:p1"]?.disabledReason).toBe("billing");
    });
  });
});
