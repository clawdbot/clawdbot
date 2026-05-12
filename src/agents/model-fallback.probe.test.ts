import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createDiagnosticLogRecordCapture } from "../logging/test-helpers/diagnostic-log-capture.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import { makeModelFallbackCfg } from "./test-helpers/model-fallback-config-fixture.js";

// Mock auth-profile submodules — must be before importing model-fallback
vi.mock("./auth-profiles/store.js", () => ({
  ensureAuthProfileStore: vi.fn(),
  loadAuthProfileStoreForRuntime: vi.fn(),
}));

vi.mock("./auth-profiles/usage.js", () => ({
  getSoonestCooldownExpiry: vi.fn(),
  isProfileInCooldown: vi.fn(),
  resolveProfilesUnavailableReason: vi.fn(),
}));

vi.mock("./auth-profiles/order.js", () => ({
  resolveAuthProfileOrder: vi.fn(),
}));

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));

const emptyPluginMetadataSnapshot = vi.hoisted(() => ({
  configFingerprint: "model-fallback-probe-test-empty-plugin-metadata",
  plugins: [],
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
}));

vi.mock("./auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSource: vi.fn(() => true),
}));

type AuthProfilesStoreModule = typeof import("./auth-profiles/store.js");
type AuthProfilesSourceCheckModule = typeof import("./auth-profiles/source-check.js");
type AuthProfilesUsageModule = typeof import("./auth-profiles/usage.js");
type AuthProfilesOrderModule = typeof import("./auth-profiles/order.js");
type ModelFallbackModule = typeof import("./model-fallback.js");
type LoggerModule = typeof import("../logging/logger.js");

let mockedEnsureAuthProfileStore: ReturnType<
  typeof vi.mocked<AuthProfilesStoreModule["ensureAuthProfileStore"]>
>;
let mockedHasAnyAuthProfileStoreSource: ReturnType<
  typeof vi.mocked<AuthProfilesSourceCheckModule["hasAnyAuthProfileStoreSource"]>
>;
let mockedGetSoonestCooldownExpiry: ReturnType<
  typeof vi.mocked<AuthProfilesUsageModule["getSoonestCooldownExpiry"]>
>;
let mockedIsProfileInCooldown: ReturnType<
  typeof vi.mocked<AuthProfilesUsageModule["isProfileInCooldown"]>
>;
let mockedResolveProfilesUnavailableReason: ReturnType<
  typeof vi.mocked<AuthProfilesUsageModule["resolveProfilesUnavailableReason"]>
>;
let mockedResolveAuthProfileOrder: ReturnType<
  typeof vi.mocked<AuthProfilesOrderModule["resolveAuthProfileOrder"]>
>;
let runWithModelFallback: ModelFallbackModule["runWithModelFallback"];
let modelFallbackTesting: ModelFallbackModule["__testing"];
let _probeThrottleInternals: ModelFallbackModule["_probeThrottleInternals"];
let resetLogger: LoggerModule["resetLogger"];
let setLoggerOverride: LoggerModule["setLoggerOverride"];

const makeCfg = makeModelFallbackCfg;
let cleanupLogCapture: (() => void) | undefined;
const OPENAI_PROBE_CANDIDATE = { provider: "openai", model: "gpt-4.1-mini" } as const;

async function loadModelFallbackProbeModules() {
  const authProfilesStoreModule = await import("./auth-profiles/store.js");
  const authProfilesSourceCheckModule = await import("./auth-profiles/source-check.js");
  const authProfilesUsageModule = await import("./auth-profiles/usage.js");
  const authProfilesOrderModule = await import("./auth-profiles/order.js");
  const loggerModule = await import("../logging/logger.js");
  const modelFallbackModule = await import("./model-fallback.js");
  mockedEnsureAuthProfileStore = vi.mocked(authProfilesStoreModule.ensureAuthProfileStore);
  mockedHasAnyAuthProfileStoreSource = vi.mocked(
    authProfilesSourceCheckModule.hasAnyAuthProfileStoreSource,
  );
  mockedGetSoonestCooldownExpiry = vi.mocked(authProfilesUsageModule.getSoonestCooldownExpiry);
  mockedIsProfileInCooldown = vi.mocked(authProfilesUsageModule.isProfileInCooldown);
  mockedResolveProfilesUnavailableReason = vi.mocked(
    authProfilesUsageModule.resolveProfilesUnavailableReason,
  );
  mockedResolveAuthProfileOrder = vi.mocked(authProfilesOrderModule.resolveAuthProfileOrder);
  runWithModelFallback = modelFallbackModule.runWithModelFallback;
  modelFallbackTesting = modelFallbackModule.__testing;
  _probeThrottleInternals = modelFallbackModule._probeThrottleInternals;
  resetLogger = loggerModule.resetLogger;
  setLoggerOverride = loggerModule.setLoggerOverride;
}

