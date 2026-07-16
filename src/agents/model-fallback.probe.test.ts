// Verifies fallback cooldown probe decisions and diagnostic records.
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createDiagnosticLogRecordCapture } from "../logging/test-helpers/diagnostic-log-capture.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import type { SessionSuspensionParams } from "./session-suspension.js";
import { makeModelFallbackCfg } from "./test-helpers/model-fallback-config-fixture.js";

// Mock auth-profile submodules before importing model-fallback so the module
// captures probe-specific auth behavior instead of real profile stores.
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

const sessionSuspensionMocks = vi.hoisted(() => ({
  suspendSession: vi.fn().mockResolvedValue(undefined),
  runWithDeferredSessionSuspension: vi.fn(
    (run: () => Promise<unknown>, onDeferred?: (params: SessionSuspensionParams) => void) => {
      onDeferred?.({
        cfg: {},
        sessionId: "test-session",
        laneId: "main",
        reason: "quota_exhausted",
        failedProvider: "openai",
        failedModel: "gpt-4.1-mini",
      });
      return run();
    },
  ),
  resolveSessionSuspensionReason: vi.fn((reason: string) => {
    if (reason === "billing") {
      return "manual";
    }
    if (reason === "rate_limit") {
      return "quota_exhausted";
    }
    return "circuit_open";
  }),
}));

vi.mock("./session-suspension.js", () => sessionSuspensionMocks);

