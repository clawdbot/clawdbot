import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";
import * as authProfileSourceCheckModule from "./auth-profiles/source-check.js";
import * as authProfileStoreModule from "./auth-profiles/store.js";
import { saveAuthProfileStore } from "./auth-profiles/store.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { isAnthropicBillingError } from "./live-auth-keys.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
import { runWithImageModelFallback, runWithModelFallback } from "./model-fallback.js";
import { makeModelFallbackCfg } from "./test-helpers/model-fallback-config-fixture.js";

vi.mock("../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
  resolveExternalAuthProfilesWithPlugins: () => [],
}));

const makeCfg = makeModelFallbackCfg;
const OPENROUTER_MODEL_NOT_FOUND_PAYLOAD =
  '{"error":{"message":"Healer Alpha was a stealth model revealed on March 18th as an early testing version of MiMo-V2-Omni. Find it here: https://openrouter.ai/xiaomi/mimo-v2-omni","code":404},"user_id":"user_33GTyP8uDSYYbaeBO48AGHXyuMC"}';

function makeFallbacksOnlyCfg(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          fallbacks: ["openai/gpt-5.2"],
        },
      },
    },
  } as OpenClawConfig;
}

function makeProviderFallbackCfg(provider: string): OpenClawConfig {
  return makeCfg({
    agents: {
      defaults: {
        model: {
          primary: `${provider}/m1`,
          fallbacks: ["fallback/ok-model"],
        },
      },
    },
  });
}

async function withTempAuthStore<T>(
  store: AuthProfileStore,
  run: (tempDir: string) => Promise<T>,
): Promise<T> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-"));
  saveAuthProfileStore(store, tempDir);
  try {
    return await run(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function runWithStoredAuth(params: {
  cfg: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  run: (provider: string, model: string) => Promise<string>;
}) {
  return withTempAuthStore(params.store, async (tempDir) =>
    runWithModelFallback({
      cfg: params.cfg,
      provider: params.provider,
      model: "m1",
      agentDir: tempDir,
      run: params.run,
    }),
  );
}

async function expectFallsBackToHaiku(params: {
  provider: string;
  model: string;
  firstError: Error;
}) {
  const cfg = makeCfg();
  const run = vi.fn().mockRejectedValueOnce(params.firstError).mockResolvedValueOnce("ok");

  const result = await runWithModelFallback({
    cfg,
    provider: params.provider,
    model: params.model,
    run,
  });

  expect(result.result).toBe("ok");
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1]?.[0]).toBe("anthropic");
  expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
}

function createOverrideFailureRun(params: {
  overrideProvider: string;
  overrideModel: string;
  fallbackProvider: string;
  fallbackModel: string;
  firstError: Error;
}) {
  return vi.fn().mockImplementation(async (provider, model) => {
    if (provider === params.overrideProvider && model === params.overrideModel) {
      throw params.firstError;
    }
    if (provider === params.fallbackProvider && model === params.fallbackModel) {
      return "ok";
    }
    throw new Error(`unexpected fallback candidate: ${provider}/${model}`);
  });
}

function makeSingleProviderStore(params: {
  provider: string;
  usageStat: NonNullable<AuthProfileStore["usageStats"]>[string];
}): AuthProfileStore {
  const profileId = `${params.provider}:default`;
  return {
    version: AUTH_STORE_VERSION,
    profiles: {
      [profileId]: {
        type: "api_key",
        provider: params.provider,
        key: "test-key",
      },
    },
    usageStats: {
      [profileId]: params.usageStat,
    },
  };
}

function createFallbackOnlyRun() {
  return vi.fn().mockImplementation(async (providerId, modelId) => {
    if (providerId === "fallback") {
      return "ok";
    }
    throw new Error(`unexpected provider: ${providerId}/${modelId}`);
  });
}

async function expectSkippedUnavailableProvider(params: {
  providerPrefix: string;
  usageStat: NonNullable<AuthProfileStore["usageStats"]>[string];
  expectedReason: string;
}) {
  const provider = `${params.providerPrefix}-${crypto.randomUUID()}`;
  const cfg = makeProviderFallbackCfg(provider);
  const primaryStore = makeSingleProviderStore({
    provider,
    usageStat: params.usageStat,
  });
  // Include fallback provider profile so the fallback is attempted (not skipped as no-profile).
  const store: AuthProfileStore = {
    ...primaryStore,
    profiles: {
      ...primaryStore.profiles,
      "fallback:default": {
        type: "api_key",
        provider: "fallback",
        key: "test-key",
      },
    },
  };
  const run = createFallbackOnlyRun();

  const result = await runWithStoredAuth({
    cfg,
    store,
    provider,
    run,
  });

  expect(result.result).toBe("ok");
  expect(run.mock.calls).toEqual([["fallback", "ok-model"]]);
  expect(result.attempts[0]?.reason).toBe(params.expectedReason);
}