beforeAll(loadModelFallbackProbeModules);

function expectFallbackUsed(
  result: { result: unknown; attempts: Array<{ reason?: string }> },
  run: {
    (...args: unknown[]): unknown;
    mock: { calls: unknown[][] };
  },
) {
  expect(result.result).toBe("ok");
  expect(run).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledWith("anthropic", "claude-haiku-3-5");
  expect(result.attempts[0]?.reason).toBe("rate_limit");
}

function expectPrimarySkippedForReason(
  result: { result: unknown; attempts: Array<{ reason?: string }> },
  run: {
    (...args: unknown[]): unknown;
    mock: { calls: unknown[][] };
  },
  reason: string,
) {
  expect(result.result).toBe("ok");
  expect(run).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledWith("anthropic", "claude-haiku-3-5");
  expect(result.attempts[0]?.reason).toBe(reason);
}

function expectPrimaryProbeSuccess(
  result: { result: unknown },
  run: {
    (...args: unknown[]): unknown;
    mock: { calls: unknown[][] };
  },
  expectedResult: unknown,
) {
  expect(result.result).toBe(expectedResult);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledWith("openai", "gpt-4.1-mini", {
    allowTransientCooldownProbe: true,
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function expectRecordWithFields(
  records: Array<Record<string, unknown>>,
  expected: Record<string, unknown>,
) {
  const matching = records.find((record) =>
    Object.entries(expected).every(([key, value]) => record[key] === value),
  );
  if (!matching) {
    throw new Error(`Expected matching record for ${JSON.stringify(expected)}`);
  }
}

async function expectProbeFailureFallsBack({
  reason,
  probeError,
}: {
  reason: "rate_limit" | "overloaded";
  probeError: Error & { status: number };
}) {
  const cfg = makeCfg({
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-4.1-mini",
          fallbacks: ["anthropic/claude-haiku-3-5", "google/gemini-2-flash"],
        },
      },
    },
  } as Partial<OpenClawConfig>);

  mockedIsProfileInCooldown.mockReturnValue(true);
  mockedGetSoonestCooldownExpiry.mockReturnValue(1_700_000_000_000 + 30 * 1000);
  mockedResolveProfilesUnavailableReason.mockReturnValue(reason);

  const run = vi.fn().mockRejectedValueOnce(probeError).mockResolvedValue("fallback-ok");

  const result = await runWithModelFallback({
    cfg,
    provider: "openai",
    model: "gpt-4.1-mini",
    run,
  });

  expect(result.result).toBe("fallback-ok");
  expect(run).toHaveBeenCalledTimes(2);
  expect(run).toHaveBeenNthCalledWith(1, "openai", "gpt-4.1-mini", {
    allowTransientCooldownProbe: true,
  });
  expect(run).toHaveBeenNthCalledWith(2, "anthropic", "claude-haiku-3-5", {
    allowTransientCooldownProbe: true,
  });
}