const emptyPluginMetadataSnapshot = vi.hoisted(() => ({
  policyHash: "model-fallback-probe-test-empty-plugin-policy",
  configFingerprint: "model-fallback-probe-test-empty-plugin-metadata",
  index: {
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "model-fallback-probe-test-empty-plugin-policy",
    generatedAtMs: 0,
    installRecords: {},
    plugins: [],
    diagnostics: [],
  },
  registryDiagnostics: [],
  manifestRegistry: { plugins: [], diagnostics: [] },
  plugins: [],
  diagnostics: [],
  byPluginId: new Map(),
  normalizePluginId: (pluginId: string) => pluginId,
  owners: {
    channels: new Map(),
    channelConfigs: new Map(),
    providers: new Map(),
    modelCatalogProviders: new Map(),
    cliBackends: new Map(),
    setupProviders: new Map(),
    commandAliases: new Map(),
    contracts: new Map(),
  },
  metrics: {
    registrySnapshotMs: 0,
    manifestRegistryMs: 0,
    ownerMapsMs: 0,
    totalMs: 0,
    indexPluginCount: 0,
    manifestPluginCount: 0,
  },
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
let resolveCooldownDecision: (typeof import("./model-fallback.test-support.js"))["resolveCooldownDecision"];
let probeThrottleInternals: ModelFallbackModule["probeThrottleInternals"];
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
  const modelFallbackTestSupport = await import("./model-fallback.test-support.js");
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
  resolveCooldownDecision = modelFallbackTestSupport.resolveCooldownDecision;
  probeThrottleInternals = modelFallbackModule.probeThrottleInternals;
  resetLogger = loggerModule.resetLogger;
  setLoggerOverride = loggerModule.setLoggerOverride;
}

beforeAll(loadModelFallbackProbeModules);

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
  expect(run).toHaveBeenCalledWith("anthropic", "claude-haiku-3-5", {
    isFinalFallbackAttempt: true,
  });
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
    isFinalFallbackAttempt: false,
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
  // Shared expectation for transient primary probe failures: probe the primary
  // once, then move to the first fallback with transient probing still allowed.
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
    isFinalFallbackAttempt: false,
  });
  expect(run).toHaveBeenNthCalledWith(2, "anthropic", "claude-haiku-3-5", {
    allowTransientCooldownProbe: true,
    isFinalFallbackAttempt: false,
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
    usageStats?: AuthProfileStore["usageStats"];
  }) {
    mockedGetSoonestCooldownExpiry.mockReturnValue(params.soonest);
    mockedResolveProfilesUnavailableReason.mockReturnValue(params.reason);
    const authStore: AuthProfileStore = { version: 1, profiles: {} };
    if (params.usageStats) {
      authStore.usageStats = params.usageStats;
    }
    return resolveCooldownDecision({
      candidate: OPENAI_PROBE_CANDIDATE,
      isPrimary: params.isPrimary ?? true,
      requestedModel: params.requestedModel ?? true,
      hasFallbackCandidates: params.hasFallbackCandidates ?? true,
      now: NOW,
      probeThrottleKey: params.throttleKey ?? "openai",
      authRuntime: {
        getSoonestCooldownExpiry: mockedGetSoonestCooldownExpiry,
        resolveProfilesUnavailableReason: mockedResolveProfilesUnavailableReason,
      } as unknown as Parameters<typeof resolveCooldownDecision>[0]["authRuntime"],
      authStore,
      profileIds: ["openai-profile-1"],
    });
  }

  function expectOpenAiProbeSuspension(
    decision: ReturnType<typeof resolveCooldownDecision>,
    reason: "rate_limit" | "billing",
  ) {
    expect(decision).toEqual({
      type: "suspend_lanes",
      reason,
      leaderCandidate: OPENAI_PROBE_CANDIDATE,
    });
  }

  async function expectPrimarySkippedAfterLongCooldown(reason: "billing") {
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
    probeThrottleInternals.lastProbeAttempt.clear();

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
    sessionSuspensionMocks.suspendSession.mockClear();
    sessionSuspensionMocks.runWithDeferredSessionSuspension.mockClear();
    vi.restoreAllMocks();
  });

  it("probes rate-limited primary model when far from cooldown expiry", async () => {
    const cfg = makeCfg();
    const expiresIn30Min = NOW + 30 * 60 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(expiresIn30Min);

    const run = vi.fn().mockResolvedValue("ok");

    const result = await runPrimaryCandidate(cfg, run);

    expectPrimaryProbeSuccess(result, run, "ok");
  });

  it("uses inferred unavailable reason when skipping a cooldowned primary model", async () => {
    await expectPrimarySkippedAfterLongCooldown("billing");
  });

  it("re-probes a single-provider primary blocked by a far-future subscription_limit (#90702)", () => {
    // fallbacks:[] + a multi-day subscription_limit reset must still re-probe on
    // the throttle instead of suspending until blockedUntil literally arrives,
    // since the rolling cap usually recovers earlier. Multi-fallback setups keep
    // preferring the fallback chain (covered above).
    const sixDays = 6 * 24 * 60 * 60 * 1000;
    const usageStats = {
      "openai-profile-1": {
        blockedUntil: NOW + sixDays,
        blockedReason: "subscription_limit",
        blockedSource: "wham",
      },
    } satisfies AuthProfileStore["usageStats"];

    expect(
      resolveOpenAiCooldownDecision({
        reason: "rate_limit",
        soonest: NOW + sixDays,
        hasFallbackCandidates: false,
        usageStats,
      }),
    ).toEqual({ type: "attempt", reason: "rate_limit", markProbe: true });

    // The 30s probe throttle is still honored so recovery probing cannot hammer
    // the upstream: a recent probe on the same key suspends until the slot opens.
    probeThrottleInternals.lastProbeAttempt.set("recent-openai", NOW - 10_000);
    expectOpenAiProbeSuspension(
      resolveOpenAiCooldownDecision({
        reason: "rate_limit",
        soonest: NOW + sixDays,
        hasFallbackCandidates: false,
        throttleKey: "recent-openai",
        usageStats,
      }),
      "rate_limit",
    );
  });

  it("decides when cooldowned primary probes are allowed", () => {
    expect(
      resolveOpenAiCooldownDecision({
        reason: "rate_limit",
        soonest: NOW + 30 * 60 * 1000,
      }),
    ).toEqual({ type: "attempt", reason: "rate_limit", markProbe: true });
    expectOpenAiProbeSuspension(
      resolveOpenAiCooldownDecision({
        reason: "rate_limit",
        soonest: NOW + 30 * 60 * 1000,
        usageStats: {
          "openai-profile-1": {
            blockedUntil: NOW + 30 * 60 * 1000,
            blockedReason: "subscription_limit",
            blockedSource: "wham",
          },
        },
      }),
      "rate_limit",
    );
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

    probeThrottleInternals.lastProbeAttempt.set("recent-openai", NOW - 10_000);
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

    probeThrottleInternals.lastProbeAttempt.clear();

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
      isFinalFallbackAttempt: false,
    });
    expect(fallbackRun).toHaveBeenNthCalledWith(2, "anthropic", "claude-haiku-3-5", {
      isFinalFallbackAttempt: false,
    });

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
      isFinalFallbackAttempt: false,
    });
    expect(run).toHaveBeenNthCalledWith(2, "anthropic", "claude-haiku-3-5", {
      isFinalFallbackAttempt: false,
    });
    expect(run).toHaveBeenNthCalledWith(3, "deepseek", "deepseek-chat", {
      isFinalFallbackAttempt: true,
    });
  });

  it("prunes stale probe throttle entries before checking eligibility", () => {
    probeThrottleInternals.lastProbeAttempt.set(
      "stale",
      NOW - probeThrottleInternals.PROBE_STATE_TTL_MS - 1,
    );
    probeThrottleInternals.lastProbeAttempt.set("fresh", NOW - 5_000);

    expect(probeThrottleInternals.lastProbeAttempt.has("stale")).toBe(true);

    expect(probeThrottleInternals.isProbeThrottleOpen(NOW, "fresh")).toBe(false);

    expect(probeThrottleInternals.lastProbeAttempt.has("stale")).toBe(false);
    expect(probeThrottleInternals.lastProbeAttempt.has("fresh")).toBe(true);
  });

  it("caps probe throttle state by evicting the oldest entries", () => {
    for (let i = 0; i < probeThrottleInternals.MAX_PROBE_KEYS; i += 1) {
      probeThrottleInternals.lastProbeAttempt.set(`key-${i}`, NOW - (i + 1));
    }

    probeThrottleInternals.markProbeAttempt(NOW, "freshest");

    expect(probeThrottleInternals.lastProbeAttempt.size).toBe(
      probeThrottleInternals.MAX_PROBE_KEYS,
    );
    expect(probeThrottleInternals.lastProbeAttempt.has("freshest")).toBe(true);
    expect(probeThrottleInternals.lastProbeAttempt.has("key-255")).toBe(false);
    expect(probeThrottleInternals.lastProbeAttempt.has("key-0")).toBe(true);
  });

  it("handles missing or non-finite soonest safely (treats as probe-worthy)", () => {
    for (const [label, soonest] of [
      ["infinity", Infinity],
      ["nan", Number.NaN],
      ["null", null],
    ] as const) {
      probeThrottleInternals.lastProbeAttempt.clear();

      expect(
        resolveOpenAiCooldownDecision({
          reason: "rate_limit",
          soonest,
        }),
        label,
      ).toEqual({ type: "attempt", reason: "rate_limit", markProbe: true });
    }
  });

  it("re-probes a single-provider rate-limited primary instead of suspending", async () => {
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

    // Far-future cooldown with no fallback chain: the primary must still be
    // probed so a recovered rolling cap resumes work instead of staying silent
    // until blockedUntil arrives. See #90702.
    mockedGetSoonestCooldownExpiry.mockReturnValue(NOW + 6 * 24 * 60 * 60 * 1000);

    const run = vi.fn().mockResolvedValue("probed-ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      fallbacksOverride: [],
      run,
    });

    expect(result.result).toBe("probed-ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("openai", "gpt-4.1-mini", {
      allowTransientCooldownProbe: true,
      isFinalFallbackAttempt: true,
    });
  });

  it("scopes probe throttling by agentDir to avoid cross-agent suppression", () => {
    const agentAKey = probeThrottleInternals.resolveProbeThrottleKey("openai", "/tmp/agent-a");
    const agentBKey = probeThrottleInternals.resolveProbeThrottleKey("openai", "/tmp/agent-b");
    probeThrottleInternals.lastProbeAttempt.set(agentAKey, NOW - 10_000);

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

  it("does not lock lane when fallback candidates remain after suspend_lanes decision", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["anthropic/claude-haiku-3-5"],
          },
        },
      },
    } as Partial<OpenClawConfig>);

    // Put only OpenAI into cooldown; Anthropic is available
    mockedIsProfileInCooldown.mockImplementation((_store: AuthProfileStore, profileId: string) =>
      profileId.startsWith("openai"),
    );
    mockedGetSoonestCooldownExpiry.mockReturnValue(NOW + 30 * 60 * 1000);
    mockedResolveProfilesUnavailableReason.mockReturnValue("billing");

    const run = vi.fn().mockResolvedValue("fallback-ok");

    await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
      sessionId: "test-session",
      lane: "main",
    });

    expect(sessionSuspensionMocks.suspendSession).not.toHaveBeenCalled();
  });

  it("defers embedded lane suspension only while another candidate remains", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["anthropic/claude-haiku-3-5"],
          },
        },
      },
    } as Partial<OpenClawConfig>);
    mockedIsProfileInCooldown.mockReturnValue(false);
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("primary failed"))
      .mockResolvedValueOnce("fallback-ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
      sessionId: "test-session",
      lane: "main",
    });

    expect(result.result).toBe("fallback-ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(sessionSuspensionMocks.runWithDeferredSessionSuspension).toHaveBeenCalledOnce();
  });

  it("discards deferred suspension when the outer run is aborted", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["anthropic/claude-haiku-3-5"],
          },
        },
      },
    } as Partial<OpenClawConfig>);
    mockedIsProfileInCooldown.mockReturnValue(false);
    const controller = new AbortController();
    const disconnect = new Error("client disconnected");
    disconnect.name = "ClientDisconnectError";
    const run = vi.fn().mockImplementation(async () => {
      controller.abort(disconnect);
      throw disconnect;
    });

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
        sessionId: "test-session",
        lane: "main",
        abortSignal: controller.signal,
      }),
    ).rejects.toBe(disconnect);

    expect(run).toHaveBeenCalledOnce();
    expect(sessionSuspensionMocks.runWithDeferredSessionSuspension).toHaveBeenCalledOnce();
    expect(sessionSuspensionMocks.suspendSession).not.toHaveBeenCalled();
  });

  it("keeps generic no-lane terminal suspension unbound", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["anthropic/claude-haiku-3-5"],
          },
        },
      },
    } as Partial<OpenClawConfig>);

    // Both providers in cooldown
    mockedIsProfileInCooldown.mockReturnValue(true);
    mockedGetSoonestCooldownExpiry.mockReturnValue(NOW + 30 * 60 * 1000);
    mockedResolveProfilesUnavailableReason.mockReturnValue("billing");
    mockedResolveAuthProfileOrder.mockImplementation(({ provider }: { provider: string }) => {
      if (provider === "openai") {
        return ["openai-profile-1"];
      }
      if (provider === "anthropic") {
        return ["anthropic-profile-1"];
      }
      return [];
    });

    // Throttle primary probe so billing goes to suspend_lanes
    probeThrottleInternals.lastProbeAttempt.set("openai", NOW - 10_000);

    const run = vi.fn().mockResolvedValue("should-not-run");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
        sessionId: "test-session",
      }),
    ).rejects.toThrow();

    expect(sessionSuspensionMocks.suspendSession).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: undefined,
        failedProvider: "anthropic",
      }),
    );
    expect(sessionSuspensionMocks.suspendSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ failedProvider: "openai" }),
    );
    expect(
      sessionSuspensionMocks.suspendSession.mock.calls.every(
        ([params]) => params.laneId === undefined,
      ),
    ).toBe(true);
  });

  it("restores a deferred embedded lane when later candidates cannot run", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["anthropic/claude-haiku-3-5"],
          },
        },
      },
    } as Partial<OpenClawConfig>);
    mockedIsProfileInCooldown.mockImplementation((_store: AuthProfileStore, profileId: string) =>
      profileId.startsWith("anthropic"),
    );
    mockedGetSoonestCooldownExpiry.mockReturnValue(NOW + 30 * 60 * 1000);
    mockedResolveProfilesUnavailableReason.mockReturnValue("billing");
    mockedResolveAuthProfileOrder.mockImplementation(({ provider }: { provider: string }) => [
      `${provider}-profile-1`,
    ]);
    const run = vi.fn().mockRejectedValueOnce(new Error("primary failed"));

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
        sessionId: "test-session",
      }),
    ).rejects.toThrow();

    expect(run).toHaveBeenCalledOnce();
    expect(sessionSuspensionMocks.suspendSession).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "main",
        failedProvider: "anthropic",
      }),
    );
  });

  it("restores deferred suspension when a later harness precheck fails", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["anthropic/claude-haiku-3-5"],
          },
        },
      },
    } as Partial<OpenClawConfig>);
    mockedIsProfileInCooldown.mockReturnValue(false);
    const run = vi.fn().mockRejectedValueOnce(new Error("primary failed"));

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        sessionId: "test-session",
        resolveAgentHarnessRuntimeOverride: (provider) =>
          provider === "anthropic" ? "missing-strict-harness" : undefined,
        prepareAgentHarnessRuntime: () => undefined,
        run,
      }),
    ).rejects.toThrow('Requested agent harness "missing-strict-harness" is not registered.');

    expect(run).toHaveBeenCalledOnce();
    expect(sessionSuspensionMocks.suspendSession).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "main",
        failedProvider: "openai",
      }),
    );
  });
});