// OpenAI 429 example shape: https://help.openai.com/en/articles/5955604-how-can-i-solve-429-too-many-requests-errors
const OPENAI_RATE_LIMIT_MESSAGE =
  "Rate limit reached for gpt-4.1-mini in organization org_test on requests per min. Limit: 3.000000 / min. Current: 3.000000 / min.";
// Anthropic overloaded_error example shape: https://docs.anthropic.com/en/api/errors
const ANTHROPIC_OVERLOADED_PAYLOAD =
  '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_test"}';
// Issue-backed Anthropic/OpenAI-compatible insufficient_quota payload under HTTP 400:
// https://github.com/openclaw/openclaw/issues/23440
const INSUFFICIENT_QUOTA_PAYLOAD =
  '{"type":"error","error":{"type":"insufficient_quota","message":"Your account has insufficient quota balance to run this request."}}';
// Internal OpenClaw compatibility marker, not a provider API contract.
const MODEL_COOLDOWN_MESSAGE = "model_cooldown: All credentials for model gpt-5 are cooling down";
// SDK/transport compatibility marker, not a provider API contract.
const CONNECTION_ERROR_MESSAGE = "Connection error.";

describe("runWithModelFallback", () => {
  it("skips auth store bootstrap when no auth profile sources exist", async () => {
    const hasSourcesSpy = vi
      .spyOn(authProfileSourceCheckModule, "hasAnyAuthProfileStoreSource")
      .mockReturnValue(false);
    const ensureStoreSpy = vi.spyOn(authProfileStoreModule, "ensureAuthProfileStore");
    const run = vi.fn().mockResolvedValueOnce("ok");

    try {
      const result = await runWithModelFallback({
        cfg: makeCfg(),
        provider: "openai",
        model: "gpt-4.1-mini",
        agentDir: "/tmp/openclaw-no-auth-profiles",
        run,
      });

      expect(result.result).toBe("ok");
      expect(hasSourcesSpy).toHaveBeenCalledWith("/tmp/openclaw-no-auth-profiles");
      expect(ensureStoreSpy).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledWith("openai", "gpt-4.1-mini");
    } finally {
      hasSourcesSpy.mockRestore();
      ensureStoreSpy.mockRestore();
    }
  });

  it("keeps openai gpt-5.3 codex on the openai provider before running", async () => {
    const cfg = makeCfg();
    const run = vi.fn().mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-5.4",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("openai", "gpt-5.4");
  });

  it("falls back on unrecognized errors when candidates remain", async () => {
    const cfg = makeCfg();
    const run = vi.fn().mockRejectedValueOnce(new Error("bad request")).mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });
    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].error).toBe("bad request");
    expect(result.attempts[0].reason).toBe("unknown");
  });

  it("passes original unknown errors to onError during fallback", async () => {
    const cfg = makeCfg();
    const unknownError = new Error("provider misbehaved");
    const run = vi.fn().mockRejectedValueOnce(unknownError).mockResolvedValueOnce("ok");
    const onError = vi.fn();

    await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      provider: "openai",
      model: "gpt-4.1-mini",
      attempt: 1,
      total: 2,
    });
    expect(onError.mock.calls[0]?.[0]?.error).toBe(unknownError);
  });

  it("throws unrecognized error on last candidate", async () => {
    const cfg = makeCfg();
    const run = vi.fn().mockRejectedValueOnce(new Error("something weird"));

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
        fallbacksOverride: [],
      }),
    ).rejects.toThrow("something weird");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("treats LiveSessionModelSwitchError as failover on last candidate (#58466)", async () => {
    const cfg = makeCfg();
    const switchError = new LiveSessionModelSwitchError({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    const run = vi.fn().mockRejectedValue(switchError);

    // With no fallbacks, the single candidate is also the last one.
    // Previously this would re-throw LiveSessionModelSwitchError, causing
    // the outer retry loop to restart with the overloaded model indefinitely.
    // Now it should surface as a FailoverError instead.
    const err = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run,
      fallbacksOverride: [],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // Should NOT be a LiveSessionModelSwitchError — the outer retry loop must
    // not restart with the conflicting model.
    expect(err).not.toBeInstanceOf(LiveSessionModelSwitchError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("continues fallback chain past LiveSessionModelSwitchError to next candidate (#58466)", async () => {
    const cfg = makeCfg();
    const switchError = new LiveSessionModelSwitchError({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    const run = vi.fn().mockRejectedValueOnce(switchError).mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });
    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("falls back on auth errors", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: Object.assign(new Error("nope"), { status: 401 }),
    });
  });

  it("falls back directly to configured primary when an override model fails", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["anthropic/claude-haiku-3-5", "openrouter/deepseek-chat"],
          },
        },
      },
    });

    const run = createOverrideFailureRun({
      overrideProvider: "anthropic",
      overrideModel: "claude-opus-4-5",
      fallbackProvider: "openai",
      fallbackModel: "gpt-4.1-mini",
      firstError: Object.assign(new Error("unauthorized"), { status: 401 }),
    });

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-opus-4-5",
      run,
    });

    expect(result.result).toBe("ok");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4.1-mini");
    expect(run.mock.calls).toEqual([
      ["anthropic", "claude-opus-4-5"],
      ["openai", "gpt-4.1-mini"],
    ]);
  });

  it("keeps configured fallback chain when current model is a configured fallback", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["anthropic/claude-haiku-3-5", "openrouter/deepseek-chat"],
          },
        },
      },
    });

    const run = vi.fn().mockImplementation(async (provider: string, model: string) => {
      if (provider === "anthropic" && model === "claude-haiku-3-5") {
        throw Object.assign(new Error("rate-limited"), { status: 429 });
      }
      if (provider === "openrouter" && model === "openrouter/deepseek-chat") {
        return "ok";
      }
      throw new Error(`unexpected fallback candidate: ${provider}/${model}`);
    });

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-haiku-3-5",
      run,
    });

    expect(result.result).toBe("ok");
    expect(result.provider).toBe("openrouter");
    expect(result.model).toBe("openrouter/deepseek-chat");
    expect(run.mock.calls).toEqual([
      ["anthropic", "claude-haiku-3-5"],
      ["openrouter", "openrouter/deepseek-chat"],
    ]);
  });

  it("treats normalized default refs as primary and keeps configured fallback chain", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["anthropic/claude-haiku-3-5"],
          },
        },
      },
    });

    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("nope"), { status: 401 }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: " OpenAI ",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toEqual([
      ["openai", "gpt-4.1-mini"],
      ["anthropic", "claude-haiku-3-5"],
    ]);
  });

  it("falls back on transient HTTP 5xx errors", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: new Error(
        "521 <!DOCTYPE html><html><head><title>Web server is down</title></head><body>Cloudflare</body></html>",
      ),
    });
  });

  it("falls back on 402 payment required", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: Object.assign(new Error("payment required"), { status: 402 }),
    });
  });

  it("falls back on billing errors", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: new Error(
        "LLM request rejected: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      ),
    });
  });

  it("falls back on bare leading 402 quota-refresh errors", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: new Error(
        "402 You have reached your subscription quota limit. Please wait for automatic quota refresh in the rolling time window, upgrade to a higher plan, or use a Pay-As-You-Go API Key for unlimited access.",
      ),
    });
  });

  it("records 400 insufficient_quota payloads as billing during fallback", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error(INSUFFICIENT_QUOTA_PAYLOAD), { status: 400 }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.reason).toBe("billing");
  });

  it("falls back to configured primary for override credential validation errors", async () => {
    const cfg = makeCfg();
    const run = createOverrideFailureRun({
      overrideProvider: "anthropic",
      overrideModel: "claude-opus-4",
      fallbackProvider: "openai",
      fallbackModel: "gpt-4.1-mini",
      firstError: new Error('No credentials found for profile "anthropic:default".'),
    });

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-opus-4",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toEqual([
      ["anthropic", "claude-opus-4"],
      ["openai", "gpt-4.1-mini"],
    ]);
  });

  it("falls back on unknown model errors", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("Unknown model: anthropic/claude-opus-4-6"))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-opus-4-6",
      run,
    });

    // Override model failed with model_not_found → falls back to configured primary.
    // (Same candidate-resolution path as other override-model failures.)
    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("openai");
    expect(run.mock.calls[1]?.[1]).toBe("gpt-4.1-mini");
  });

  it("falls back on model not found errors", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("Model not found: openai/gpt-6"))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-6",
      run,
    });

    // Override model failed with model_not_found → tries fallbacks first (same provider).
    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("falls back on JSON-wrapped OpenRouter stealth-model 404s", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error(OPENROUTER_MODEL_NOT_FOUND_PAYLOAD))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openrouter",
      model: "openrouter/healer-alpha",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("openai");
    expect(run.mock.calls[1]?.[1]).toBe("gpt-4.1-mini");
  });

  it("records invalid-model HTTP 400 responses as model_not_found during fallback", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(
          new Error("HTTP 400: openrouter/__invalid_test_model__ is not a valid model ID"),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openrouter",
      model: "__invalid_test_model__",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.reason).toBe("model_not_found");
    expect(run.mock.calls[1]?.[0]).toBe("openai");
    expect(run.mock.calls[1]?.[1]).toBe("gpt-4.1-mini");
  });

  it("warns when falling back due to model_not_found", async () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cfg = makeCfg();
      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("Model not found: openai/gpt-6"))
        .mockResolvedValueOnce("ok");

      const result = await runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-6",
        run,
      });

      expect(result.result).toBe("ok");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Model "openai/gpt-6" not found'),
      );
    } finally {
      warnSpy.mockRestore();
      setLoggerOverride(null);
      resetLogger();
    }
  });

  it("sanitizes model identifiers in model_not_found warnings", async () => {
    const warnLogs = createWarnLogCapture("openclaw-model-fallback-test");
    try {
      const cfg = makeCfg();
      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("Model not found: openai/gpt-6"))
        .mockResolvedValueOnce("ok");

      const result = await runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-6\u001B[31m\nspoof",
        run,
      });

      expect(result.result).toBe("ok");
      const warning = warnLogs.findText('Model "openai/gpt-6spoof" not found');
      expect(warning).toContain('Model "openai/gpt-6spoof" not found');
      expect(warning).not.toContain("\u001B");
      expect(warning).not.toContain("\n");
    } finally {
      warnLogs.cleanup();
    }
  });

  it("skips providers when all profiles are in cooldown", async () => {
    await expectSkippedUnavailableProvider({
      providerPrefix: "cooldown-test",
      usageStat: {
        cooldownUntil: Date.now() + 5 * 60_000,
      },
      expectedReason: "unknown",
    });
  });

  it("does not skip OpenRouter when legacy cooldown markers exist", async () => {
    const provider = "openrouter";
    const cfg = makeProviderFallbackCfg(provider);
    const store = makeSingleProviderStore({
      provider,
      usageStat: {
        cooldownUntil: Date.now() + 5 * 60_000,
        disabledUntil: Date.now() + 10 * 60_000,
        disabledReason: "billing",
      },
    });
    const run = vi.fn().mockImplementation(async (providerId) => {
      if (providerId === "openrouter") {
        return "ok";
      }
      throw new Error(`unexpected provider: ${providerId}`);
    });

    const result = await runWithStoredAuth({
      cfg,
      store,
      provider,
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe("openrouter");
    expect(result.attempts).toEqual([]);
  });

  it("propagates disabled reason when all profiles are unavailable", async () => {
    const now = Date.now();
    await expectSkippedUnavailableProvider({
      providerPrefix: "disabled-test",
      usageStat: {
        disabledUntil: now + 5 * 60_000,
        disabledReason: "billing",
        failureCounts: { rate_limit: 4 },
      },
      expectedReason: "billing",
    });
  });

  it("does not skip when any profile is available", async () => {
    const provider = `cooldown-mixed-${crypto.randomUUID()}`;
    const profileA = `${provider}:a`;
    const profileB = `${provider}:b`;

    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        [profileA]: {
          type: "api_key",
          provider,
          key: "key-a",
        },
        [profileB]: {
          type: "api_key",
          provider,
          key: "key-b",
        },
      },
      usageStats: {
        [profileA]: {
          cooldownUntil: Date.now() + 60_000,
        },
      },
    };

    const cfg = makeProviderFallbackCfg(provider);
    const run = vi.fn().mockImplementation(async (providerId) => {
      if (providerId === provider) {
        return "ok";
      }
      return "unexpected";
    });

    const result = await runWithStoredAuth({
      cfg,
      store,
      provider,
      run,
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toEqual([[provider, "m1"]]);
    expect(result.attempts).toEqual([]);
  });

  it("does not append configured primary when fallbacksOverride is set", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
          },
        },
      },
    });
    const run = vi
      .fn()
      .mockImplementation(() => Promise.reject(Object.assign(new Error("nope"), { status: 401 })));

    await expect(
      runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-5",
        fallbacksOverride: ["anthropic/claude-haiku-3-5"],
        run,
      }),
    ).rejects.toThrow("All models failed");

    expect(run.mock.calls).toEqual([
      ["anthropic", "claude-opus-4-5"],
      ["anthropic", "claude-haiku-3-5"],
    ]);
  });

  it("refreshes cooldown expiry from persisted auth state before fallback summary", async () => {
    const expiry = Date.now() + 120_000;
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-5",
            fallbacks: ["openai/gpt-5.2"],
          },
        },
      },
    });
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "anthropic-key" },
        "openai:default": { type: "api_key", provider: "openai", key: "openai-key" },
      },
    };

    await withTempAuthStore(store, async (tempDir) => {
      const run = vi.fn().mockImplementation(async (provider: string, model: string) => {
        if (provider === "anthropic" && model === "claude-opus-4-5") {
          saveAuthProfileStore(
            {
              ...store,
              usageStats: {
                "anthropic:default": {
                  cooldownUntil: expiry,
                  cooldownReason: "rate_limit",
                  cooldownModel: "claude-opus-4-5",
                  failureCounts: { rate_limit: 1 },
                },
              },
            },
            tempDir,
          );
        }

        throw Object.assign(new Error("rate limited"), { status: 429 });
      });

      await expect(
        runWithModelFallback({
          cfg,
          provider: "anthropic",
          model: "claude-opus-4-5",
          agentDir: tempDir,
          run,
        }),
      ).rejects.toMatchObject({
        name: "FallbackSummaryError",
        soonestCooldownExpiry: expiry,
      });
    });
  });

  it("filters fallback summary cooldown expiry to attempted model scopes", async () => {
    const now = Date.now();
    const unrelatedExpiry = now + 15_000;
    const relevantExpiry = now + 90_000;
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-5",
            fallbacks: ["openai/gpt-5.2"],
          },
        },
      },
    });
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "anthropic-key" },
        "openai:default": { type: "api_key", provider: "openai", key: "openai-key" },
      },
      usageStats: {
        "anthropic:default": {
          cooldownUntil: unrelatedExpiry,
          cooldownReason: "rate_limit",
          cooldownModel: "claude-haiku-3-5",
          failureCounts: { rate_limit: 1 },
        },
        "openai:default": {
          cooldownUntil: relevantExpiry,
          cooldownReason: "rate_limit",
          cooldownModel: "gpt-5.2",
          failureCounts: { rate_limit: 1 },
        },
      },
    };

    await withTempAuthStore(store, async (tempDir) => {
      const run = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("rate limited"), { status: 429 }));

      await expect(
        runWithModelFallback({
          cfg,
          provider: "anthropic",
          model: "claude-opus-4-5",
          agentDir: tempDir,
          run,
        }),
      ).rejects.toMatchObject({
        name: "FallbackSummaryError",
        soonestCooldownExpiry: relevantExpiry,
      });
    });
  });

  it("uses fallbacksOverride instead of agents.defaults.model.fallbacks", async () => {
    const cfg = makeFallbacksOnlyCfg();

    const calls: Array<{ provider: string; model: string }> = [];

    const res = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-opus-4-5",
      fallbacksOverride: ["openai/gpt-4.1"],
      run: async (provider, model) => {
        calls.push({ provider, model });
        if (provider === "anthropic") {
          throw Object.assign(new Error("nope"), { status: 401 });
        }
        if (provider === "openai" && model === "gpt-4.1") {
          return "ok";
        }
        throw new Error(`unexpected candidate: ${provider}/${model}`);
      },
    });

    expect(res.result).toBe("ok");
    expect(calls).toEqual([
      { provider: "anthropic", model: "claude-opus-4-5" },
      { provider: "openai", model: "gpt-4.1" },
    ]);
  });

  it("treats an empty fallbacksOverride as disabling global fallbacks", async () => {
    const cfg = makeFallbacksOnlyCfg();

    const calls: Array<{ provider: string; model: string }> = [];

    await expect(
      runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-5",
        fallbacksOverride: [],
        run: async (provider, model) => {
          calls.push({ provider, model });
          throw new Error("primary failed");
        },
      }),
    ).rejects.toThrow("primary failed");

    expect(calls).toEqual([{ provider: "anthropic", model: "claude-opus-4-5" }]);
  });

  it("keeps explicit fallbacks reachable when models allowlist is present", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4",
            fallbacks: ["openai/gpt-4o", "ollama/llama-3"],
          },
          models: {
            "anthropic/claude-sonnet-4": {},
          },
        },
      },
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toEqual([
      ["anthropic", "claude-sonnet-4"],
      ["openai", "gpt-4o"],
    ]);
  });

  it("defaults provider/model when missing (regression #946)", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: [],
          },
        },
      },
    });

    const calls: Array<{ provider: string; model: string }> = [];

    const result = await runWithModelFallback({
      cfg,
      provider: undefined as unknown as string,
      model: undefined as unknown as string,
      run: async (provider, model) => {
        calls.push({ provider, model });
        return "ok";
      },
    });

    expect(result.result).toBe("ok");
    expect(calls).toEqual([{ provider: "openai", model: "gpt-4.1-mini" }]);
  });

  it("falls back on missing API key errors", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: new Error("No API key found for profile openai."),
    });
  });

  it("falls back on lowercase credential errors", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: new Error("no api key found for profile openai"),
    });
  });

  it("falls back on documented OpenAI 429 rate limit responses", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: Object.assign(new Error(OPENAI_RATE_LIMIT_MESSAGE), { status: 429 }),
    });
  });

  it("falls back on documented overloaded_error payloads", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: new Error(ANTHROPIC_OVERLOADED_PAYLOAD),
    });
  });

  it("falls back on internal model cooldown markers", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: new Error(MODEL_COOLDOWN_MESSAGE),
    });
  });

  it("falls back on compatibility connection error messages", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: new Error(CONNECTION_ERROR_MESSAGE),
    });
  });

  it("falls back on timeout abort errors", async () => {
    const timeoutCause = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: Object.assign(new Error("aborted"), { name: "AbortError", cause: timeoutCause }),
    });
  });

  it("falls back on abort errors with timeout reasons", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: Object.assign(new Error("aborted"), {
        name: "AbortError",
        reason: "deadline exceeded",
      }),
    });
  });

  it("falls back on abort errors with reason: abort", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: Object.assign(new Error("aborted"), {
        name: "AbortError",
        reason: "reason: abort",
      }),
    });
  });

  it("falls back on unhandled stop reason error responses", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: new Error("Unhandled stop reason: error"),
    });
  });

  it("falls back on abort errors with reason: error", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: Object.assign(new Error("aborted"), {
        name: "AbortError",
        reason: "reason: error",
      }),
    });
  });

  it("falls back when message says aborted but error is a timeout", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: Object.assign(new Error("request aborted"), { code: "ETIMEDOUT" }),
    });
  });

  it("falls back on ECONNREFUSED (local server down or remote unreachable)", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
        code: "ECONNREFUSED",
      }),
    });
  });

  it("falls back on ENETUNREACH (network disconnected)", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" }),
    });
  });

  it("falls back on EHOSTUNREACH (host unreachable)", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: Object.assign(new Error("connect EHOSTUNREACH"), { code: "EHOSTUNREACH" }),
    });
  });

  it("falls back on EAI_AGAIN (DNS resolution failure)", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: Object.assign(new Error("getaddrinfo EAI_AGAIN api.openai.com"), {
        code: "EAI_AGAIN",
      }),
    });
  });

  it("falls back on ENETRESET (connection reset by network)", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: Object.assign(new Error("connect ENETRESET"), { code: "ENETRESET" }),
    });
  });

  it("falls back on provider abort errors with request-aborted messages", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: Object.assign(new Error("Request was aborted"), { name: "AbortError" }),
    });
  });

  it("does not fall back on user aborts", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }))
      .mockResolvedValueOnce("ok");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
      }),
    ).rejects.toThrow("aborted");

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("appends the configured primary as a last fallback", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: [],
          },
        },
      },
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b:free",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4.1-mini");
  });

  // Tests for Bug A fix: Model fallback with session overrides
  describe("fallback behavior with session model overrides", () => {
    it("allows fallbacks when session model differs from config within same provider", async () => {
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["anthropic/claude-sonnet-4-5", "google/gemini-2.5-flash"],
            },
          },
        },
      });

      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("Rate limit exceeded")) // Session model fails
        .mockResolvedValueOnce("fallback success"); // First fallback succeeds

      const result = await runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-sonnet-4-20250514", // Different from config primary
        run,
      });

      expect(result.result).toBe("fallback success");
      expect(run).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenNthCalledWith(1, "anthropic", "claude-sonnet-4-20250514");
      expect(run).toHaveBeenNthCalledWith(2, "anthropic", "claude-sonnet-4-5"); // Fallback tried
    });

    it("allows fallbacks with model version differences within same provider", async () => {
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["groq/llama-3.3-70b-versatile"],
            },
          },
        },
      });

      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("Weekly quota exceeded"))
        .mockResolvedValueOnce("groq success");

      const result = await runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-5", // Version difference from config
        run,
      });

      expect(result.result).toBe("groq success");
      expect(run).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenNthCalledWith(2, "groq", "llama-3.3-70b-versatile");
    });

    it("still skips fallbacks when using different provider than config", async () => {
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: [], // Empty fallbacks to match working pattern
            },
          },
        },
      });

      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error('No credentials found for profile "openai:default".'))
        .mockResolvedValueOnce("config primary worked");

      const result = await runWithModelFallback({
        cfg,
        provider: "openai", // Different provider
        model: "gpt-4.1-mini",
        run,
      });

      // Cross-provider requests should skip configured fallbacks but still try configured primary
      expect(result.result).toBe("config primary worked");
      expect(run).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenNthCalledWith(1, "openai", "gpt-4.1-mini"); // Original request
      expect(run).toHaveBeenNthCalledWith(2, "anthropic", "claude-opus-4-6"); // Config primary as final fallback
    });

    it("uses fallbacks when session model exactly matches config primary", async () => {
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["groq/llama-3.3-70b-versatile"],
            },
          },
        },
      });

      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("Quota exceeded"))
        .mockResolvedValueOnce("fallback worked");

      const result = await runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-6", // Exact match
        run,
      });

      expect(result.result).toBe("fallback worked");
      expect(run).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenNthCalledWith(2, "groq", "llama-3.3-70b-versatile");
    });
  });

  describe("fallback behavior with provider cooldowns", () => {
    async function makeAuthStoreWithCooldown(
      provider: string,
      reason: "rate_limit" | "overloaded" | "timeout" | "auth" | "billing",
    ): Promise<{ store: AuthProfileStore; dir: string }> {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));
      const now = Date.now();
      const store: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          [`${provider}:default`]: { type: "api_key", provider, key: "test-key" },
        },
        usageStats: {
          [`${provider}:default`]:
            reason === "rate_limit" || reason === "overloaded" || reason === "timeout"
              ? {
                  cooldownUntil: now + 300000,
                  failureCounts: { [reason]: 1 },
                }
              : {
                  disabledUntil: now + 300000,
                  disabledReason: reason,
                },
        },
      };
      saveAuthProfileStore(store, tmpDir);
      return { store, dir: tmpDir };
    }

    it("attempts same-provider fallbacks during rate limit cooldown", async () => {
      const { dir } = await makeAuthStoreWithCooldown("anthropic", "rate_limit");
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["anthropic/claude-sonnet-4-5", "groq/llama-3.3-70b-versatile"],
            },
          },
        },
      });

      const run = vi.fn().mockResolvedValueOnce("sonnet success");

      const result = await runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-6",
        run,
        agentDir: dir,
      });

      expect(result.result).toBe("sonnet success");
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenNthCalledWith(1, "anthropic", "claude-sonnet-4-5", {
        allowTransientCooldownProbe: true,
      });
    });

    it("attempts same-provider fallbacks during overloaded cooldown", async () => {
      const { dir } = await makeAuthStoreWithCooldown("anthropic", "overloaded");
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["anthropic/claude-sonnet-4-5", "groq/llama-3.3-70b-versatile"],
            },
          },
        },
      });

      const run = vi.fn().mockResolvedValueOnce("sonnet success");

      const result = await runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-6",
        run,
        agentDir: dir,
      });

      expect(result.result).toBe("sonnet success");
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenNthCalledWith(1, "anthropic", "claude-sonnet-4-5", {
        allowTransientCooldownProbe: true,
      });
    });

    it("attempts same-provider fallbacks during timeout cooldown", async () => {
      const { dir } = await makeAuthStoreWithCooldown("anthropic", "timeout");
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["anthropic/claude-sonnet-4-5", "groq/llama-3.3-70b-versatile"],
            },
          },
        },
      });

      const run = vi.fn().mockResolvedValueOnce("sonnet success");

      const result = await runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-6",
        run,
        agentDir: dir,
      });

      expect(result.result).toBe("sonnet success");
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenNthCalledWith(1, "anthropic", "claude-sonnet-4-5", {
        allowTransientCooldownProbe: true,
      });
    });

    it("skips same-provider models on auth cooldown but still tries no-profile fallback providers", async () => {
      const { dir } = await makeAuthStoreWithCooldown("anthropic", "auth");
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["anthropic/claude-sonnet-4-5", "groq/llama-3.3-70b-versatile"],
            },
          },
        },
      });

      const run = vi.fn().mockResolvedValueOnce("groq success");

      const result = await runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-6",
        run,
        agentDir: dir,
      });

      expect(result.result).toBe("groq success");
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenNthCalledWith(1, "groq", "llama-3.3-70b-versatile");
    });

    it("skips same-provider models on billing cooldown but still tries no-profile fallback providers", async () => {
      const { dir } = await makeAuthStoreWithCooldown("anthropic", "billing");
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["anthropic/claude-sonnet-4-5", "groq/llama-3.3-70b-versatile"],
            },
          },
        },
      });

      const run = vi.fn().mockResolvedValueOnce("groq success");

      const result = await runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-6",
        run,
        agentDir: dir,
      });

      expect(result.result).toBe("groq success");
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenNthCalledWith(1, "groq", "llama-3.3-70b-versatile");
    });

    it("tries cross-provider fallbacks when same provider has rate limit", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));
      const store: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "anthropic:default": { type: "api_key", provider: "anthropic", key: "test-key" },
          "groq:default": { type: "api_key", provider: "groq", key: "test-key" },
        },
        usageStats: {
          "anthropic:default": {
            cooldownUntil: Date.now() + 300000,
            failureCounts: { rate_limit: 2 },
          },
        },
      };
      saveAuthProfileStore(store, tmpDir);

      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["anthropic/claude-sonnet-4-5", "groq/llama-3.3-70b-versatile"],
            },
          },
        },
      });

      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("Still rate limited"))
        .mockResolvedValueOnce("groq success");

      const result = await runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-6",
        run,
        agentDir: tmpDir,
      });

      expect(result.result).toBe("groq success");
      expect(run).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenNthCalledWith(1, "anthropic", "claude-sonnet-4-5", {
        allowTransientCooldownProbe: true,
      });
      expect(run).toHaveBeenNthCalledWith(2, "groq", "llama-3.3-70b-versatile");
    });

    it("limits cooldown probes to one per provider before moving to cross-provider fallback", async () => {
      const { dir } = await makeAuthStoreWithCooldown("anthropic", "rate_limit");
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: [
                "anthropic/claude-sonnet-4-5",
                "anthropic/claude-haiku-3-5",
                "groq/llama-3.3-70b-versatile",
              ],
            },
          },
        },
      });

      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("Still rate limited"))
        .mockResolvedValueOnce("groq success");

      const result = await runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-6",
        run,
        agentDir: dir,
      });

      expect(result.result).toBe("groq success");
      expect(run).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenNthCalledWith(1, "anthropic", "claude-sonnet-4-5", {
        allowTransientCooldownProbe: true,
      });
      expect(run).toHaveBeenNthCalledWith(2, "groq", "llama-3.3-70b-versatile");
    });

    it("does not consume transient probe slot when first same-provider probe fails with model_not_found", async () => {
      const { dir } = await makeAuthStoreWithCooldown("anthropic", "rate_limit");
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: [
                "anthropic/claude-sonnet-4-5",
                "anthropic/claude-haiku-3-5",
                "groq/llama-3.3-70b-versatile",
              ],
            },
          },
        },
      });

      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("Model not found: anthropic/claude-sonnet-4-5"))
        .mockResolvedValueOnce("haiku success");

      const result = await runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-6",
        run,
        agentDir: dir,
      });

      expect(result.result).toBe("haiku success");
      expect(run).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenNthCalledWith(1, "anthropic", "claude-sonnet-4-5", {
        allowTransientCooldownProbe: true,
      });
      expect(run).toHaveBeenNthCalledWith(2, "anthropic", "claude-haiku-3-5", {
        allowTransientCooldownProbe: true,
      });
    });
  });
});