describe("runWithModelFallback – probe logic", () => {
  let realDateNow: () => number;
  const NOW = 1_700_000_000_000;

  const runPrimaryCandidate = (
    cfg: OpenClawConfig,
    run: (provider: string, model: string) => Promise<unknown>,
  ) =>
    runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

  function resolveOpenAiCooldownDecision(params: {
    reason: "rate_limit" | "overloaded" | "timeout" | "auth" | "billing";
    soonest: number | null;
    isPrimary?: boolean;
    hasFallbackCandidates?: boolean;
    requestedModel?: boolean;
    throttleKey?: string;
  }) {
    mockedGetSoonestCooldownExpiry.mockReturnValue(params.soonest);
    mockedResolveProfilesUnavailableReason.mockReturnValue(params.reason);
    return modelFallbackTesting.resolveCooldownDecision({
      candidate: OPENAI_PROBE_CANDIDATE,
      isPrimary: params.isPrimary ?? true,
      requestedModel: params.requestedModel ?? true,
      hasFallbackCandidates: params.hasFallbackCandidates ?? true,
      now: NOW,
      probeThrottleKey: params.throttleKey ?? "openai",
      authRuntime: {
        getSoonestCooldownExpiry: mockedGetSoonestCooldownExpiry,
        resolveProfilesUnavailableReason: mockedResolveProfilesUnavailableReason,
      } as unknown as Parameters<
        typeof modelFallbackTesting.resolveCooldownDecision
      >[0]["authRuntime"],
      authStore: { version: 1, profiles: {} },
      profileIds: ["openai-profile-1"],
    });
  }

  function expectOpenAiProbeSuspension(
    decision: ReturnType<ModelFallbackModule["__testing"]["resolveCooldownDecision"]>,
    reason: "rate_limit" | "billing",
  ) {
    expect(decision).toEqual({
      type: "suspend_lanes",
      reason,
      leaderCandidate: OPENAI_PROBE_CANDIDATE,
    });
  }

  async function expectPrimarySkippedAfterLongCooldown(reason: "billing" | "rate_limit") {
    const cfg = makeCfg();
    const expiresIn30Min = NOW + 30 * 60 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(expiresIn30Min);
    mockedResolveProfilesUnavailableReason.mockReturnValue(reason);

    const run = vi.fn().mockResolvedValue("ok");

    const result = await runPrimaryCandidate(cfg, run);
    expectPrimarySkippedForReason(result, run, reason);
  }

  beforeEach(() => {
    realDateNow = Date.now;
    Date.now = vi.fn(() => NOW);
    setLoggerOverride({ level: "silent", consoleLevel: "silent" });

    // Clear throttle state between tests
    _probeThrottleInternals.lastProbeAttempt.clear();

    // Default: ensureAuthProfileStore returns a fake store
    const fakeStore: AuthProfileStore = {
      version: 1,
      profiles: {},
    };
    mockedHasAnyAuthProfileStoreSource.mockReturnValue(true);
    mockedEnsureAuthProfileStore.mockReturnValue(fakeStore);

    // Default: resolveAuthProfileOrder returns profiles only for "openai" provider
    mockedResolveAuthProfileOrder.mockImplementation(({ provider }: { provider: string }) => {
      if (provider === "openai") {
        return ["openai-profile-1"];
      }
      if (provider === "anthropic") {
        return ["anthropic-profile-1"];
      }
      if (provider === "google") {
        return ["google-profile-1"];
      }
      return [];
    });
    // Default: only openai profiles are in cooldown; fallback providers are available
    mockedIsProfileInCooldown.mockImplementation((_store: AuthProfileStore, profileId: string) => {
      return profileId.startsWith("openai");
    });
    mockedResolveProfilesUnavailableReason.mockReturnValue("rate_limit");
  });

  afterEach(() => {
    Date.now = realDateNow;
    cleanupLogCapture?.();
    cleanupLogCapture = undefined;
    setLoggerOverride(null);
    resetLogger();
    vi.restoreAllMocks();
  });

  it("skips primary model when far from cooldown expiry (30 min remaining)", async () => {
    const cfg = makeCfg();
    // Cooldown expires in 30 min — well beyond the 2-min margin
    const expiresIn30Min = NOW + 30 * 60 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(expiresIn30Min);

    const run = vi.fn().mockResolvedValue("ok");

    const result = await runPrimaryCandidate(cfg, run);

    // Should skip primary and use fallback
    expectFallbackUsed(result, run);
  });

  it("uses inferred unavailable reason when skipping a cooldowned primary model", async () => {
    await expectPrimarySkippedAfterLongCooldown("billing");
  });

  it("decides when cooldowned primary probes are allowed", () => {
    expect(
      resolveOpenAiCooldownDecision({
        reason: "rate_limit",
        soonest: NOW + 60 * 1000,
      }),
    ).toEqual({ type: "attempt", reason: "rate_limit", markProbe: true });
    expect(
      resolveOpenAiCooldownDecision({
        reason: "rate_limit",
        soonest: NOW - 5 * 60 * 1000,
      }),
    ).toEqual({ type: "attempt", reason: "rate_limit", markProbe: true });
    expect(
      resolveOpenAiCooldownDecision({
        reason: "rate_limit",
        soonest: NOW + 30 * 1000,
        throttleKey: "recent-openai",
      }),
    ).toEqual({ type: "attempt", reason: "rate_limit", markProbe: true });

    _probeThrottleInternals.lastProbeAttempt.set("recent-openai", NOW - 10_000);
    expectOpenAiProbeSuspension(
      resolveOpenAiCooldownDecision({
        reason: "rate_limit",
        soonest: NOW + 30 * 1000,
        throttleKey: "recent-openai",
      }),
      "rate_limit",
    );
  });

  it("logs primary metadata on probe success and failure fallback decisions", async () => {
    const cfg = makeCfg();
    const logCapture = createDiagnosticLogRecordCapture();
    cleanupLogCapture = logCapture.cleanup;
    mockedGetSoonestCooldownExpiry.mockReturnValue(NOW + 60 * 1000);
    setLoggerOverride({
      level: "trace",
      consoleLevel: "silent",
      file: path.join(os.tmpdir(), `openclaw-model-fallback-probe-${randomUUID()}.log`),
    });

    const run = vi.fn().mockResolvedValue("probed-ok");

    const result = await runPrimaryCandidate(cfg, run);

    expectPrimaryProbeSuccess(result, run, "probed-ok");

    _probeThrottleInternals.lastProbeAttempt.clear();

    const fallbackCfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["anthropic/claude-haiku-3-5", "google/gemini-2-flash"],
          },
        },
      },
    } as Partial<OpenClawConfig>);
    mockedGetSoonestCooldownExpiry.mockReturnValue(NOW + 60 * 1000);
    const fallbackRun = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockResolvedValueOnce("fallback-ok");
    const onFallbackStep = vi.fn();

    const fallbackResult = await runWithModelFallback({
      cfg: fallbackCfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run: fallbackRun,
      onFallbackStep,
    });
    await logCapture.flush();

    expect(fallbackResult.result).toBe("fallback-ok");
    expect(fallbackRun).toHaveBeenNthCalledWith(1, "openai", "gpt-4.1-mini", {
      allowTransientCooldownProbe: true,
    });
    expect(fallbackRun).toHaveBeenNthCalledWith(2, "anthropic", "claude-haiku-3-5");

    const decisionPayloads = logCapture.records
      .filter((record) => record.message === "model fallback decision")
      .map((record) => requireRecord(record.attributes, "decision payload"));

    expectRecordWithFields(decisionPayloads, {
      event: "model_fallback_decision",
      decision: "probe_cooldown_candidate",
      candidateProvider: "openai",
      candidateModel: "gpt-4.1-mini",
      allowTransientCooldownProbe: true,
    });
    expectRecordWithFields(decisionPayloads, {
      event: "model_fallback_decision",
      decision: "candidate_succeeded",
      candidateProvider: "openai",
      candidateModel: "gpt-4.1-mini",
      isPrimary: true,
      requestedModelMatched: true,
    });
    expectRecordWithFields(decisionPayloads, {
      event: "model_fallback_decision",
      decision: "candidate_failed",
      candidateProvider: "openai",
      candidateModel: "gpt-4.1-mini",
      isPrimary: true,
      requestedModelMatched: true,
      nextCandidateProvider: "anthropic",
      nextCandidateModel: "claude-haiku-3-5",
      fallbackStepType: "fallback_step",
      fallbackStepFromModel: "openai/gpt-4.1-mini",
      fallbackStepToModel: "anthropic/claude-haiku-3-5",
      fallbackStepFromFailureReason: "rate_limit",
      fallbackStepChainPosition: 1,
      fallbackStepFinalOutcome: "next_fallback",
    });
    expectRecordWithFields(decisionPayloads, {
      event: "model_fallback_decision",
      decision: "candidate_succeeded",
      candidateProvider: "anthropic",
      candidateModel: "claude-haiku-3-5",
      isPrimary: false,
      requestedModelMatched: false,
      fallbackStepType: "fallback_step",
      fallbackStepFromModel: "openai/gpt-4.1-mini",
      fallbackStepToModel: "anthropic/claude-haiku-3-5",
      fallbackStepFromFailureReason: "rate_limit",
      fallbackStepChainPosition: 2,
      fallbackStepFinalOutcome: "succeeded",
    });

    const fallbackSteps = onFallbackStep.mock.calls.map(([step]) =>
      requireRecord(step, "fallback step"),
    );
    expectRecordWithFields(fallbackSteps, {
      fallbackStepType: "fallback_step",
      fallbackStepFromModel: "openai/gpt-4.1-mini",
      fallbackStepToModel: "anthropic/claude-haiku-3-5",
      fallbackStepFromFailureReason: "rate_limit",
      fallbackStepChainPosition: 1,
      fallbackStepFinalOutcome: "next_fallback",
    });
    expectRecordWithFields(fallbackSteps, {
      fallbackStepType: "fallback_step",
      fallbackStepFromModel: "openai/gpt-4.1-mini",
      fallbackStepToModel: "anthropic/claude-haiku-3-5",
      fallbackStepFromFailureReason: "rate_limit",
      fallbackStepChainPosition: 2,
      fallbackStepFinalOutcome: "succeeded",
    });
  });

  it.each([
    {
      label: "rate-limit",
      reason: "rate_limit" as const,
      probeError: Object.assign(new Error("rate limited"), { status: 429 }),
    },
    {
      label: "overloaded",
      reason: "overloaded" as const,
      probeError: Object.assign(new Error("service overloaded"), { status: 503 }),
    },
  ])(
    "attempts non-primary fallbacks during $label cooldown after primary probe failure",
    async ({ reason, probeError }) => {
      await expectProbeFailureFallsBack({
        reason,
        probeError,
      });
    },
  );

  it("keeps walking remaining fallbacks after an abort-wrapped RESOURCE_EXHAUSTED probe failure", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "google/gemini-3-flash-preview",
            fallbacks: ["anthropic/claude-haiku-3-5", "deepseek/deepseek-chat"],
          },
        },
      },
    } as Partial<OpenClawConfig>);

    mockedResolveAuthProfileOrder.mockImplementation(({ provider }: { provider: string }) => {
      if (provider === "google") {
        return ["google-profile-1"];
      }
      if (provider === "anthropic") {
        return ["anthropic-profile-1"];
      }
      if (provider === "deepseek") {
        return ["deepseek-profile-1"];
      }
      return [];
    });
    mockedIsProfileInCooldown.mockImplementation((_store: AuthProfileStore, profileId: string) =>
      profileId.startsWith("google"),
    );
    mockedGetSoonestCooldownExpiry.mockReturnValue(NOW + 30 * 1000);
    mockedResolveProfilesUnavailableReason.mockReturnValue("rate_limit");

    // Simulate Google Vertex abort-wrapped RESOURCE_EXHAUSTED (the shape that was
    // previously swallowed by shouldRethrowAbort before the fallback loop could continue)
    const primaryAbort = Object.assign(new Error("request aborted"), {
      name: "AbortError",
      cause: {
        error: {
          code: 429,
          message: "Resource has been exhausted (e.g. check quota).",
          status: "RESOURCE_EXHAUSTED",
        },
      },
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(primaryAbort)
      .mockRejectedValueOnce(
        Object.assign(new Error("fallback still rate limited"), { status: 429 }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("final fallback still rate limited"), { status: 429 }),
      );

    await expect(
      runWithModelFallback({
        cfg,
        provider: "google",
        model: "gemini-3-flash-preview",
        run,
      }),
    ).rejects.toThrow(/All models failed \(3\)/);

    // All three candidates must be attempted — the abort must not short-circuit
    expect(run).toHaveBeenCalledTimes(3);

    expect(run).toHaveBeenNthCalledWith(1, "google", "gemini-3-flash-preview", {
      allowTransientCooldownProbe: true,
    });
    expect(run).toHaveBeenNthCalledWith(2, "anthropic", "claude-haiku-3-5");
    expect(run).toHaveBeenNthCalledWith(3, "deepseek", "deepseek-chat");
  });

  it("prunes stale probe throttle entries before checking eligibility", () => {
    _probeThrottleInternals.lastProbeAttempt.set(
      "stale",
      NOW - _probeThrottleInternals.PROBE_STATE_TTL_MS - 1,
    );
    _probeThrottleInternals.lastProbeAttempt.set("fresh", NOW - 5_000);

    expect(_probeThrottleInternals.lastProbeAttempt.has("stale")).toBe(true);

    expect(_probeThrottleInternals.isProbeThrottleOpen(NOW, "fresh")).toBe(false);

    expect(_probeThrottleInternals.lastProbeAttempt.has("stale")).toBe(false);
    expect(_probeThrottleInternals.lastProbeAttempt.has("fresh")).toBe(true);
  });

  it("caps probe throttle state by evicting the oldest entries", () => {
    for (let i = 0; i < _probeThrottleInternals.MAX_PROBE_KEYS; i += 1) {
      _probeThrottleInternals.lastProbeAttempt.set(`key-${i}`, NOW - (i + 1));
    }

    _probeThrottleInternals.markProbeAttempt(NOW, "freshest");

    expect(_probeThrottleInternals.lastProbeAttempt.size).toBe(
      _probeThrottleInternals.MAX_PROBE_KEYS,
    );
    expect(_probeThrottleInternals.lastProbeAttempt.has("freshest")).toBe(true);
    expect(_probeThrottleInternals.lastProbeAttempt.has("key-255")).toBe(false);
    expect(_probeThrottleInternals.lastProbeAttempt.has("key-0")).toBe(true);
  });

  it("handles missing or non-finite soonest safely (treats as probe-worthy)", () => {
    for (const [label, soonest] of [
      ["infinity", Infinity],
      ["nan", Number.NaN],
      ["null", null],
    ] as const) {
      _probeThrottleInternals.lastProbeAttempt.clear();

      expect(
        resolveOpenAiCooldownDecision({
          reason: "rate_limit",
          soonest,
        }),
        label,
      ).toEqual({ type: "attempt", reason: "rate_limit", markProbe: true });
    }
  });

  it("single candidate skips with rate_limit and exhausts candidates", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: [],
          },
        },
      },
    } as Partial<OpenClawConfig>);

    const almostExpired = NOW + 30 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(almostExpired);

    const run = vi.fn().mockResolvedValue("unreachable");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        fallbacksOverride: [],
        run,
      }),
    ).rejects.toThrow("All models failed");

    expect(run).not.toHaveBeenCalled();
  });

  it("scopes probe throttling by agentDir to avoid cross-agent suppression", () => {
    const agentAKey = _probeThrottleInternals.resolveProbeThrottleKey("openai", "/tmp/agent-a");
    const agentBKey = _probeThrottleInternals.resolveProbeThrottleKey("openai", "/tmp/agent-b");
    _probeThrottleInternals.lastProbeAttempt.set(agentAKey, NOW - 10_000);

    expectOpenAiProbeSuspension(
      resolveOpenAiCooldownDecision({
        reason: "rate_limit",
        soonest: NOW + 30 * 1000,
        throttleKey: agentAKey,
      }),
      "rate_limit",
    );
    expect(
      resolveOpenAiCooldownDecision({
        reason: "rate_limit",
        soonest: NOW + 30 * 1000,
        throttleKey: agentBKey,
      }),
    ).toEqual({ type: "attempt", reason: "rate_limit", markProbe: true });
  });

  it("decides when billing cooldowns should probe", () => {
    // Single-provider setups need periodic probes even when the billing
    // cooldown is far from expiry, otherwise topping up credits never recovers
    // without a restart.
    expect(
      resolveOpenAiCooldownDecision({
        reason: "billing",
        soonest: NOW + 30 * 60 * 1000,
        hasFallbackCandidates: false,
      }),
    ).toEqual({ type: "attempt", reason: "billing", markProbe: true });
    expect(
      resolveOpenAiCooldownDecision({
        reason: "billing",
        soonest: NOW + 60 * 1000,
      }),
    ).toEqual({ type: "attempt", reason: "billing", markProbe: true });
    expectOpenAiProbeSuspension(
      resolveOpenAiCooldownDecision({
        reason: "billing",
        soonest: NOW + 30 * 60 * 1000,
      }),
      "billing",
    );
  });
});
