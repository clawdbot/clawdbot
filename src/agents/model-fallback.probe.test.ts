import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import { makeModelFallbackCfg } from "./test-helpers/model-fallback-config-fixture.js";

// Mock auth-profile submodules — must be before importing model-fallback
vi.mock("./auth-profiles/store.js", () => ({
  ensureAuthProfileStore: vi.fn(),
  loadAuthProfileStoreForRuntime: vi.fn(),
}));

vi.mock("./auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSource: vi.fn(),
}));

vi.mock("./auth-profiles/usage.js", () => ({
  getSoonestCooldownExpiry: vi.fn(),
  isProfileInCooldown: vi.fn(),
  resolveProfilesUnavailableReason: vi.fn(),
}));

vi.mock("./auth-profiles/order.js", () => ({
  resolveAuthProfileOrder: vi.fn(),
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
let _probeThrottleInternals: ModelFallbackModule["_probeThrottleInternals"];
let registerLogTransport: LoggerModule["registerLogTransport"];
let resetLogger: LoggerModule["resetLogger"];
let setLoggerOverride: LoggerModule["setLoggerOverride"];

const makeCfg = makeModelFallbackCfg;
let unregisterLogTransport: (() => void) | undefined;

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
  _probeThrottleInternals = modelFallbackModule._probeThrottleInternals;
  registerLogTransport = loggerModule.registerLogTransport;
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
    unregisterLogTransport?.();
    unregisterLogTransport = undefined;
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

  it("probes primary model when within 2-min margin of cooldown expiry", async () => {
    const cfg = makeCfg();
    // Cooldown expires in 1 minute — within 2-min probe margin
    const expiresIn1Min = NOW + 60 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(expiresIn1Min);

    const run = vi.fn().mockResolvedValue("probed-ok");

    const result = await runPrimaryCandidate(cfg, run);
    expectPrimaryProbeSuccess(result, run, "probed-ok");
  });

  it("logs primary metadata on probe success and failure fallback decisions", async () => {
    const cfg = makeCfg();
    const records: Array<Record<string, unknown>> = [];
    mockedGetSoonestCooldownExpiry.mockReturnValue(NOW + 60 * 1000);
    setLoggerOverride({
      level: "trace",
      consoleLevel: "silent",
      file: path.join(os.tmpdir(), `openclaw-model-fallback-probe-${Date.now()}.log`),
    });
    unregisterLogTransport = registerLogTransport((record) => {
      records.push(record);
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

    const fallbackResult = await runPrimaryCandidate(fallbackCfg, fallbackRun);

    expect(fallbackResult.result).toBe("fallback-ok");
    expect(fallbackRun).toHaveBeenNthCalledWith(1, "openai", "gpt-4.1-mini", {
      allowTransientCooldownProbe: true,
    });
    expect(fallbackRun).toHaveBeenNthCalledWith(2, "anthropic", "claude-haiku-3-5");

    const decisionPayloads = records
      .filter(
        (record) =>
          record["2"] === "model fallback decision" &&
          record["1"] &&
          typeof record["1"] === "object",
      )
      .map((record) => record["1"] as Record<string, unknown>);

    expect(decisionPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "model_fallback_decision",
          decision: "probe_cooldown_candidate",
          candidateProvider: "openai",
          candidateModel: "gpt-4.1-mini",
          allowTransientCooldownProbe: true,
        }),
        expect.objectContaining({
          event: "model_fallback_decision",
          decision: "candidate_succeeded",
          candidateProvider: "openai",
          candidateModel: "gpt-4.1-mini",
          isPrimary: true,
          requestedModelMatched: true,
        }),
        expect.objectContaining({
          event: "model_fallback_decision",
          decision: "candidate_failed",
          candidateProvider: "openai",
          candidateModel: "gpt-4.1-mini",
          isPrimary: true,
          requestedModelMatched: true,
          nextCandidateProvider: "anthropic",
          nextCandidateModel: "claude-haiku-3-5",
        }),
        expect.objectContaining({
          event: "model_fallback_decision",
          decision: "candidate_succeeded",
          candidateProvider: "anthropic",
          candidateModel: "claude-haiku-3-5",
          isPrimary: false,
          requestedModelMatched: false,
        }),
      ]),
    );
  });

  it("probes primary model when cooldown already expired", async () => {
    const cfg = makeCfg();
    // Cooldown expired 5 min ago
    const expiredAlready = NOW - 5 * 60 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(expiredAlready);

    const run = vi.fn().mockResolvedValue("recovered");

    const result = await runPrimaryCandidate(cfg, run);
    expectPrimaryProbeSuccess(result, run, "recovered");
  });

  it("attempts non-primary fallbacks during rate-limit cooldown after primary probe failure", async () => {
    await expectProbeFailureFallsBack({
      reason: "rate_limit",
      probeError: Object.assign(new Error("rate limited"), { status: 429 }),
    });
  });

  it("attempts non-primary fallbacks during overloaded cooldown after primary probe failure", async () => {
    await expectProbeFailureFallsBack({
      reason: "overloaded",
      probeError: Object.assign(new Error("service overloaded"), { status: 503 }),
    });
  });

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

  it("throttles probe when called within 30s interval", async () => {
    const cfg = makeCfg();
    // Cooldown just about to expire (within probe margin)
    const almostExpired = NOW + 30 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(almostExpired);

    // Simulate a recent probe 10s ago
    _probeThrottleInternals.lastProbeAttempt.set("openai", NOW - 10_000);

    const run = vi.fn().mockResolvedValue("ok");

    const result = await runPrimaryCandidate(cfg, run);

    // Should be throttled → skip primary, use fallback
    expectFallbackUsed(result, run);
  });

  it("allows probe when 30s have passed since last probe", async () => {
    const cfg = makeCfg();
    const almostExpired = NOW + 30 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(almostExpired);

    // Last probe was 31s ago — should NOT be throttled
    _probeThrottleInternals.lastProbeAttempt.set("openai", NOW - 31_000);

    const run = vi.fn().mockResolvedValue("probed-ok");

    const result = await runPrimaryCandidate(cfg, run);
    expectPrimaryProbeSuccess(result, run, "probed-ok");
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

  it("handles non-finite soonest safely (treats as probe-worthy)", async () => {
    const cfg = makeCfg();

    // Return Infinity — should be treated as "probe" per the guard
    mockedGetSoonestCooldownExpiry.mockReturnValue(Infinity);

    const run = vi.fn().mockResolvedValue("ok-infinity");

    const result = await runPrimaryCandidate(cfg, run);
    expectPrimaryProbeSuccess(result, run, "ok-infinity");
  });

  it("handles NaN soonest safely (treats as probe-worthy)", async () => {
    const cfg = makeCfg();

    mockedGetSoonestCooldownExpiry.mockReturnValue(NaN);

    const run = vi.fn().mockResolvedValue("ok-nan");

    const result = await runPrimaryCandidate(cfg, run);
    expectPrimaryProbeSuccess(result, run, "ok-nan");
  });

  it("handles null soonest safely (treats as probe-worthy)", async () => {
    const cfg = makeCfg();

    mockedGetSoonestCooldownExpiry.mockReturnValue(null);

    const run = vi.fn().mockResolvedValue("ok-null");

    const result = await runPrimaryCandidate(cfg, run);
    expectPrimaryProbeSuccess(result, run, "ok-null");
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

  it("scopes probe throttling by agentDir to avoid cross-agent suppression", async () => {
    const cfg = makeCfg();
    const almostExpired = NOW + 30 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(almostExpired);

    const run = vi.fn().mockResolvedValue("probed-ok");

    await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      agentDir: "/tmp/agent-a",
      run,
    });

    await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      agentDir: "/tmp/agent-b",
      run,
    });

    expect(run).toHaveBeenNthCalledWith(1, "openai", "gpt-4.1-mini", {
      allowTransientCooldownProbe: true,
    });
    expect(run).toHaveBeenNthCalledWith(2, "openai", "gpt-4.1-mini", {
      allowTransientCooldownProbe: true,
    });
  });

  it("probes billing-cooldowned primary when no fallback candidates exist", async () => {
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

    // Single-provider setups need periodic probes even when the billing
    // cooldown is far from expiry, otherwise topping up credits never recovers
    // without a restart.
    const expiresIn30Min = NOW + 30 * 60 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(expiresIn30Min);
    mockedResolveProfilesUnavailableReason.mockReturnValue("billing");

    const run = vi.fn().mockResolvedValue("billing-recovered");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      fallbacksOverride: [],
      run,
    });

    expect(result.result).toBe("billing-recovered");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("openai", "gpt-4.1-mini", {
      allowTransientCooldownProbe: true,
    });
  });

  it("probes billing-cooldowned primary with fallbacks when near cooldown expiry", async () => {
    const cfg = makeCfg();
    // Cooldown expires in 1 minute — within 2-min probe margin
    const expiresIn1Min = NOW + 60 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(expiresIn1Min);
    mockedResolveProfilesUnavailableReason.mockReturnValue("billing");

    const run = vi.fn().mockResolvedValue("billing-probe-ok");

    const result = await runPrimaryCandidate(cfg, run);

    expectPrimaryProbeSuccess(result, run, "billing-probe-ok");
  });

  it("skips billing-cooldowned primary with fallbacks when far from cooldown expiry", async () => {
    await expectPrimarySkippedAfterLongCooldown("billing");
  });
});