describe("runWithImageModelFallback", () => {
  it("keeps explicit image fallbacks reachable when models allowlist is present", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          imageModel: {
            primary: "openai/gpt-image-1",
            fallbacks: ["google/gemini-2.5-flash-image-preview"],
          },
          models: {
            "openai/gpt-image-1": {},
          },
        },
      },
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce("ok");

    const result = await runWithImageModelFallback({
      cfg,
      run,
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toEqual([
      ["openai", "gpt-image-1"],
      ["google", "gemini-2.5-flash-image-preview"],
    ]);
  });
});

describe("isAnthropicBillingError", () => {
  it("does not false-positive on plain 'a 402' prose", () => {
    const samples = [
      "Use a 402 stainless bolt",
      "Book a 402 room",
      "There is a 402 near me",
      "The building at 402 Main Street",
    ];

    for (const sample of samples) {
      expect(isAnthropicBillingError(sample)).toBe(false);
    }
  });

  it("matches real 402 billing payload contexts including JSON keys", () => {
    const samples = [
      "HTTP 402 Payment Required",
      "status: 402",
      "error code 402",
      '{"status":402,"type":"error"}',
      '{"code":402,"message":"payment required"}',
      '{"error":{"code":402,"message":"billing hard limit reached"}}',
      "got a 402 from the API",
      "returned 402",
      "received a 402 response",
    ];

    for (const sample of samples) {
      expect(isAnthropicBillingError(sample)).toBe(true);
    }
  });
});
