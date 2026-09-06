import crypto from "node:crypto";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
// Covers model fallback ordering, error classification, and auth cooldown behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptNotContinuableError } from "../../packages/agent-core/src/errors.js";
import type { OpenClawConfig } from "../config/config.js";
import { createAgentRunStaleLifecycleError } from "../infra/agent-lifecycle-error.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { GatewayDrainingError } from "../process/gateway-work-admission.js";
import { AgentRunTerminalOutcomeError } from "./agent-run-terminal-error.js";
import { resolveEffectiveModelFallbacks } from "./agent-scope.js";
import { AUTH_STORE_VERSION, MINIMAX_CLI_PROFILE_ID } from "./auth-profiles/constants.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import { createCliTimeoutError } from "./cli-runner/no-output-timeout-policy.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./embedded-agent-runner/result-fallback-classifier.js";
import { abortable } from "./embedded-agent-runner/run/abortable.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { FailoverError } from "./failover-error.js";
import { resetFallbackSkipCacheForTest } from "./fallback-skip-cache.test-support.js";
import {
  AgentHarnessPreflightError,
  AgentHarnessSessionSupersededError,
  MissingAgentHarnessError,
  recordAgentHarnessPreflightOwner,
} from "./harness/errors.js";
import { clearAgentHarnesses, registerAgentHarness } from "./harness/registry.js";
import type { AgentHarness } from "./harness/types.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
import { isFallbackSummaryError } from "./model-fallback-attempt.js";
import { resolveModelCandidateChain } from "./model-fallback-candidates.js";
import { runWithImageModelFallback } from "./model-fallback-image.js";
import { runWithModelFallback as runWithModelFallbackBase } from "./model-fallback-runner.js";
import { shouldDiscardDeferredSessionSuspension } from "./model-fallback.test-support.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
  resolveAgentRunErrorLifecycleFields,
} from "./run-termination.js";
import { toSandboxProvisioningError } from "./sandbox/provisioning-error.js";
import { resolveSessionSuspensionReason } from "./session-suspension.js";
import { makeModelFallbackCfg } from "./test-helpers/model-fallback-config-fixture.js";

const emptyManifestPlugins = [] as const;

function resolveFallbackCandidateRoutes(params: Parameters<typeof resolveModelCandidateChain>[0]) {
  return resolveModelCandidateChain({ manifestPlugins: emptyManifestPlugins, ...params });
}

function resolveFallbackCandidateRefs(params: Parameters<typeof resolveModelCandidateChain>[0]) {
  return resolveFallbackCandidateRoutes(params).map(({ provider, model }) => ({ provider, model }));
}

const testing = {
  resolveFallbackCandidates: resolveFallbackCandidateRefs,
  resolveFallbackCandidateRoutes,
  resolveSessionSuspensionReason,
  shouldDiscardDeferredSessionSuspension,
};

type ProviderModelNormalizationParams = { provider: string; context: { modelId: string } };

function makeCommandLaneTaskTimeoutError(lane: string, timeoutMs: number): Error {
  const error = new Error(`Command lane "${lane}" task timed out after ${timeoutMs}ms`);
  error.name = "CommandLaneTaskTimeoutError";
  return error;
}

vi.mock("../infra/file-lock.js", () => ({
  withFileLock: async <T>(_filePath: string, _options: unknown, run: () => Promise<T>) => run(),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
}));

const providerModelNormalizationMock = vi.hoisted(() => ({
  normalizeProviderModelIdWithRuntime: vi.fn(
    (_params: ProviderModelNormalizationParams) => undefined,
  ),
}));

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime:
    providerModelNormalizationMock.normalizeProviderModelIdWithRuntime,
}));

const authSourceCheckMock = vi.hoisted(() => ({
  hasAnyAuthProfileStoreSource: vi.fn(() => false),
}));

vi.mock("./auth-profiles/source-check.js", () => authSourceCheckMock);

const authRuntimeMock = vi.hoisted(() => {
  // In-memory auth runtime mirrors cooldown/disabled semantics without writing
  // real profile stores during fallback unit tests.
  const stores = new Map<string, AuthProfileStore>();
  const keyFor = (agentDir?: string) => agentDir ?? "__main__";
  const now = () => Date.now();
  const isActive = (value: unknown, ts = now()) =>
    typeof value === "number" && Number.isFinite(value) && value > ts;
  const getStore = (agentDir?: string): AuthProfileStore =>
    stores.get(keyFor(agentDir)) ?? { version: 1, profiles: {} };
  const getProfileIds = (store: AuthProfileStore, provider: string) =>
    Object.entries(store.profiles)
      .filter(([, profile]) => profile.provider === provider)
      .map(([id]) => id);
  const resolveAuthProfileEligibility = (params: {
    store: AuthProfileStore;
    provider: string;
    profileId: string;
  }) => {
    const credential = params.store.profiles[params.profileId];
    if (!credential) {
      return { eligible: false, reasonCode: "profile_missing" as const };
    }
    if (credential.provider !== params.provider) {
      return { eligible: false, reasonCode: "provider_mismatch" as const };
    }
    if (credential.type === "api_key") {
      return credential.key || credential.keyRef
        ? { eligible: true, reasonCode: "ok" as const }
        : { eligible: false, reasonCode: "missing_credential" as const };
    }
    if (credential.type === "token") {
      if (!credential.token && !credential.tokenRef) {
        return { eligible: false, reasonCode: "missing_credential" as const };
      }
      if (credential.expires !== undefined && credential.expires <= now()) {
        return { eligible: false, reasonCode: "expired" as const };
      }
      return { eligible: true, reasonCode: "ok" as const };
    }
    return credential.access || credential.refresh
      ? { eligible: true, reasonCode: "ok" as const }
      : { eligible: false, reasonCode: "missing_credential" as const };
  };
  const isProfileInCooldown = (
    store: AuthProfileStore,
    profileId: string,
    tsOrOptions?: number | { now?: number; forModel?: string },
    forModel?: string,
  ) => {
    const stats = store.usageStats?.[profileId];
    if (!stats || store.profiles[profileId]?.provider === "openrouter") {
      return false;
    }
    const ts = typeof tsOrOptions === "number" ? tsOrOptions : (tsOrOptions?.now ?? now());
    const model = typeof tsOrOptions === "object" ? tsOrOptions.forModel : forModel;
    if (isActive(stats.disabledUntil, ts)) {
      return true;
    }
    if (!isActive(stats.cooldownUntil, ts)) {
      return false;
    }
    return !stats.cooldownModel || !model || stats.cooldownModel === model;
  };
  const resolveReason = (store: AuthProfileStore, profileIds: string[], ts = now()) => {
    for (const profileId of profileIds) {
      const stats = store.usageStats?.[profileId];
      if (!stats) {
        continue;
      }
      if (isActive(stats.disabledUntil, ts)) {
        return stats.disabledReason ?? "auth";
      }
      if (!isActive(stats.cooldownUntil, ts)) {
        continue;
      }
      if (stats.cooldownReason) {
        return stats.cooldownReason;
      }
      const counts = stats.failureCounts ?? {};
      if ((counts.rate_limit ?? 0) > 0) {
        return "rate_limit";
      }
      if ((counts.overloaded ?? 0) > 0) {
        return "overloaded";
      }
      if ((counts.timeout ?? 0) > 0) {
        return "timeout";
      }
      return "unknown";
    }
    return null;
  };
  return {
    clear: () => stores.clear(),
    setStore: (agentDir: string | undefined, store: AuthProfileStore) => {
      stores.set(keyFor(agentDir), store);
    },
    runtime: {
      ensureAuthProfileStore: vi.fn((agentDir?: string, _options?: unknown) => getStore(agentDir)),
      loadAuthProfileStoreForRuntime: vi.fn((agentDir?: string) => getStore(agentDir)),
      resolveAuthProfileOrder: (params: { store: AuthProfileStore; provider: string }) =>
        params.store.order?.[params.provider] ?? getProfileIds(params.store, params.provider),
      resolveAuthProfileEligibility,
      maybeReprobeWhamBlockedProfiles: vi.fn(),
      isProfileInCooldown,
      resolveProfilesUnavailableReason: (params: {
        store: AuthProfileStore;
        profileIds: string[];
        now?: number;
      }) => resolveReason(params.store, params.profileIds, params.now),
      getSoonestCooldownExpiry: (
        store: AuthProfileStore,
        profileIds: string[],
        options?: { now?: number; forModel?: string },
      ) => {
        const ts = options?.now ?? now();
        let soonest: number | null = null;
        for (const profileId of profileIds) {
          if (!isProfileInCooldown(store, profileId, { now: ts, forModel: options?.forModel })) {
            continue;
          }
          const stats = store.usageStats?.[profileId];
          const cooldownUntil = stats?.cooldownUntil;
          const disabledUntil = stats?.disabledUntil;
          let expiry: number | undefined;
          if (isActive(cooldownUntil, ts)) {
            expiry = cooldownUntil;
          }
          if (
            disabledUntil !== undefined &&
            isActive(disabledUntil, ts) &&
            (expiry === undefined || disabledUntil < expiry)
          ) {
            expiry = disabledUntil;
          }
          if (expiry !== undefined && (soonest === null || expiry < soonest)) {
            soonest = expiry;
          }
        }
        return soonest;
      },
    },
  };
});

vi.mock("./auth-profiles.runtime.js", () => authRuntimeMock.runtime);

const makeCfg = makeModelFallbackCfg;
let authTempRoot = "";
let authTempCounter = 0;

function registerFallbackHarness(id: string): void {
  registerAgentHarness(
    {
      id,
      label: id,
      supports: () => ({ supported: true }),
      runAttempt: vi.fn<AgentHarness["runAttempt"]>(async () => {
        throw new Error("fallback test should not invoke the registered harness directly");
      }),
    },
    { ownerPluginId: `${id}-test` },
  );
}

function createHarnessScopedPreflightError(harnessId: string): AgentHarnessPreflightError {
  const error = new AgentHarnessPreflightError("Codex approvals denied execution", {
    scope: "harness",
  });
  recordAgentHarnessPreflightOwner(error, harnessId);
  return error;
}

const runWithModelFallback: typeof runWithModelFallbackBase = (params) =>
  runWithModelFallbackBase({ manifestPlugins: emptyManifestPlugins, ...params });

function resetModelFallbackTestState(): void {
  // Fallback state has process-level caches for skip markers, harnesses, auth,
  // and plugin normalization. Reset every surface between tests.
  resetFallbackSkipCacheForTest();
  clearAgentHarnesses();
  authRuntimeMock.clear();
  authRuntimeMock.runtime.ensureAuthProfileStore.mockClear();
  authRuntimeMock.runtime.loadAuthProfileStoreForRuntime.mockClear();
  authSourceCheckMock.hasAnyAuthProfileStoreSource.mockReset().mockReturnValue(false);
  providerModelNormalizationMock.normalizeProviderModelIdWithRuntime
    .mockReset()
    .mockReturnValue(undefined);
  resetDiagnosticEventsForTest();
}

afterEach(() => {
  resetModelFallbackTestState();
  cliBackendsTesting.resetDepsForTest();
});

beforeEach(() => {
  setLoggerOverride({ level: "silent", consoleLevel: "silent" });
});

afterEach(() => {
  setLoggerOverride(null);
  resetLogger();
});

async function runModelFallbackCase(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    throw new Error(`case failed: ${name}`, { cause: err });
  } finally {
    resetModelFallbackTestState();
  }
}

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

function makeProviderOrderFallbackCfg(
  entries: Array<[provider: string, model: string]>,
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          fallbacks: [],
        },
      },
    },
    models: {
      providers: Object.fromEntries(
        entries.map(([provider, model]) => [
          provider,
          {
            baseUrl: `https://${provider}.example.test`,
            models: [{ id: model }],
          },
        ]),
      ),
    },
  } as unknown as OpenClawConfig;
}

async function withTempAuthStore<T>(
  store: AuthProfileStore,
  run: (tempDir: string) => Promise<T>,
): Promise<T> {
  const tempDir = await makeAuthTempDir();
  setAuthRuntimeStore(tempDir, store);
  return await run(tempDir);
}

async function makeAuthTempDir(): Promise<string> {
  authTempRoot ||= path.join("/tmp", "openclaw-auth-suite-mock");
  return path.join(authTempRoot, `case-${++authTempCounter}`);
}

async function runWithStoredAuth(params: {
  cfg: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  run: (provider: string, model: string) => Promise<string>;
  userLockedAuthProfileId?: string;
}) {
  const tempDir = await makeAuthTempDir();
  setAuthRuntimeStore(tempDir, params.store);
  return await runWithModelFallback({
    cfg: params.cfg,
    provider: params.provider,
    model: "m1",
    agentDir: tempDir,
    run: params.run,
    userLockedAuthProfileId: params.userLockedAuthProfileId,
  });
}

function setAuthRuntimeStore(agentDir: string | undefined, store: AuthProfileStore): void {
  authSourceCheckMock.hasAnyAuthProfileStoreSource.mockReturnValue(true);
  authRuntimeMock.setStore(agentDir, store);
}

const requireRecord = createRequireRecord("record", "expected-label");

function requireMockCall(
  mock: { mock: { calls: unknown[][] } },
  index: number,
  label: string,
): unknown[] {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected ${label} mock call ${index}`);
  }
  return call;
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

function requireFallbackSummaryError(error: unknown) {
  expect(isFallbackSummaryError(error)).toBe(true);
  if (!isFallbackSummaryError(error)) {
    throw error;
  }
  return error;
}

function requireFailoverError(error: unknown): FailoverError {
  expect(error).toBeInstanceOf(FailoverError);
  if (!(error instanceof FailoverError)) {
    throw error;
  }
  return error;
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
  expect(requireMockCall(run, 1, "fallback run")).toMatchObject([
    "anthropic",
    "claude-haiku-3-5",
    { isFinalFallbackAttempt: true },
  ]);
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
  credentialType?: "api_key" | "oauth" | "token";
}): AuthProfileStore {
  const profileId = `${params.provider}:default`;
  return {
    version: AUTH_STORE_VERSION,
    profiles: {
      [profileId]:
        params.credentialType === "oauth"
          ? {
              type: "oauth",
              provider: params.provider,
              access: "test-access",
              refresh: "test-refresh",
              expires: Date.now() + 60_000,
            }
          : params.credentialType === "token"
            ? {
                type: "token",
                provider: params.provider,
                token: "test-token",
              }
            : {
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
  credentialType?: "api_key" | "oauth" | "token";
  expectedAuthMode?: "oauth" | "token";
}) {
  const provider = `${params.providerPrefix}-${crypto.randomUUID()}`;
  const cfg = makeProviderFallbackCfg(provider);
  const primaryStore = makeSingleProviderStore({
    provider,
    usageStat: params.usageStat,
    credentialType: params.credentialType,
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
  expect(run.mock.calls).toMatchObject([
    ["fallback", "ok-model", { isFinalFallbackAttempt: true }],
  ]);
  expect(result.attempts[0]?.reason).toBe(params.expectedReason);
  expect(result.attempts[0]?.authMode).toBe(params.expectedAuthMode);
}

// Issue-backed Anthropic/OpenAI-compatible insufficient_quota payload under HTTP 400:
// https://github.com/openclaw/openclaw/issues/23440
const INSUFFICIENT_QUOTA_PAYLOAD =
  '{"type":"error","error":{"type":"insufficient_quota","message":"Your account has insufficient quota balance to run this request."}}';

type ModelFailoverDiagnostic = Extract<DiagnosticEventPayload, { type: "model.failover" }>;

function captureModelFailoverDiagnostics(): {
  events: ModelFailoverDiagnostic[];
  stop: () => void;
} {
  const events: ModelFailoverDiagnostic[] = [];
  const stop = onTrustedInternalDiagnosticEvent((event) => {
    if (event.type === "model.failover") {
      events.push(event);
    }
  });
  return { events, stop };
}

function makeDiagnosticFallbackConfig(fallbacks: string[]): OpenClawConfig {
  return makeCfg({
    agents: { defaults: { model: { primary: "openai/gpt-5.5", fallbacks } } },
  });
}

function diagnosticFailure(params: {
  provider: string;
  model: string;
  reason: "rate_limit" | "overloaded";
}): FailoverError {
  return new FailoverError(params.reason, params);
}

const DIAGNOSTIC_CASES = [
  {
    name: "emits one diagnostic for each model fallback transition",
    refs: ["openai/gpt-5.5", "anthropic/claude-opus-4-6", "google/gemini-3.1-pro-preview"],
    reasons: ["rate_limit", "overloaded"],
    expectError: false,
  },
  {
    name: "does not emit a failover diagnostic without a next candidate",
    refs: ["openai/gpt-5.5"],
    reasons: [],
    expectError: false,
  },
  {
    name: "does not emit an extra diagnostic for an exhausted fallback",
    refs: ["openai/gpt-5.5", "anthropic/claude-opus-4-6"],
    reasons: ["rate_limit", "overloaded"],
    expectError: true,
  },
] as const satisfies ReadonlyArray<{
  name: string;
  refs: readonly string[];
  reasons: readonly ("rate_limit" | "overloaded")[];
  expectError: boolean;
}>;

function parseDiagnosticModelRef(ref: string): { provider: string; model: string } {
  const separator = ref.indexOf("/");
  return { provider: ref.slice(0, separator), model: ref.slice(separator + 1) };
}

describe("runWithModelFallback", () => {
  it.each(DIAGNOSTIC_CASES)("$name", async ({ refs, reasons, expectError }) => {
    const candidates = refs.map(parseDiagnosticModelRef);
    const diagnostics = captureModelFailoverDiagnostics();
    const run = vi.fn();
    reasons.forEach((reason, index) => {
      run.mockRejectedValueOnce(diagnosticFailure({ ...candidates[index]!, reason }));
    });
    if (!expectError) {
      run.mockResolvedValueOnce("ok");
    }
    let result: unknown;
    let thrown: unknown;

    try {
      result = (
        await runWithModelFallback({
          cfg: makeDiagnosticFallbackConfig(refs.slice(1)),
          ...candidates[0]!,
          sessionId: "session:failover-diagnostics",
          sessionKey: "agent:test:failover-diagnostics",
          lane: "main",
          run,
        })
      ).result;
    } catch (error) {
      thrown = error;
    } finally {
      diagnostics.stop();
    }

    const expectedEvents = reasons.flatMap((reason, index) => {
      const from = candidates[index]!;
      const to = candidates[index + 1];
      return to
        ? [
            {
              sessionId: "session:failover-diagnostics",
              sessionKey: "agent:test:failover-diagnostics",
              lane: "main",
              fromProvider: from.provider,
              fromModel: from.model,
              toProvider: to.provider,
              toModel: to.model,
              reason,
              cascadeDepth: index,
              suspended: false,
            },
          ]
        : [];
    });
    expect(result).toBe(expectError ? undefined : "ok");
    expect(isFallbackSummaryError(thrown)).toBe(expectError);
    expect(diagnostics.events).toMatchObject(expectedEvents);
  });

  it("does not replay a thrown attempt after the caller reports a committed side effect", async () => {
    const failure = new FailoverError("primary failed after tool start", {
      provider: "openai",
      model: "gpt-5.4",
      reason: "overloaded",
    });
    const run = vi.fn().mockRejectedValue(failure);
    const canFallbackAfterError = vi.fn().mockReturnValue(false);

    await expect(
      runWithModelFallback({
        cfg: makeDiagnosticFallbackConfig(["anthropic/claude-opus-4-7"]),
        provider: "openai",
        model: "gpt-5.4",
        run,
        canFallbackAfterError,
      }),
    ).rejects.toBe(failure);

    expect(run).toHaveBeenCalledTimes(1);
    expect(canFallbackAfterError).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.4",
        error: failure,
      }),
    );
  });

  it("skips same-provider candidates after a TLS certificate failure", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        new FailoverError("Hostname/IP does not match certificate's altnames", {
          provider: "openai",
          model: "gpt-5.5",
          reason: "tls_certificate",
          code: "ERR_TLS_CERT_ALTNAME_INVALID",
        }),
      )
      .mockResolvedValueOnce("anthropic success");

    const result = await runWithModelFallback({
      cfg: makeDiagnosticFallbackConfig(["openai/gpt-5.5-mini", "anthropic/claude-opus-4-6"]),
      provider: "openai",
      model: "gpt-5.5",
      run,
    });

    expect(result.result).toBe("anthropic success");
    expect(run.mock.calls).toMatchObject([
      ["openai", "gpt-5.5", { isFinalFallbackAttempt: false }],
      ["anthropic", "claude-opus-4-6", { isFinalFallbackAttempt: true }],
    ]);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.reason).toBe("tls_certificate");
  });

  it("keeps TLS-failed providers excluded across interleaved fallbacks", async () => {
    const diagnostics = captureModelFailoverDiagnostics();
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        new FailoverError("Hostname/IP does not match certificate's altnames", {
          provider: "openai",
          model: "gpt-5.5",
          reason: "tls_certificate",
          code: "ERR_TLS_CERT_ALTNAME_INVALID",
        }),
      )
      .mockRejectedValueOnce(
        new FailoverError("overloaded", {
          provider: "anthropic",
          model: "claude-opus-4-6",
          reason: "overloaded",
        }),
      )
      .mockResolvedValueOnce("must not run");
    let thrown: unknown;

    try {
      await runWithModelFallback({
        cfg: makeDiagnosticFallbackConfig(["anthropic/claude-opus-4-6", "openai/gpt-5.5-mini"]),
        provider: "openai",
        model: "gpt-5.5",
        sessionId: "session:tls-provider-exclusion",
        sessionKey: "agent:test:tls-provider-exclusion",
        lane: "main",
        run,
      });
    } catch (error) {
      thrown = error;
    } finally {
      diagnostics.stop();
    }

    expect(isFallbackSummaryError(thrown)).toBe(true);
    expect(run.mock.calls).toMatchObject([
      ["openai", "gpt-5.5", { isFinalFallbackAttempt: false }],
      ["anthropic", "claude-opus-4-6", { isFinalFallbackAttempt: true }],
    ]);
    expect(diagnostics.events).toHaveLength(1);
    expect(diagnostics.events).toMatchObject([
      {
        fromProvider: "openai",
        fromModel: "gpt-5.5",
        toProvider: "anthropic",
        toModel: "claude-opus-4-6",
        reason: "tls_certificate",
      },
    ]);
  });

  it("preserves selected-profile identity in exhausted fallback summaries", async () => {
    const code = "selected_auth_profile_unavailable";
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        new FailoverError("primary selected profile missing", {
          provider: "openai",
          model: "gpt-5.5",
          reason: "auth",
          status: 401,
          code,
        }),
      )
      .mockRejectedValueOnce(
        new FailoverError("fallback selected profile missing", {
          provider: "anthropic",
          model: "claude-opus-4-6",
          reason: "auth",
          status: 401,
          code,
        }),
      );

    const error = requireFallbackSummaryError(
      await captureRejection(
        runWithModelFallback({
          cfg: makeDiagnosticFallbackConfig(["anthropic/claude-opus-4-6"]),
          provider: "openai",
          model: "gpt-5.5",
          run,
        }),
      ),
    );

    expect(error).toMatchObject({ reason: "auth", status: 401, code });
    expect(error.attempts).toMatchObject([{ code }, { code }]);
  });

  it("uses the opt-in auth skip cache on the second turn for the same session", async () => {
    const previous = process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS;
    process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS = "60000";
    try {
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4",
              fallbacks: ["anthropic/claude-opus-4-7", "google/gemini-3.1-pro-preview"],
            },
          },
        },
      });
      const run = vi.fn(async (provider: string, model: string) => {
        if (provider === "openai") {
          throw new FailoverError("primary rate limited", {
            provider,
            model,
            reason: "rate_limit",
          });
        }
        if (provider === "anthropic") {
          throw new FailoverError("fallback auth failed", {
            provider,
            model,
            reason: "auth",
          });
        }
        return "ok";
      });

      const first = await runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-5.4",
        sessionId: "session:auth-skip",
        run,
      });
      const second = await runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-5.4",
        sessionId: "session:auth-skip",
        run,
      });

      expect(first.result).toBe("ok");
      expect(second.result).toBe("ok");
      expect(run.mock.calls.map(([provider, model]) => `${provider}/${model}`)).toEqual([
        "openai/gpt-5.4",
        "anthropic/claude-opus-4-7",
        "google/gemini-3.1-pro-preview",
        "openai/gpt-5.4",
        "google/gemini-3.1-pro-preview",
      ]);
      expect(second.attempts.some((attempt) => attempt.provider === "anthropic")).toBe(true);
      expect(second.attempts.find((attempt) => attempt.provider === "anthropic")?.error).toContain(
        "recent auth failure",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS;
      } else {
        process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS = previous;
      }
    }
  });

  it.each([
    ["provider-owned auth", false],
    ["harness-owned auth", true],
  ])(
    "scopes auth skip markers to the explicit profile for %s",
    async (_label, harnessOwnedAuth) => {
      const previous = process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS;
      process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS = "60000";
      try {
        const provider = `scoped-auth-skip-${crypto.randomUUID()}`;
        if (harnessOwnedAuth) {
          registerFallbackHarness("codex");
        }
        const profileA = `${provider}:a`;
        const profileB = `${provider}:b`;
        const cfg = makeCfg({
          agents: {
            defaults: {
              model: {
                primary: "openai/m1",
                fallbacks: [`${provider}/m1`, "fallback/ok-model"],
              },
            },
          },
        });
        const store: AuthProfileStore = {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileA]: { type: "api_key", provider, key: "key-a" },
            [profileB]: { type: "api_key", provider, key: "key-b" },
          },
        };
        const agentDir = await makeAuthTempDir();
        setAuthRuntimeStore(agentDir, store);
        const run = vi.fn(async (candidateProvider: string, model: string) => {
          if (candidateProvider === "openai") {
            throw new FailoverError("primary rate limited", {
              provider: candidateProvider,
              model,
              reason: "rate_limit",
            });
          }
          if (candidateProvider === provider) {
            throw new FailoverError("explicit profile failed", {
              provider: candidateProvider,
              model,
              reason: "auth",
            });
          }
          return "ok";
        });
        const execute = (userLockedAuthProfileId: string) =>
          runWithModelFallback({
            cfg,
            provider: "openai",
            model: "m1",
            sessionId: "session:scoped-auth-skip",
            agentDir,
            userLockedAuthProfileId,
            resolveAgentHarnessRuntimeOverride: (candidateProvider) =>
              harnessOwnedAuth && candidateProvider === provider ? "codex" : undefined,
            run,
          });

        await execute(profileA);
        await execute(profileB);
        const third = await execute(profileB);

        expect(third.result).toBe("ok");
        expect(run.mock.calls.map(([candidateProvider]) => candidateProvider)).toEqual([
          "openai",
          provider,
          "fallback",
          "openai",
          provider,
          "fallback",
          "openai",
          "fallback",
        ]);
        expect(third.attempts.find((attempt) => attempt.provider === provider)?.error).toContain(
          "recent auth failure",
        );
      } finally {
        if (previous === undefined) {
          delete process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS;
        } else {
          process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS = previous;
        }
      }
    },
  );

  it("scopes automatic auth skips to the selected profile", async () => {
    const previous = process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS;
    process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS = "60000";
    try {
      const provider = `automatic-auth-skip-${crypto.randomUUID()}`;
      const lockedProfile = "openai:locked";
      const profileA = `${provider}:a`;
      const profileB = `${provider}:b`;
      let selectedProfile = profileA;
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              primary: "openai/m1",
              fallbacks: [`${provider}/m1`, "fallback/ok-model"],
            },
          },
        },
      });
      const store: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          [lockedProfile]: { type: "api_key", provider: "openai", key: "key-locked" },
          [profileA]: { type: "api_key", provider, key: "key-a" },
          [profileB]: { type: "api_key", provider, key: "key-b" },
        },
        order: { [provider]: [profileA, profileB] },
      };
      const agentDir = await makeAuthTempDir();
      setAuthRuntimeStore(agentDir, store);
      const run = vi.fn(async (candidateProvider: string, model: string) => {
        if (candidateProvider === "openai") {
          throw new FailoverError("primary rate limited", {
            provider: candidateProvider,
            model,
            reason: "rate_limit",
          });
        }
        if (candidateProvider === provider) {
          throw new FailoverError("automatic profile failed", {
            provider: candidateProvider,
            model,
            reason: "auth",
            profileId: selectedProfile,
          });
        }
        return "ok";
      });
      const execute = () =>
        runWithModelFallback({
          cfg,
          provider: "openai",
          model: "m1",
          sessionId: "session:pooled-auth-skip",
          agentDir,
          userLockedAuthProfileId: lockedProfile,
          run,
        });

      await execute();
      selectedProfile = profileB;
      store.order = { [provider]: [profileB, profileA] };
      await execute();
      const third = await execute();

      expect(third.result).toBe("ok");
      expect(run.mock.calls.map(([candidateProvider]) => candidateProvider)).toEqual([
        "openai",
        provider,
        "fallback",
        "openai",
        provider,
        "fallback",
        "openai",
        "fallback",
      ]);
      expect(third.attempts.find((attempt) => attempt.provider === provider)?.error).toContain(
        "recent auth failure",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS;
      } else {
        process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS = previous;
      }
    }
  });

  it("skips auth store bootstrap when no auth profile sources exist", async () => {
    authSourceCheckMock.hasAnyAuthProfileStoreSource.mockReturnValue(false);
    const run = vi.fn().mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg: makeCfg(),
      provider: "openai",
      model: "gpt-4.1-mini",
      agentDir: "/tmp/openclaw-no-auth-profiles",
      run,
    });

    expect(result.result).toBe("ok");
    expect(authSourceCheckMock.hasAnyAuthProfileStoreSource).toHaveBeenCalledWith(
      "/tmp/openclaw-no-auth-profiles",
    );
    expect(authRuntimeMock.runtime.ensureAuthProfileStore).not.toHaveBeenCalled();
    expect(requireMockCall(run, 0, "model run")).toMatchObject([
      "openai",
      "gpt-4.1-mini",
      { isFinalFallbackAttempt: false },
    ]);
  });

  it("preserves prepared primary model routes before running", () => {
    const cases = [
      {
        name: "keeps openai gpt-5.4 on provider",
        cfg: makeCfg(),
        provider: "openai",
        model: "gpt-5.4",
        expected: ["openai", "gpt-5.4"],
      },
      {
        name: "resolves a raw bare alias",
        cfg: makeCfg({
          agents: {
            defaults: {
              model: {
                primary: "anthropic/claude-sonnet-4-6",
                fallbacks: [],
              },
              models: {
                "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
              },
            },
          },
        }),
        provider: "anthropic",
        model: "sonnet",
        expected: ["anthropic", "claude-sonnet-4-6"],
      },
      {
        name: "resolves a raw slash-form alias before provider parsing",
        cfg: makeCfg({
          agents: {
            defaults: {
              model: {
                primary: "openai/xiaomi/mimo-v2-pro-mit",
                fallbacks: [],
              },
              models: {
                "openai/xiaomi/mimo-v2-pro-mit": { alias: "xiaomi/mimo-v2-pro-mit" },
              },
            },
          },
        }),
        provider: "xiaomi",
        model: "mimo-v2-pro-mit",
        expected: ["openai", "xiaomi/mimo-v2-pro-mit"],
      },
      {
        name: "keeps explicit provider when a different provider owns the bare alias",
        cfg: makeCfg({
          agents: {
            defaults: {
              model: {
                primary: "openrouter/deepseek/deepseek-v4-pro",
                fallbacks: [],
              },
              models: {
                "openrouter/deepseek/deepseek-v4-pro": { alias: "deepseek-v4-pro" },
                "opencode-go/deepseek-v4-pro": { alias: "OpenCode Go DeepSeek V4 Pro" },
              },
            },
          },
        }),
        provider: "opencode-go",
        model: "deepseek-v4-pro",
        expected: ["opencode-go", "deepseek-v4-pro"],
      },
      {
        name: "keeps a custom default-provider route when another provider owns the bare alias",
        cfg: {
          ...makeProviderOrderFallbackCfg([["cloudflare-ai-gateway", "gemini-2.5-flash-lite"]]),
          agents: {
            defaults: {
              model: {
                primary: "cloudflare-ai-gateway/gemini-3.1-flash-lite",
                fallbacks: [],
              },
              models: {
                "cloudflare-ai-gateway/gemini-2.5-flash-lite": {
                  alias: "cf-gemini-2.5-flash-lite",
                },
                "google/gemini-2.5-flash-lite": { alias: "gemini-2.5-flash-lite" },
              },
            },
          },
        },
        provider: "cloudflare-ai-gateway",
        model: "gemini-2.5-flash-lite",
        requestedRouteResolution: "resolved",
        expected: ["cloudflare-ai-gateway", "gemini-2.5-flash-lite"],
      },
      {
        name: "keeps a built-in default-provider route when another provider owns the bare alias",
        cfg: makeCfg({
          agents: {
            defaults: {
              model: {
                primary: "google/gemini-3.1-pro-preview",
                fallbacks: [],
              },
              models: {
                "google/gemini-2.5-flash-lite": { alias: "google-flash-lite" },
                "openrouter/google/gemini-2.5-flash-lite": {
                  alias: "gemini-2.5-flash-lite",
                },
              },
            },
          },
        }),
        provider: "google",
        model: "gemini-2.5-flash-lite",
        requestedRouteResolution: "resolved",
        expected: ["google", "gemini-2.5-flash-lite"],
      },
    ] satisfies Array<{
      name: string;
      cfg: OpenClawConfig;
      provider: string;
      model: string;
      requestedRouteResolution?: "raw" | "resolved";
      expected: [string, string];
    }>;

    for (const testCase of cases) {
      const candidates = testing.resolveFallbackCandidates({
        cfg: testCase.cfg,
        provider: testCase.provider,
        model: testCase.model,
        requestedRouteResolution: testCase.requestedRouteResolution,
      });

      expect(candidates[0], testCase.name).toEqual({
        provider: testCase.expected[0],
        model: testCase.expected[1],
      });
    }
  });

  it("carries the route origin for every fallback candidate", () => {
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

    expect(
      testing.resolveFallbackCandidateRoutes({
        cfg,
        provider: "google",
        model: "gemini-2.5-flash-lite",
      }),
    ).toEqual([
      {
        provider: "google",
        model: "gemini-2.5-flash-lite",
        routeOrigin: "requested",
        routeResolution: "raw",
      },
      {
        provider: "anthropic",
        model: "claude-haiku-3-5",
        routeOrigin: "configured-fallback",
        routeResolution: "resolved",
      },
      {
        provider: "openai",
        model: "gpt-4.1-mini",
        routeOrigin: "configured-primary",
        routeResolution: "resolved",
      },
    ]);
  });

  it("keeps an unmarked canonical built-in route ahead of a colliding alias", () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: { primary: "google/gemini-3.1-pro-preview", fallbacks: [] },
          models: {
            "google/gemini-2.5-flash-lite": { alias: "google-flash-lite" },
            "openrouter/google/gemini-2.5-flash-lite": {
              alias: "gemini-2.5-flash-lite",
            },
          },
        },
      },
    });

    expect(
      testing.resolveFallbackCandidates({
        cfg,
        provider: "google",
        model: "gemini-2.5-flash-lite",
      })[0],
    ).toEqual({ provider: "google", model: "gemini-2.5-flash-lite" });
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
    expect(expectDefined(result.attempts[0], "result.attempts[0] test invariant").error).toBe(
      "bad request",
    );
    expect(expectDefined(result.attempts[0], "result.attempts[0] test invariant").reason).toBe(
      "unknown",
    );
  });

  // A transport-owning plugin harness disables generic compaction recovery, so a provider
  // request-size ceiling leaves the embedded runner as a FailoverError whose message has already
  // been replaced with context-overflow copy. Only rawError still states the figures, which is why
  // the boundary reads the recorded fact rather than the message. See #130096.
  const GROQ_REQUEST_CEILING_413 =
    "413 Request too large for model `openai/gpt-oss-120b` in organization `org_x` " +
    "service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 8098, " +
    "please reduce your message size and try again.";

  function makeNormalizedOverflowFailover(rawError?: string) {
    return new FailoverError(
      "Context overflow: prompt too large for the model. " +
        "Try /reset (or /new) to start a fresh session, or use a larger-context model.",
      { reason: "context_overflow", provider: "groq", model: "openai/gpt-oss-120b", rawError },
    );
  }

  it("keeps configured fallback running when the provider states a request-size ceiling", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(makeNormalizedOverflowFailover(GROQ_REQUEST_CEILING_413))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    // The ceiling belongs to the refusing provider's quota, not to any model's context window,
    // so a differently provisioned candidate is exactly what may still admit the request.
    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("still rethrows a context overflow that no request-size ceiling explains", async () => {
    const cfg = makeCfg();
    const overflow = makeNormalizedOverflowFailover("400 input is too long for the model");
    const run = vi.fn().mockRejectedValue(overflow);

    // Ordinary overflow stays the inner runner's to compact and retry; rotating to a model with a
    // smaller window would fail worse. This pins that contract against the exception above.
    await expect(
      runWithModelFallback({ cfg, provider: "openai", model: "gpt-4.1-mini", run }),
    ).rejects.toBe(overflow);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not treat Codex missing tool-result failures as model fallback candidates", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
      },
    });
    const missingToolResultError = new Error(
      "OpenClaw recorded a native Codex tool.call without a matching tool.result before the turn completed.",
    );
    const run = vi.fn().mockRejectedValue(missingToolResultError);

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-5.4",
        run,
      }),
    ).rejects.toBe(missingToolResultError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("still falls back on unstructured provider text that merely mentions missing_tool_result", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
      },
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider diagnostic reason=missing_tool_result"))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-5.4",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(requireMockCall(run, 1, "fallback run")).toMatchObject([
      "anthropic",
      "claude-sonnet-4-6",
      { isFinalFallbackAttempt: true },
    ]);
  });

  it("falls back on a Zhipu GLM 1305 overload body and classifies it as overloaded", async () => {
    const cfg = makeCfg();
    const glmOverload = new Error("[1305][该模型当前访问量过大，请您稍后再试]");
    const run = vi.fn().mockRejectedValueOnce(glmOverload).mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "glm",
      model: "GLM-5.2",
      run,
    });
    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(requireMockCall(run, 1, "fallback run")).toMatchObject([
      "anthropic",
      "claude-haiku-3-5",
      { isFinalFallbackAttempt: false },
    ]);
    expect(result.attempts).toHaveLength(1);
    expect(expectDefined(result.attempts[0], "result.attempts[0] test invariant").reason).toBe(
      "overloaded",
    );
  });

  it("does not prepare agent harness plugins for forced OpenClaw candidates", async () => {
    const cfg = makeCfg({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            agentRuntime: { id: "openclaw" },
            models: [],
          },
        },
      },
    });
    const prepareAgentHarnessRuntime = vi.fn(() => {
      throw new Error("OpenClaw candidates should not prepare plugin harnesses");
    });
    const run = vi.fn().mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-5.5",
      prepareAgentHarnessRuntime,
      run,
    });

    expect(result.result).toBe("ok");
    expect(prepareAgentHarnessRuntime).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not prepare agent harness plugins for implicit Codex candidates", async () => {
    const cfg = makeCfg();
    const prepareAgentHarnessRuntime = vi.fn(() => {
      throw new Error("implicit Codex candidates should stay embedded-compatible");
    });
    const run = vi.fn().mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-5.5",
      prepareAgentHarnessRuntime,
      run,
    });

    expect(result.result).toBe("ok");
    expect(prepareAgentHarnessRuntime).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a strict plugin harness is missing", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
      },
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(new MissingAgentHarnessError("codex"))
      .mockResolvedValueOnce("wrong fallback");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-5.5",
        run,
      }),
    ).rejects.toThrow('Requested agent harness "codex" is not registered.');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fails closed before auth cooldown skips when a strict plugin harness is missing", async () => {
    const cfg = makeCfg({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            agentRuntime: { id: "codex" },
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
      },
    });
    const tempDir = await makeAuthTempDir();
    setAuthRuntimeStore(tempDir, {
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "test-key" },
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "test-key" },
      },
      usageStats: {
        "openai:default": {
          cooldownUntil: Date.now() + 60_000,
          cooldownReason: "rate_limit",
          failureCounts: { rate_limit: 1 },
        },
      },
    });
    const run = vi.fn().mockResolvedValueOnce("wrong fallback");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-5.5",
        agentDir: tempDir,
        run,
      }),
    ).rejects.toThrow('Requested agent harness "codex" is not registered.');
    expect(run).not.toHaveBeenCalled();
  });

  it("uses agent runtime context before auth cooldown skips", async () => {
    const cfg = makeCfg({
      agents: {
        list: [
          { id: "main", default: true },
          {
            id: "worker",
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
            },
          },
        ],
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
      },
    });
    const tempDir = await makeAuthTempDir();
    setAuthRuntimeStore(tempDir, {
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "test-key" },
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "test-key" },
      },
      usageStats: {
        "openai:default": {
          cooldownUntil: Date.now() + 60_000,
          cooldownReason: "rate_limit",
          failureCounts: { rate_limit: 1 },
        },
      },
    });
    const run = vi.fn().mockResolvedValueOnce("wrong fallback");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-5.5",
        agentDir: tempDir,
        agentId: "worker",
        run,
      }),
    ).rejects.toThrow('Requested agent harness "codex" is not registered.');
    expect(run).not.toHaveBeenCalled();
  });

  it("uses session runtime overrides before auth cooldown skips", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
      },
    });
    const tempDir = await makeAuthTempDir();
    setAuthRuntimeStore(tempDir, {
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "test-key" },
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "test-key" },
      },
      usageStats: {
        "openai:default": {
          cooldownUntil: Date.now() + 60_000,
          cooldownReason: "rate_limit",
          failureCounts: { rate_limit: 1 },
        },
      },
    });
    const run = vi.fn().mockResolvedValueOnce("wrong fallback");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-5.5",
        agentDir: tempDir,
        resolveAgentHarnessRuntimeOverride: (provider) =>
          provider === "openai" ? "codex" : undefined,
        run,
      }),
    ).rejects.toThrow('Requested agent harness "codex" is not registered.');
    expect(run).not.toHaveBeenCalled();
  });

  it("lets external plugin harnesses bypass stale provider auth cooldowns", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-6",
            fallbacks: ["openai/gpt-5.5"],
          },
          models: {
            "anthropic/*": { agentRuntime: { id: "claude-tmux" } },
          },
        },
      },
    });
    registerAgentHarness(
      {
        id: "claude-tmux",
        label: "Claude tmux",
        supports: ({ provider }) =>
          provider === "anthropic" ? { supported: true } : { supported: false },
        runAttempt: vi.fn<AgentHarness["runAttempt"]>(async () => {
          throw new Error("fallback test should not invoke the harness runtime");
        }),
      },
      { ownerPluginId: "claude-tmux-test" },
    );
    const tempDir = await makeAuthTempDir();
    setAuthRuntimeStore(tempDir, {
      version: AUTH_STORE_VERSION,
      profiles: {
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "test-key" },
        "openai:default": { type: "api_key", provider: "openai", key: "test-key" },
      },
      usageStats: {
        "anthropic:default": {
          disabledUntil: Date.now() + 60_000,
          disabledReason: "billing",
          failureCounts: { rate_limit: 4 },
        },
      },
    });
    const run = vi.fn().mockImplementation(async (provider: string) => {
      if (provider === "anthropic") {
        return "external cli ok";
      }
      throw new Error(`unexpected provider: ${provider}`);
    });

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      agentDir: tempDir,
      run,
    });

    expect(result.result).toBe("external cli ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]).toMatchObject([
      "anthropic",
      "claude-sonnet-4-6",
      { isFinalFallbackAttempt: false },
    ]);
    expect(result.attempts).toStrictEqual([]);
  });

  it("lets a pinned Codex harness bypass unrelated provider auth cooldowns", async () => {
    const cfg = makeCfg();
    registerAgentHarness(
      {
        id: "codex",
        label: "Codex",
        supports: () => ({ supported: true }),
        runAttempt: vi.fn<AgentHarness["runAttempt"]>(async () => {
          throw new Error("fallback test should not invoke the harness runtime");
        }),
      },
      { ownerPluginId: "codex-test" },
    );
    const tempDir = await makeAuthTempDir();
    setAuthRuntimeStore(tempDir, {
      version: AUTH_STORE_VERSION,
      profiles: {
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "test-key" },
      },
      usageStats: {
        "anthropic:default": {
          disabledUntil: Date.now() + 60_000,
          disabledReason: "billing",
          failureCounts: { billing: 1 },
        },
      },
    });
    const run = vi.fn().mockResolvedValueOnce("native codex ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      agentDir: tempDir,
      resolveAgentHarnessRuntimeOverride: () => "codex",
      run,
    });

    expect(result.result).toBe("native codex ok");
    expect(run).toHaveBeenCalledOnce();
    expect(result.attempts).toStrictEqual([]);
  });

  it("prefers a prepared harness over a colliding CLI runtime id", async () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        { id: "codex", pluginId: "test-codex-cli", config: { command: "codex" } },
      ],
    });
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
        },
      },
    });
    const prepareAgentHarnessRuntime = vi.fn(() => {
      registerAgentHarness(
        {
          id: "codex",
          label: "Codex",
          supports: () => ({ supported: true }),
          runAttempt: vi.fn<AgentHarness["runAttempt"]>(async () => {
            throw new Error("fallback test should not invoke the harness runtime");
          }),
        },
        { ownerPluginId: "codex-test" },
      );
    });
    const run = vi.fn().mockResolvedValueOnce("native codex ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "codex",
      model: "gpt-5.5",
      resolveAgentHarnessRuntimeOverride: () => "codex",
      prepareAgentHarnessRuntime,
      run,
    });

    expect(prepareAgentHarnessRuntime).toHaveBeenCalledWith({
      provider: "codex",
      model: "gpt-5.5",
      agentHarnessRuntimeOverride: "codex",
    });
    expect(result.result).toBe("native codex ok");
    expect(run).toHaveBeenCalledOnce();
  });

  it("lets configured CLI runtimes bypass stale provider auth cooldowns", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          models: {
            "anthropic/*": { agentRuntime: { id: "claude-cli" } },
          },
          model: {
            primary: "anthropic/claude-sonnet-4-6",
          },
        },
      },
    });
    const tempDir = await makeAuthTempDir();
    setAuthRuntimeStore(tempDir, {
      version: AUTH_STORE_VERSION,
      profiles: {
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "test-key" },
        "openai:default": { type: "api_key", provider: "openai", key: "test-key" },
      },
      usageStats: {
        "anthropic:default": {
          disabledUntil: Date.now() + 60_000,
          disabledReason: "billing",
          failureCounts: { rate_limit: 4 },
        },
      },
    });
    const run = vi.fn().mockResolvedValueOnce("cli ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      agentDir: tempDir,
      run,
    });

    expect(result.result).toBe("cli ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]).toMatchObject([
      "anthropic",
      "claude-sonnet-4-6",
      { isFinalFallbackAttempt: true },
    ]);
    expect(result.attempts).toStrictEqual([]);
  });

  it("lets direct CLI providers bypass stale provider auth cooldowns", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "claude-cli/opus",
          },
        },
      },
    });
    const tempDir = await makeAuthTempDir();
    setAuthRuntimeStore(tempDir, {
      version: AUTH_STORE_VERSION,
      profiles: {
        "claude-cli:default": {
          type: "api_key",
          provider: "claude-cli",
          key: "test-key",
        },
        "openai:default": { type: "api_key", provider: "openai", key: "test-key" },
      },
      usageStats: {
        "claude-cli:default": {
          disabledUntil: Date.now() + 60_000,
          disabledReason: "billing",
          failureCounts: { rate_limit: 4 },
        },
      },
    });
    const run = vi.fn().mockResolvedValueOnce("direct cli ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "claude-cli",
      model: "opus",
      agentDir: tempDir,
      run,
    });

    expect(result.result).toBe("direct cli ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]).toMatchObject([
      "claude-cli",
      "opus",
      { isFinalFallbackAttempt: true },
    ]);
    expect(result.attempts).toStrictEqual([]);
  });

  it("does not treat command-lane watchdog timeouts as model fallback failures", async () => {
    const cfg = makeCfg();
    const timeoutError = makeCommandLaneTaskTimeoutError("cron-nested", 330_000);
    const run = vi.fn().mockRejectedValue(timeoutError);

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
      }),
    ).rejects.toBe(timeoutError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not run a second candidate after a canonical hard run timeout", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
      },
    });
    const timeoutError = new AgentRunTerminalOutcomeError(
      new Error("attempt aborted before prompt submission"),
      {
        reason: "hard_timeout",
        status: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
    );
    const run = vi.fn().mockRejectedValueOnce(timeoutError).mockResolvedValueOnce("too late");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-5.4",
        run,
      }),
    ).rejects.toBe(timeoutError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("aborts the fallback chain when the transcript writer claim rebounds", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-4.1-mini"],
          },
        },
      },
    });
    const reboundError = new Error("session writer claim changed before transcript persistence");
    reboundError.name = "SessionTranscriptWriterClaimReboundError";
    const run = vi.fn().mockRejectedValue(reboundError);

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-5.4",
        run,
      }),
    ).rejects.toBe(reboundError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not retry a superseded harness session generation on fallback models", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-4.1-mini"],
          },
        },
      },
    });
    const supersededError = new AgentHarnessSessionSupersededError(
      "Codex session generation is no longer current: session-old",
    );
    const run = vi.fn().mockRejectedValue(supersededError);

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-5.4",
        run,
      }),
    ).rejects.toBe(supersededError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not repeat model-independent harness preflight on fallback models", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-4.1-mini"],
          },
        },
      },
    });
    const preflightError = new AgentHarnessPreflightError(
      "Computer Use live test failed after 2 attempts: thread/start timed out",
    );
    const run = vi.fn(async () => {
      await Promise.resolve();
      throw preflightError;
    });

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-5.4",
        run,
      }),
    ).rejects.toBe(preflightError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns a scoped preflight unchanged when every remaining candidate uses that harness", async () => {
    registerFallbackHarness("codex");
    const preflightError = createHarnessScopedPreflightError("codex");
    const run = vi.fn().mockRejectedValue(preflightError);
    const onFallbackStep = vi.fn();

    await expect(
      runWithModelFallback({
        cfg: makeCfg(),
        provider: "openai",
        model: "gpt-5.5",
        fallbacksOverride: ["openai/gpt-5.4", "openai/gpt-5.3"],
        resolveAgentHarnessRuntimeOverride: () => "codex",
        onFallbackStep,
        run,
      }),
    ).rejects.toBe(preflightError);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onFallbackStep).not.toHaveBeenCalled();
  });

  it("skips only same-runtime candidates after a scoped preflight", async () => {
    registerFallbackHarness("codex");
    const preflightError = createHarnessScopedPreflightError("codex");
    const run = vi.fn().mockRejectedValueOnce(preflightError).mockResolvedValueOnce("openclaw-ok");
    const onFallbackStep = vi.fn();

    const result = await runWithModelFallback({
      cfg: makeCfg(),
      provider: "openai",
      model: "gpt-5.5",
      fallbacksOverride: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
      resolveAgentHarnessRuntimeOverride: (provider) =>
        provider === "openai" ? "codex" : "openclaw",
      onFallbackStep,
      run,
    });

    expect(result.result).toBe("openclaw-ok");
    expect(run.mock.calls).toMatchObject([
      ["openai", "gpt-5.5", { isFinalFallbackAttempt: false }],
      ["anthropic", "claude-sonnet-4-6", { isFinalFallbackAttempt: true }],
    ]);
    expect(onFallbackStep).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        fallbackStepFromModel: "openai/gpt-5.5",
        fallbackStepToModel: "anthropic/claude-sonnet-4-6",
        fallbackStepFinalOutcome: "next_fallback",
      }),
    );
  });

  it("preserves a different runtime's host-policy denial", async () => {
    registerFallbackHarness("codex");
    const preflightError = createHarnessScopedPreflightError("codex");
    const hostPolicyError = new Error("exec denied: host=gateway security=deny");
    const run = vi
      .fn()
      .mockRejectedValueOnce(preflightError)
      .mockRejectedValueOnce(hostPolicyError);

    await expect(
      runWithModelFallback({
        cfg: makeCfg(),
        provider: "openai",
        model: "gpt-5.5",
        fallbacksOverride: ["anthropic/claude-sonnet-4-6"],
        resolveAgentHarnessRuntimeOverride: (provider) =>
          provider === "openai" ? "codex" : "openclaw",
        run,
      }),
    ).rejects.toBe(hostPolicyError);
    expect(run.mock.calls).toMatchObject([
      ["openai", "gpt-5.5", { isFinalFallbackAttempt: false }],
      ["anthropic", "claude-sonnet-4-6", { isFinalFallbackAttempt: true }],
    ]);
  });

  it("keeps an unresolved runtime eligible after a scoped preflight", async () => {
    const preflightError = createHarnessScopedPreflightError("codex");
    const run = vi.fn().mockRejectedValueOnce(preflightError).mockResolvedValueOnce("unknown-ok");

    const result = await runWithModelFallback({
      cfg: undefined,
      provider: "openai",
      model: "gpt-5.5",
      fallbacksOverride: ["anthropic/claude-sonnet-4-6"],
      resolveAgentHarnessRuntimeOverride: (provider) =>
        provider === "openai" ? "codex" : undefined,
      run,
    });

    expect(result.result).toBe("unknown-ok");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not spend model fallbacks on sandbox provisioning failures", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-4.1-mini"],
          },
        },
      },
    });
    const provisioningError = toSandboxProvisioningError(
      new Error("Sandbox image not found: openclaw-sandbox:analyst. Build or pull it first."),
      "docker",
    );
    const run = vi.fn().mockRejectedValue(provisioningError);
    const onError = vi.fn();
    const onFallbackStep = vi.fn();

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-5.4",
        run,
        onError,
        onFallbackStep,
      }),
    ).rejects.toBe(provisioningError);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onFallbackStep).not.toHaveBeenCalled();
  });

  it("aborts fallback when a provider-looking wrapper carries writer claim rebound", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-4.1-mini"],
          },
        },
      },
    });
    const writerClaimRebound = new Error(
      "session writer claim changed before transcript persistence",
    );
    writerClaimRebound.name = "SessionTranscriptWriterClaimReboundError";
    const providerFacingError = new Error("provider rejected request: rate limit", {
      cause: writerClaimRebound,
    });
    const run = vi.fn().mockRejectedValue(providerFacingError);

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-5.4",
        run,
      }),
    ).rejects.toBe(providerFacingError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("aborts the fallback chain on stale gateway lifecycle errors (#116418)", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "ollama/qwen3:0.6b",
            fallbacks: ["minimax/MiniMax-M3"],
          },
        },
      },
    });
    const lifecycleError = createAgentRunStaleLifecycleError();
    const wrappedLifecycleError = new Error("request was aborted", { cause: lifecycleError });
    wrappedLifecycleError.name = "AbortError";
    const run = vi.fn().mockRejectedValue(wrappedLifecycleError);
    const onFallbackStep = vi.fn();

    await expect(
      runWithModelFallback({
        cfg,
        provider: "ollama",
        model: "qwen3:0.6b",
        run,
        onFallbackStep,
      }),
    ).rejects.toBe(wrappedLifecycleError);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onFallbackStep).not.toHaveBeenCalledWith(
      expect.objectContaining({ decision: "candidate_failed" }),
    );
  });

  it.each([
    ["direct", () => new GatewayDrainingError()],
    ["cause", () => new Error("session send failed", { cause: new GatewayDrainingError() })],
    [
      "aggregate",
      () =>
        new AggregateError(
          [new Error("cleanup failed"), new GatewayDrainingError()],
          "agent run failed",
        ),
    ],
  ])("aborts fallback on %s gateway drain failures", async (_label, makeError) => {
    const error = makeError();
    const run = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("too late");
    const onError = vi.fn();
    const onFallbackStep = vi.fn();

    await expect(
      runWithModelFallback({
        cfg: undefined,
        provider: "openai",
        model: "gpt-5.6-sol",
        fallbacksOverride: ["openai/gpt-5.4-mini"],
        skipAuthProfileRuntime: true,
        run,
        onError,
        onFallbackStep,
      }),
    ).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onFallbackStep).not.toHaveBeenCalled();
  });

  it.each([
    [
      "direct",
      () =>
        Object.assign(new Error("device worker capacity remained full"), {
          name: "WorkerRunnerCapacityError",
        }),
    ],
    [
      "wrapped",
      () =>
        new Error("worker turn failed", {
          cause: Object.assign(new Error("device worker capacity remained full"), {
            name: "WorkerRunnerCapacityError",
          }),
        }),
    ],
    [
      "workspace reconciliation",
      () =>
        Object.assign(new Error("cloud worker workspace result could not be reconciled"), {
          name: "WorkerWorkspaceReconciliationError",
        }),
    ],
    [
      "wrapped workspace reconciliation",
      () =>
        new Error("worker turn failed", {
          cause: Object.assign(new Error("cloud worker workspace result could not be reconciled"), {
            name: "WorkerWorkspaceReconciliationError",
          }),
        }),
    ],
    [
      "active turn claim",
      () =>
        Object.assign(new Error("session already has an active turn claim"), {
          name: "ActiveTurnClaimError",
        }),
    ],
    [
      "wrapped active turn claim",
      () =>
        new Error("worker turn failed", {
          cause: Object.assign(new Error("session already has an active turn claim"), {
            name: "ActiveTurnClaimError",
          }),
        }),
    ],
  ])("aborts fallback on %s worker coordination failures", async (_label, makeError) => {
    const error = makeError();
    const run = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("too late");
    const onError = vi.fn();
    const onFallbackStep = vi.fn();

    await expect(
      runWithModelFallback({
        cfg: undefined,
        provider: "openai",
        model: "gpt-5.6-sol",
        fallbacksOverride: ["openai/gpt-5.4-mini"],
        skipAuthProfileRuntime: true,
        run,
        onError,
        onFallbackStep,
      }),
    ).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onFallbackStep).not.toHaveBeenCalled();
  });

  it("still advances after a genuine provider rate limit", async () => {
    const rateLimit = Object.assign(new Error("rate limit exceeded"), { status: 429 });
    const run = vi.fn().mockRejectedValueOnce(rateLimit).mockResolvedValueOnce("fallback ok");

    const result = await runWithModelFallback({
      cfg: undefined,
      provider: "openai",
      model: "gpt-5.6-sol",
      fallbacksOverride: ["openai/gpt-5.4-mini"],
      skipAuthProfileRuntime: true,
      run,
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.result).toBe("fallback ok");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.4-mini");
    expect(result.attempts[0]).toMatchObject({ reason: "rate_limit", status: 429 });
  });

  it("aborts the fallback chain on transcript continuation failures without candidate_failed attribution", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
      },
    });
    const continuationError = new TranscriptNotContinuableError("assistant");
    const run = vi.fn().mockRejectedValue(continuationError);
    const onFallbackStep = vi.fn();

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-5.4",
        run,
        onFallbackStep,
      }),
    ).rejects.toBe(continuationError);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onFallbackStep).not.toHaveBeenCalledWith(
      expect.objectContaining({ decision: "candidate_failed" }),
    );
  });

  it("still continues fallback on genuine timeout-shaped errors (#99943)", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
      },
    });
    const timeoutError = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    const run = vi.fn().mockRejectedValueOnce(timeoutError).mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-5.4",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.provider).toBe("anthropic");
  });

  it("continues to the next model after a Google invalid-key response (#114784)", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "google/gemini-3.1-pro-preview",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
      },
    });
    const googleInvalidKey = new Error(
      "Google Generative AI API error (400): API key not valid. Please pass a valid API key. [code=INVALID_ARGUMENT]",
    );
    const run = vi
      .fn()
      .mockRejectedValueOnce(googleInvalidKey)
      .mockResolvedValueOnce("fallback ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "google",
      model: "gemini-3.1-pro-preview",
      run,
    });

    expect(result.result).toBe("fallback ok");
    expect(result.provider).toBe("anthropic");
    expect(result.attempts[0]).toMatchObject({
      provider: "google",
      model: "gemini-3.1-pro-preview",
      reason: "auth",
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps raw provider schema errors in fallback summaries", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["openai/gpt-5.4-mini"],
          },
        },
      },
    });
    const rawError =
      "400 The following tools cannot be used with reasoning.effort 'minimal': web_search.";
    const run = vi.fn().mockRejectedValue(
      new FailoverError("LLM request failed: provider rejected the request schema.", {
        provider: "openai",
        model: "gpt-5.4",
        reason: "format",
        status: 400,
        rawError,
      }),
    );

    const error = requireFallbackSummaryError(
      await captureRejection(
        runWithModelFallback({
          cfg,
          provider: "openai",
          model: "gpt-5.4",
          run,
        }),
      ),
    );
    expect(error.name).toBe("FailoverError");
    expect(error.message).toContain(rawError);
    const attempt = error.attempts.find((candidate) => candidate.error === rawError);
    if (!attempt) {
      throw new Error("expected raw error attempt");
    }
    expect(attempt.reason).toBe("format");
    expect(attempt.status).toBe(400);
  });

  it("uses the candidate message instead of mismatched provider raw errors", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-7",
            fallbacks: ["google/gemini-3-pro-preview"],
          },
        },
      },
    });
    const rawError = "You exceeded your current OpenAI quota.";
    const run = vi.fn().mockRejectedValue(
      new FailoverError("LLM request timed out.", {
        provider: "openai",
        model: "gpt-5.4",
        reason: "timeout",
        status: 408,
        rawError,
      }),
    );

    const error = requireFallbackSummaryError(
      await captureRejection(
        runWithModelFallback({
          cfg,
          provider: "anthropic",
          model: "claude-opus-4-7",
          run,
        }),
      ),
    );
    expect(error.attempts[0]?.error).toBe("LLM request timed out.");
    expect(error.attempts[0]?.error).not.toBe(rawError);
  });

  it.each([false, true])(
    "attributes the final failed candidate after fallback (watchdog=%s)",
    async (watchdog) => {
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-7",
              fallbacks: ["google/gemini-3-pro-preview"],
            },
          },
        },
      });
      const timeout = createCliTimeoutError(
        {},
        {
          mode: "no-output",
          timeoutSeconds: 30,
          observedActivity: false,
          activeToolCount: 0,
          backgroundTaskCount: 0,
        },
      );
      const providerFailure = Object.assign(new Error("500 upstream failure"), { status: 500 });
      const run = vi
        .fn()
        .mockRejectedValueOnce(watchdog ? providerFailure : timeout)
        .mockRejectedValueOnce(watchdog ? timeout : providerFailure);
      const error = requireFallbackSummaryError(
        await captureRejection(
          runWithModelFallback({
            cfg,
            provider: "anthropic",
            model: "claude-opus-4-7",
            run,
          }),
        ),
      );

      expect(run).toHaveBeenCalledTimes(2);
      expect(error.attempts.map(({ status }) => status)).toEqual(
        watchdog ? [500, 408] : [408, 500],
      );
      expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toEqual(
        watchdog ? { stopReason: "timeout", timeoutPhase: "provider" } : {},
      );
    },
  );

  it("carries request attribution through exhausted fallback summaries", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-opus-4-6"],
          },
        },
      },
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate limit exceeded"), { status: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error("overloaded"), { status: 503 }));

    const err = await captureRejection(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-5.4",
        runId: "run-42713",
        sessionId: "session:browser-42713",
        lane: "answer",
        run,
      }),
    );
    const summary = requireFallbackSummaryError(err);
    expect(summary.name).toBe("FailoverError");
    expect(summary.sessionId).toBe("session:browser-42713");
    expect(summary.lane).toBe("answer");
    const cause = requireFailoverError(summary.cause);
    expect(cause.name).toBe("FailoverError");
    expect(cause.sessionId).toBe("session:browser-42713");
    expect(cause.lane).toBe("answer");
  });

  it("uses optional result classification to continue to configured fallbacks", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-haiku-3-5"],
          },
        },
      },
    });
    const run = vi
      .fn()
      .mockResolvedValueOnce({ payloads: [] })
      .mockResolvedValueOnce({
        payloads: [{ text: "fallback ok" }],
      });
    const classifyResult = vi.fn(({ result }) =>
      Array.isArray(result.payloads) && result.payloads.length === 0
        ? {
            message: "terminal result contained no visible assistant reply",
            reason: "format" as const,
            code: "empty_result",
          }
        : null,
    );

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-5.4",
      run,
      classifyResult,
    });

    expect(result.result).toEqual({ payloads: [{ text: "fallback ok" }] });
    expect(run).toHaveBeenCalledTimes(2);
    expect(requireMockCall(run, 1, "fallback run")).toMatchObject([
      "anthropic",
      "claude-haiku-3-5",
      { isFinalFallbackAttempt: true },
    ]);
    expect(result.attempts[0]?.provider).toBe("openai");
    expect(result.attempts[0]?.model).toBe("gpt-5.4");
    expect(result.attempts[0]?.reason).toBe("format");
    expect(result.attempts[0]?.code).toBe("empty_result");
  });

  it("continues fallback after embedded provider business-denial payloads", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "zai/glm-5.1",
            fallbacks: ["openai/gpt-5.5"],
          },
        },
      },
    });
    const rawError =
      '{"success":false,"code":"CE-011","message":"当前ak因违规请求被禁止访问该模型"}';
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        payloads: [{ text: rawError, isError: true }],
        meta: { durationMs: 1 },
      } satisfies EmbeddedAgentRunResult)
      .mockResolvedValueOnce({
        payloads: [{ text: "fallback ok" }],
        meta: { durationMs: 1 },
      } satisfies EmbeddedAgentRunResult);

    const result = await runWithModelFallback<EmbeddedAgentRunResult>({
      cfg,
      provider: "zai",
      model: "glm-5.1",
      run,
      classifyResult: ({ provider, model, result: resultLocal }) =>
        classifyEmbeddedAgentRunResultForModelFallback({
          provider,
          model,
          result: resultLocal,
        }),
    });

    expect(result.result.payloads).toEqual([{ text: "fallback ok" }]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(requireMockCall(run, 1, "fallback run")).toMatchObject([
      "openai",
      "gpt-5.5",
      { isFinalFallbackAttempt: true },
    ]);
    expect(result.attempts[0]).toMatchObject({
      provider: "zai",
      model: "glm-5.1",
      reason: "auth",
      code: "embedded_error_payload",
      error: rawError,
    });
  });

  it("surfaces classified terminal results when no fallback remains", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: [],
          },
        },
      },
    });
    const run = vi.fn().mockResolvedValueOnce({ payloads: [] });

    const error = requireFailoverError(
      await captureRejection(
        runWithModelFallback({
          cfg,
          provider: "openai",
          model: "gpt-5.4",
          run,
          classifyResult: ({ result }) => {
            const payloads = (result as { payloads?: unknown[] }).payloads;
            return Array.isArray(payloads) && payloads.length === 0
              ? {
                  message: "terminal result contained no visible assistant reply",
                  reason: "format",
                  code: "empty_result",
                }
              : null;
          },
        }),
      ),
    );
    expect(error.name).toBe("FailoverError");
    expect(error.reason).toBe("format");
    expect(error.provider).toBe("openai");
    expect(error.model).toBe("gpt-5.4");
    expect(error.code).toBe("empty_result");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not classify successful results when the optional classifier returns null", async () => {
    const cfg = makeProviderFallbackCfg("openai");
    const run = vi.fn().mockResolvedValueOnce({ payloads: [{ text: "ok" }] });
    const classifyResult = vi.fn(() => null);

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "m1",
      run,
      classifyResult,
    });

    expect(result.result).toEqual({ payloads: [{ text: "ok" }] });
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.attempts).toStrictEqual([]);
  });

  it("keeps tool-executing empty GPT-5 runs out of fallback", () => {
    const runResult: EmbeddedAgentRunResult = {
      payloads: [],
      meta: {
        durationMs: 1,
        replayInvalid: true,
        toolSummary: {
          calls: 1,
          tools: ["mcp_write"],
        },
      },
    };

    expect(
      classifyEmbeddedAgentRunResultForModelFallback({
        provider: "openai",
        model: "gpt-5.4",
        result: runResult,
      }),
    ).toBeNull();
  });

  it("keeps normalized silent GPT-5 terminal replies out of fallback", () => {
    const runResult: EmbeddedAgentRunResult = {
      payloads: [],
      meta: {
        durationMs: 1,
        finalAssistantRawText: "NO_REPLY",
      },
    };

    expect(
      classifyEmbeddedAgentRunResultForModelFallback({
        provider: "openai",
        model: "gpt-5.4",
        result: runResult,
      }),
    ).toBeNull();
  });

  it("keeps before_agent_run hook blocks out of empty-result fallback", () => {
    const runResult: EmbeddedAgentRunResult = {
      payloads: [{ text: "Blocked by before-run policy.", isError: true }],
      meta: {
        durationMs: 1,
        livenessState: "blocked",
        error: {
          kind: "hook_block",
          message: "Blocked by before-run policy.",
        },
      },
    };

    expect(
      classifyEmbeddedAgentRunResultForModelFallback({
        provider: "atlassian-ai-gateway-openai",
        model: "gpt-5.5-2026-04-23",
        result: runResult,
      }),
    ).toBeNull();
  });

  it("uses harness-owned terminal classification for GPT-5 fallback", () => {
    const runResult: EmbeddedAgentRunResult = {
      payloads: [],
      meta: {
        durationMs: 1,
        agentHarnessResultClassification: "planning-only",
      },
    };

    const classification = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "codex",
      model: "gpt-5.4",
      result: runResult,
    });
    const classificationRecord = requireRecord(classification, "planning-only classification");
    expect(classificationRecord.code).toBe("planning_only_result");
    expect(classificationRecord.reason).toBe("format");
  });

  it("classifies non-GPT incomplete terminal errors for configured fallback", () => {
    const runResult: EmbeddedAgentRunResult = {
      payloads: [
        { text: "⚠️ Agent couldn't generate a response. Please try again.", isError: true },
      ],
      meta: {
        durationMs: 1,
        error: {
          kind: "incomplete_turn",
          message: "Agent couldn't generate a response.",
          fallbackSafe: true,
        },
      },
    };

    const classification = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "anthropic",
      model: "claude-opus-4.7",
      result: runResult,
    });
    const classificationRecord = requireRecord(classification, "incomplete classification");
    expect(classificationRecord.code).toBe("incomplete_result");
    expect(classificationRecord.reason).toBe("format");
  });

  it("keeps aborted harness-classified GPT-5 runs out of fallback", () => {
    const runResult: EmbeddedAgentRunResult = {
      payloads: [],
      meta: {
        durationMs: 1,
        aborted: true,
        agentHarnessResultClassification: "empty",
      },
    };

    expect(
      classifyEmbeddedAgentRunResultForModelFallback({
        provider: "codex",
        model: "gpt-5.4",
        result: runResult,
      }),
    ).toBeNull();
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
    const errorCall = requireRecord(requireMockCall(onError, 0, "onError")[0], "onError payload");
    expect(errorCall.provider).toBe("openai");
    expect(errorCall.model).toBe("gpt-4.1-mini");
    expect(errorCall.attempt).toBe(1);
    expect(errorCall.total).toBe(2);
    expect(errorCall.error).toBe(unknownError);
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

  it("treats LiveSessionModelSwitchError as failover on last candidate (#58496 family)", async () => {
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
    expect((err as { reason?: string }).reason).toBe("unknown");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns an unconfigured live switch target to the retry owner (#101676)", async () => {
    const switchError = new LiveSessionModelSwitchError({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    const run = vi.fn().mockRejectedValue(switchError);

    await expect(
      runWithModelFallback({
        cfg: makeCfg(),
        provider: "openai",
        model: "gpt-4.1-mini",
        fallbacksOverride: [],
        run,
      }),
    ).rejects.toBe(switchError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("continues fallback past a stale switch to an earlier candidate (#58496 family)", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["anthropic/claude-haiku-3-5", "deepseek/deepseek-chat"],
          },
        },
      },
    });
    const switchError = new LiveSessionModelSwitchError({
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        new FailoverError("rate limited", {
          reason: "rate_limit",
          provider: "openai",
          model: "gpt-4.1-mini",
        }),
      )
      .mockRejectedValueOnce(switchError)
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });
    expect(result.result).toBe("ok");
    expect(result.provider).toBe("deepseek");
    expect(result.model).toBe("deepseek-chat");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("jumps directly to a later live-session model switch candidate (#57471)", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: [
              "anthropic/claude-haiku-3-5",
              "anthropic/claude-sonnet-4-6",
              "openrouter/deepseek-chat",
            ],
          },
        },
      },
    });
    const switchError = new LiveSessionModelSwitchError({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    const run = vi.fn(async (provider: string, model: string) => {
      if (provider === "openai" && model === "gpt-4.1-mini") {
        throw switchError;
      }
      if (provider === "anthropic" && model === "claude-sonnet-4-6") {
        return "ok";
      }
      throw new Error(`unexpected fallback candidate: ${provider}/${model}`);
    });
    const onError = vi.fn();

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
      onError,
    });

    expect(result.result).toBe("ok");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.attempts).toStrictEqual([]);
    expect(onError).not.toHaveBeenCalled();
    expect(run.mock.calls).toMatchObject([
      ["openai", "gpt-4.1-mini", { isFinalFallbackAttempt: false }],
      ["anthropic", "claude-sonnet-4-6", { isFinalFallbackAttempt: false }],
    ]);
  });

  it("returns runtime-changing live switches to the retry owner before redirecting", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-haiku-3-5",
            fallbacks: ["openai/gpt-5.6-luna"],
          },
        },
      },
    });
    const switchError = new LiveSessionModelSwitchError({
      provider: "openai",
      model: "gpt-5.6-luna",
      agentRuntimeOverride: "codex",
    });
    const run = vi.fn().mockRejectedValue(switchError);

    await expect(
      runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-haiku-3-5",
        resolveAgentHarnessRuntimeOverride: (provider) =>
          provider === "openai" ? "openclaw" : undefined,
        run,
      }),
    ).rejects.toBe(switchError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns same-model runtime switches to the retry owner", async () => {
    const switchError = new LiveSessionModelSwitchError({
      provider: "openai",
      model: "gpt-4.1-mini",
      agentRuntimeOverride: "codex",
    });
    const run = vi.fn().mockRejectedValue(switchError);

    await expect(
      runWithModelFallback({
        cfg: makeCfg(),
        provider: "openai",
        model: "gpt-4.1-mini",
        fallbacksOverride: [],
        resolveAgentHarnessRuntimeOverride: () => "openclaw",
        run,
      }),
    ).rejects.toBe(switchError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not redirect stale live-session switch errors back to the current candidate (#58496 family)", async () => {
    const cfg = makeCfg();
    const switchError = new LiveSessionModelSwitchError({
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    const run = vi.fn().mockRejectedValueOnce(switchError).mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-haiku-3-5");
    expect(result.attempts[0]?.reason).toBe("unknown");
    expect(run.mock.calls).toMatchObject([
      ["openai", "gpt-4.1-mini", { isFinalFallbackAttempt: false }],
      ["anthropic", "claude-haiku-3-5", { isFinalFallbackAttempt: true }],
    ]);
  });

  it("falls back to the configured haiku candidate for retryable provider failures", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: Object.assign(new Error("nope"), { status: 401 }),
    });
  });

  it("puts configured fallbacks before the configured primary when an override model is requested", () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["anthropic/claude-haiku-3-5", "openrouter/deepseek-chat"],
          },
          modelPolicy: { allow: ["openai/gpt-4.1-mini"] },
        },
      },
    });

    expect(
      testing.resolveFallbackCandidates({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-5",
      }),
    ).toEqual([
      { provider: "anthropic", model: "claude-opus-4-5" },
      { provider: "anthropic", model: "claude-haiku-3-5" },
      { provider: "openrouter", model: "openrouter/deepseek-chat" },
      { provider: "openai", model: "gpt-4.1-mini" },
    ]);
  });

  it("does not runtime-normalize exact configured custom provider overrides or fallbacks", () => {
    providerModelNormalizationMock.normalizeProviderModelIdWithRuntime.mockImplementation(
      ({ provider }: ProviderModelNormalizationParams) => {
        if (provider === "tui-pty-mock") {
          throw new Error("custom provider should not use plugin runtime normalization");
        }
        return undefined;
      },
    );
    const cfg = makeCfg({
      plugins: {
        enabled: false,
      },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["tui-pty-mock/gpt-5.5"],
          },
          models: {
            "openai/gpt-4.1-mini": {},
            "tui-pty-mock/gpt-5.5": {},
          },
        },
      },
      models: {
        providers: {
          "tui-pty-mock": {
            api: "openai-responses",
            baseUrl: "http://127.0.0.1:9/v1",
            apiKey: "test",
            request: { allowPrivateNetwork: true },
            models: [],
          },
        },
      },
    });

    expect(
      testing.resolveFallbackCandidates({
        cfg,
        provider: "tui-pty-mock",
        model: "gpt-5.5",
        fallbacksOverride: [],
      }),
    ).toEqual([{ provider: "tui-pty-mock", model: "gpt-5.5" }]);
    expect(
      testing.resolveFallbackCandidates({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
      }),
    ).toEqual([
      { provider: "openai", model: "gpt-4.1-mini" },
      { provider: "tui-pty-mock", model: "gpt-5.5" },
    ]);
    expect(
      providerModelNormalizationMock.normalizeProviderModelIdWithRuntime,
    ).not.toHaveBeenCalledWith(expect.objectContaining({ provider: "tui-pty-mock" }));
  });

  it("keeps configured fallbacks before configured primary for duplicate provider model ids", () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "deepseek/deepseek-v4-flash",
            fallbacks: ["minimax-portal/MiniMax-M2.7"],
          },
        },
      },
    });

    expect(
      testing.resolveFallbackCandidates({
        cfg,
        provider: "qianfan",
        model: "deepseek-v4-flash",
      }),
    ).toEqual([
      { provider: "qianfan", model: "deepseek-v4-flash" },
      { provider: "minimax-portal", model: "MiniMax-M2.7" },
      { provider: "deepseek", model: "deepseek-v4-flash" },
    ]);
  });

  it("keeps configured fallback chain when current model is a configured fallback", () => {
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

    expect(
      testing.resolveFallbackCandidates({
        cfg,
        provider: "anthropic",
        model: "claude-haiku-3-5",
      }),
    ).toEqual([
      { provider: "anthropic", model: "claude-haiku-3-5" },
      { provider: "openrouter", model: "openrouter/deepseek-chat" },
      { provider: "openai", model: "gpt-4.1-mini" },
    ]);
  });

  it("plans requested and fallback routes without provider runtime hooks when normalization is disabled", () => {
    const normalize = providerModelNormalizationMock.normalizeProviderModelIdWithRuntime;
    normalize.mockImplementation(() => {
      throw new Error("runtime hook entered pure planning");
    });
    expect(
      testing.resolveFallbackCandidates({
        cfg: makeCfg({
          agents: {
            defaults: {
              model: { primary: "custom/primary", fallbacks: ["custom/fallback"] },
              models: { "custom/fallback": { alias: "other" } },
            },
          },
        }),
        provider: "custom",
        model: "primary",
        requestedRouteResolution: "resolved",
        allowPluginNormalization: false,
      }),
    ).toEqual([
      { provider: "custom", model: "primary" },
      { provider: "custom", model: "fallback" },
    ]);
    expect(normalize).not.toHaveBeenCalled();
  });

  it("treats normalized default refs as primary and keeps configured fallback chain", () => {
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

    expect(
      testing.resolveFallbackCandidates({
        cfg,
        provider: " OpenAI ",
        model: "gpt-4.1-mini",
      }),
    ).toEqual([
      { provider: "openai", model: "gpt-4.1-mini" },
      { provider: "anthropic", model: "claude-haiku-3-5" },
    ]);
  });

  it("normalizes self-prefixed fallback candidates independently", () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "google/gemini-2.0-flash",
            fallbacks: ["xai/grok-4-fast-reasoning", "openai/gpt-5.4"],
          },
          models: {
            "google/gemini-2.0-flash": {},
            "xai/grok-4-fast": {},
            "openai/gpt-5.4": {},
          },
        },
      },
    });

    const candidates = testing.resolveFallbackCandidates({
      cfg,
      provider: "google",
      model: "google/gemini-2.0-flash",
    });

    expect(candidates).toEqual([
      { provider: "google", model: "gemini-2.0-flash" },
      { provider: "xai", model: "grok-4-fast" },
      { provider: "openai", model: "gpt-5.4" },
    ]);
  });

  it("executes fallback aliases in the selected agent scope", async () => {
    const cfg = makeCfg({
      agents: {
        list: [
          { id: "main", default: true },
          {
            id: "worker",
            models: {
              "anthropic/worker-fallback": { alias: "fast" },
            },
          },
        ],
        defaults: {
          model: {
            primary: "openai/primary",
            fallbacks: ["fast"],
          },
          models: {
            "openai/global-fallback": { alias: "fast" },
          },
        },
      },
    });

    expect(
      testing.resolveFallbackCandidates({
        cfg,
        agentId: "worker",
        provider: "openai",
        model: "primary",
      }),
    ).toEqual([
      { provider: "openai", model: "primary" },
      { provider: "anthropic", model: "worker-fallback" },
    ]);
    expect(
      testing.resolveFallbackCandidates({
        cfg,
        agentId: "main",
        provider: "openai",
        model: "primary",
      }),
    ).toEqual([
      { provider: "openai", model: "primary" },
      { provider: "openai", model: "global-fallback" },
    ]);

    const run = vi
      .fn()
      .mockRejectedValueOnce(
        new FailoverError("primary rate limited", {
          reason: "rate_limit",
          provider: "openai",
          model: "primary",
        }),
      )
      .mockResolvedValueOnce("worker fallback");
    const result = await runWithModelFallback({
      cfg,
      agentId: "worker",
      provider: "openai",
      model: "primary",
      skipAuthProfileRuntime: true,
      run,
    });

    expect(result.result).toBe("worker fallback");
    expect(requireMockCall(run, 1, "fallback run")).toMatchObject([
      "anthropic",
      "worker-fallback",
      { isFinalFallbackAttempt: true },
    ]);
  });

  it("tries configured fallbacks before primary for override credential validation errors", async () => {
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
    expect(run.mock.calls).toMatchObject([
      ["anthropic", "claude-opus-4", { isFinalFallbackAttempt: false }],
      ["anthropic", "claude-haiku-3-5", { isFinalFallbackAttempt: false }],
      ["openai", "gpt-4.1-mini", { isFinalFallbackAttempt: true }],
    ]);
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

  it("preserves auth mode metadata in fallback attempts", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        new FailoverError("credit balance too low", {
          reason: "billing",
          provider: "openai",
          model: "gpt-4.1-mini",
          authMode: "oauth",
        }),
      )
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.attempts[0]?.authMode).toBe("oauth");
  });

  it("preserves auth mode metadata after fallback exhaustion", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.6-sol",
            fallbacks: ["openai/gpt-5.6-terra"],
          },
        },
      },
    });
    const run = vi.fn().mockRejectedValue(
      new FailoverError("OpenAI OAuth unavailable", {
        reason: "auth_permanent",
        provider: "openai",
        authMode: "oauth",
      }),
    );

    const error = requireFallbackSummaryError(
      await captureRejection(
        runWithModelFallback({
          cfg,
          provider: "openai",
          model: "gpt-5.6-sol",
          run,
        }),
      ),
    );

    expect(error.authMode).toBe("oauth");
  });

  it("falls back on model-not-found error shapes", async () => {
    const cases: Array<{
      name: string;
      provider: string;
      model: string;
      error: Error;
      expectedFallback: [string, string];
      expectedReason?: string;
      isFinalFallbackAttempt?: boolean;
    }> = [
      {
        name: "unknown anthropic override",
        provider: "anthropic",
        model: "claude-opus-4-6",
        error: new Error("Unknown model: anthropic/claude-opus-4-6"),
        expectedFallback: ["anthropic", "claude-haiku-3-5"],
      },
      {
        name: "openai model not found",
        provider: "openai",
        model: "gpt-6",
        error: new Error("Model not found: openai/gpt-6"),
        expectedFallback: ["anthropic", "claude-haiku-3-5"],
      },
      {
        name: "bare stream read transport error",
        provider: "openai",
        model: "gpt-4.1-mini",
        error: new Error("stream_read_error"),
        expectedFallback: ["anthropic", "claude-haiku-3-5"],
        expectedReason: "timeout",
        isFinalFallbackAttempt: true,
      },
    ];

    for (const testCase of cases) {
      await runModelFallbackCase(testCase.name, async () => {
        const cfg = makeCfg();
        const run = vi.fn().mockRejectedValueOnce(testCase.error).mockResolvedValueOnce("ok");

        const result = await runWithModelFallback({
          cfg,
          provider: testCase.provider,
          model: testCase.model,
          run,
        });

        expect(result.result).toBe("ok");
        expect(run).toHaveBeenCalledTimes(2);
        expect(requireMockCall(run, 1, "fallback run")).toMatchObject([
          ...testCase.expectedFallback,
          { isFinalFallbackAttempt: testCase.isFinalFallbackAttempt ?? false },
        ]);
        if (testCase.expectedReason) {
          expect(result.attempts).toHaveLength(1);
          expect(result.attempts[0]?.reason).toBe(testCase.expectedReason);
        }
      });
    }
  });

  it("warns when falling back due to model_not_found", async () => {
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
        model: "gpt-6",
        run,
      });

      expect(result.result).toBe("ok");
      expect(
        await warnLogs.findText(
          'Model "openai/gpt-6" not found. Fell back to "anthropic/claude-haiku-3-5".',
        ),
      ).toBeDefined();
    } finally {
      warnLogs.cleanup();
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
      const warning = await warnLogs.findText('Model "openai/gpt-6spoof" not found');
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

  it("preserves OAuth mode when auth-disabled profiles are skipped", async () => {
    await expectSkippedUnavailableProvider({
      providerPrefix: "auth-disabled",
      usageStat: {
        disabledUntil: Date.now() + 5 * 60_000,
        disabledReason: "auth_permanent",
      },
      expectedReason: "auth_permanent",
      credentialType: "oauth",
      expectedAuthMode: "oauth",
    });
  });

  it("attempts an eligible same-provider user lock omitted from cooldown order", async () => {
    const provider = `locked-cooldown-${crypto.randomUUID()}`;
    const orderedProfileA = `${provider}:a`;
    const orderedProfileB = `${provider}:b`;
    const orderedProfileIds = [orderedProfileA, orderedProfileB];
    const userLockedAuthProfileId = `${provider}:locked`;
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        [orderedProfileA]: { type: "api_key", provider, key: "key-a" },
        [orderedProfileB]: { type: "api_key", provider, key: "key-b" },
        [userLockedAuthProfileId]: { type: "api_key", provider, key: "key-locked" },
        "fallback:default": { type: "api_key", provider: "fallback", key: "fallback-key" },
      },
      order: { [provider]: [...orderedProfileIds] },
      usageStats: {
        [orderedProfileA]: { cooldownUntil: Date.now() + 60_000 },
        [orderedProfileB]: { cooldownUntil: Date.now() + 120_000 },
      },
    };
    const run = vi.fn().mockResolvedValue("ok");

    const result = await runWithStoredAuth({
      cfg: makeProviderFallbackCfg(provider),
      store,
      provider,
      run,
      userLockedAuthProfileId,
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toMatchObject([[provider, "m1", { isFinalFallbackAttempt: false }]]);
    expect(store.order?.[provider]).toEqual(orderedProfileIds);
  });

  it("does not skip a provider when only its user-pinned profile is cooling down", async () => {
    const provider = `pinned-cooldown-${crypto.randomUUID()}`;
    const pinnedProfileId = `${provider}:pinned`;
    const backupProfileId = `${provider}:backup`;
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        [pinnedProfileId]: { type: "api_key", provider, key: "pinned-key" },
        [backupProfileId]: { type: "api_key", provider, key: "backup-key" },
        "fallback:default": { type: "api_key", provider: "fallback", key: "fallback-key" },
      },
      order: { [provider]: [backupProfileId] },
      usageStats: {
        [pinnedProfileId]: { cooldownUntil: Date.now() + 60_000 },
      },
    };
    const run = vi.fn().mockResolvedValue("ok");

    const result = await runWithStoredAuth({
      cfg: makeProviderFallbackCfg(provider),
      store,
      provider,
      run,
      userLockedAuthProfileId: pinnedProfileId,
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toMatchObject([[provider, "m1", { isFinalFallbackAttempt: false }]]);
  });

  it("discovers an exact external CLI user lock before cooldown admission", async () => {
    const provider = "minimax-portal";
    const orderedProfileId = "minimax-portal:api";
    const persistedStore: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        [orderedProfileId]: { type: "api_key", provider, key: "api-key" },
        "fallback:default": { type: "api_key", provider: "fallback", key: "fallback-key" },
      },
      order: { [provider]: [orderedProfileId] },
      usageStats: {
        [orderedProfileId]: {
          disabledUntil: Date.now() + 60_000,
          disabledReason: "auth",
        },
      },
    };
    const runtimeStore: AuthProfileStore = {
      ...persistedStore,
      profiles: {
        ...persistedStore.profiles,
        [MINIMAX_CLI_PROFILE_ID]: {
          type: "oauth",
          provider,
          access: "external-access",
          refresh: "external-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    authRuntimeMock.runtime.ensureAuthProfileStore.mockReturnValueOnce(runtimeStore);
    const run = vi.fn().mockResolvedValue("ok");

    const result = await runWithStoredAuth({
      cfg: makeProviderFallbackCfg(provider),
      store: persistedStore,
      provider,
      run,
      userLockedAuthProfileId: MINIMAX_CLI_PROFILE_ID,
    });

    expect(result.result).toBe("ok");
    expect(persistedStore.profiles[MINIMAX_CLI_PROFILE_ID]).toBeUndefined();
    expect(run.mock.calls).toMatchObject([[provider, "m1", { isFinalFallbackAttempt: false }]]);
    const ensureCall = requireMockCall(
      authRuntimeMock.runtime.ensureAuthProfileStore,
      0,
      "ensureAuthProfileStore",
    );
    expect(requireRecord(ensureCall[1], "auth store options")).toMatchObject({
      externalCli: {
        mode: "scoped",
        allowKeychainPrompt: false,
        profileIds: [MINIMAX_CLI_PROFILE_ID],
      },
    });
  });

  it("normalizes a blank user lock before cooldown admission", async () => {
    const provider = `blank-lock-${crypto.randomUUID()}`;
    const orderedProfileId = `${provider}:ordered`;
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        [orderedProfileId]: { type: "api_key", provider, key: "ordered-key" },
        "": { type: "api_key", provider, key: "blank-key" },
        "fallback:default": { type: "api_key", provider: "fallback", key: "fallback-key" },
      },
      order: { [provider]: [orderedProfileId] },
      usageStats: {
        [orderedProfileId]: {
          disabledUntil: Date.now() + 60_000,
          disabledReason: "auth",
        },
      },
    };
    const run = createFallbackOnlyRun();

    const result = await runWithStoredAuth({
      cfg: makeProviderFallbackCfg(provider),
      store,
      provider,
      run,
      userLockedAuthProfileId: "   ",
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toMatchObject([
      ["fallback", "ok-model", { isFinalFallbackAttempt: true }],
    ]);
    const ensureCall = requireMockCall(
      authRuntimeMock.runtime.ensureAuthProfileStore,
      0,
      "ensureAuthProfileStore",
    );
    expect(requireRecord(ensureCall[1], "auth store options")).toMatchObject({
      externalCli: { mode: "scoped" },
    });
    expect(
      requireRecord(
        requireRecord(ensureCall[1], "auth store options").externalCli,
        "external CLI options",
      ),
    ).not.toHaveProperty("profileIds");
  });

  it.each(["cross-provider", "missing", "ineligible"] as const)(
    "does not bypass cooldown order for a %s user lock",
    async (kind) => {
      const provider = `locked-rejected-${kind}-${crypto.randomUUID()}`;
      const orderedProfileA = `${provider}:a`;
      const orderedProfileB = `${provider}:b`;
      const orderedProfileIds = [orderedProfileA, orderedProfileB];
      const userLockedAuthProfileId =
        kind === "cross-provider" ? "other:locked" : `${provider}:locked`;
      const store: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          [orderedProfileA]: { type: "api_key", provider, key: "key-a" },
          [orderedProfileB]: { type: "api_key", provider, key: "key-b" },
          "fallback:default": { type: "api_key", provider: "fallback", key: "fallback-key" },
        },
        order: { [provider]: [...orderedProfileIds] },
        usageStats: {
          [orderedProfileA]: { cooldownUntil: Date.now() + 60_000 },
          [orderedProfileB]: { cooldownUntil: Date.now() + 120_000 },
        },
      };
      if (kind === "cross-provider") {
        store.profiles[userLockedAuthProfileId] = {
          type: "api_key",
          provider: "other",
          key: "other-key",
        };
      } else if (kind === "ineligible") {
        store.profiles[userLockedAuthProfileId] = {
          type: "token",
          provider,
          token: "expired-token",
          expires: Date.now() - 1,
        };
      }
      const run = createFallbackOnlyRun();

      const result = await runWithStoredAuth({
        cfg: makeProviderFallbackCfg(provider),
        store,
        provider,
        run,
        userLockedAuthProfileId,
      });

      expect(result.result).toBe("ok");
      expect(run.mock.calls).toMatchObject([
        [provider, "m1", { allowTransientCooldownProbe: true, isFinalFallbackAttempt: false }],
        ["fallback", "ok-model", { isFinalFallbackAttempt: true }],
      ]);
      expect(store.order?.[provider]).toEqual(orderedProfileIds);
    },
  );

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
    expect(requireMockCall(run, 0, "fallback run")[0]).toBe("openrouter");
    expect(result.attempts).toStrictEqual([]);
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
      credentialType: "token",
      expectedAuthMode: "token",
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
    expect(run.mock.calls).toMatchObject([[provider, "m1", { isFinalFallbackAttempt: false }]]);
    expect(result.attempts).toStrictEqual([]);
  });

  it("does not append configured primary when fallbacksOverride is set", () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
          },
        },
      },
    });

    expect(
      testing.resolveFallbackCandidates({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-5",
        fallbacksOverride: ["anthropic/claude-haiku-3-5"],
      }),
    ).toEqual([
      { provider: "anthropic", model: "claude-opus-4-5" },
      { provider: "anthropic", model: "claude-haiku-3-5" },
    ]);
  });

  it("keeps the configured-primary tail when inherited fallbacks stay unset", () => {
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

    // Reply/command preparation must project inherited fallbacks to `undefined`
    // so the candidate resolver owns the ladder and appends the configured
    // primary as the final candidate (C -> B -> A, not C -> B).
    const fallbacksOverride = resolveEffectiveModelFallbacks({
      cfg,
      agentId: "main",
      hasSessionModelOverride: false,
    });
    expect(fallbacksOverride).toBeUndefined();

    expect(
      testing.resolveFallbackCandidates({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-5",
        fallbacksOverride,
      }),
    ).toEqual([
      { provider: "anthropic", model: "claude-opus-4-5" },
      { provider: "anthropic", model: "claude-haiku-3-5" },
      { provider: "openai", model: "gpt-4.1-mini" },
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
          setAuthRuntimeStore(tempDir, {
            ...store,
            usageStats: {
              "anthropic:default": {
                cooldownUntil: expiry,
                cooldownReason: "rate_limit",
                cooldownModel: "claude-opus-4-5",
                failureCounts: { rate_limit: 1 },
              },
            },
          });
        }

        throw Object.assign(new Error("rate limited"), { status: 429 });
      });

      const error = requireFallbackSummaryError(
        await captureRejection(
          runWithModelFallback({
            cfg,
            provider: "anthropic",
            model: "claude-opus-4-5",
            agentDir: tempDir,
            run,
          }),
        ),
      );
      expect(error.name).toBe("FailoverError");
      expect(error.soonestCooldownExpiry).toBe(expiry);
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

      const error = requireFallbackSummaryError(
        await captureRejection(
          runWithModelFallback({
            cfg,
            provider: "anthropic",
            model: "claude-opus-4-5",
            agentDir: tempDir,
            run,
          }),
        ),
      );
      expect(error.name).toBe("FailoverError");
      expect(error.soonestCooldownExpiry).toBe(relevantExpiry);
    });
  });

  it("uses fallbacksOverride instead of agents.defaults.model.fallbacks", () => {
    const cfg = makeFallbacksOnlyCfg();

    const candidates = testing.resolveFallbackCandidates({
      cfg,
      provider: "anthropic",
      model: "claude-opus-4-5",
      fallbacksOverride: ["openai/gpt-4.1"],
    });

    expect(candidates).toEqual([
      { provider: "anthropic", model: "claude-opus-4-5" },
      { provider: "openai", model: "gpt-4.1" },
    ]);
  });

  it("treats an empty fallbacksOverride as disabling global fallbacks", () => {
    const cfg = makeFallbacksOnlyCfg();

    const candidates = testing.resolveFallbackCandidates({
      cfg,
      provider: "anthropic",
      model: "claude-opus-4-5",
      fallbacksOverride: [],
    });

    expect(candidates).toEqual([{ provider: "anthropic", model: "claude-opus-4-5" }]);
  });

  it("keeps explicit fallbacks reachable when models allowlist is present", () => {
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
    const candidates = testing.resolveFallbackCandidates({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4",
    });

    expect(candidates).toEqual([
      { provider: "anthropic", model: "claude-sonnet-4" },
      { provider: "openai", model: "gpt-4o" },
      { provider: "ollama", model: "llama-3" },
    ]);
  });

  it("does not reuse provider-order-sensitive configured fallback candidates", () => {
    const anthropicFirst = makeProviderOrderFallbackCfg([
      ["anthropic", "claude-sonnet-4"],
      ["ollama", "llama3"],
    ]);
    const ollamaFirst = makeProviderOrderFallbackCfg([
      ["ollama", "llama3"],
      ["anthropic", "claude-sonnet-4"],
    ]);

    expect(
      testing.resolveFallbackCandidates({
        cfg: anthropicFirst,
        provider: "",
        model: "",
        fallbacksOverride: [],
      }),
    ).toEqual([{ provider: "anthropic", model: "claude-sonnet-4" }]);
    expect(
      testing.resolveFallbackCandidates({
        cfg: ollamaFirst,
        provider: "",
        model: "",
        fallbacksOverride: [],
      }),
    ).toEqual([{ provider: "ollama", model: "llama3" }]);
  });

  it("defaults provider/model when missing (regression #946)", () => {
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

    const candidates = testing.resolveFallbackCandidates({
      cfg,
      provider: undefined as unknown as string,
      model: undefined as unknown as string,
    });

    expect(candidates).toEqual([{ provider: "openai", model: "gpt-4.1-mini" }]);
  });

  it("does not fall back on user aborts", async () => {
    const cfg = makeCfg();
    const controller = new AbortController();
    controller.abort(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }))
      .mockResolvedValueOnce("ok");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        abortSignal: controller.signal,
        run,
      }),
    ).rejects.toThrow("aborted");

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not fall back on restart aborts", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(createAgentRunRestartAbortError())
      .mockResolvedValueOnce("fallback should not run");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
      }),
    ).rejects.toThrow("agent run aborted for restart");

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not fall back on direct active-run aborts without an aborted signal", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(createAgentRunDirectAbortError())
      .mockResolvedValueOnce("fallback should not run");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
      }),
    ).rejects.toThrow("agent run aborted");

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not fall back when user cancels with AbortError reason", async () => {
    const cfg = makeCfg();
    const controller = new AbortController();
    controller.abort(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }))
      .mockResolvedValueOnce("should not run");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        abortSignal: controller.signal,
        run,
      }),
    ).rejects.toThrow("aborted");

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not fall back when caller cancellation uses a string reason", async () => {
    const cfg = makeCfg();
    const controller = new AbortController();
    controller.abort("Cancelled by operator.");
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }))
      .mockResolvedValueOnce("should not run");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        abortSignal: controller.signal,
        run,
      }),
    ).rejects.toThrow("aborted");

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not fall back when caller cancellation throws a plain error", async () => {
    const cfg = makeCfg();
    const controller = new AbortController();
    controller.abort("Cancelled by operator.");
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("Cancelled by operator."))
      .mockResolvedValueOnce("should not run");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        abortSignal: controller.signal,
        run,
      }),
    ).rejects.toThrow("Cancelled by operator.");

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("falls back when AbortError comes from the LLM provider (no external signal)", async () => {
    const cfg = makeProviderFallbackCfg("openai");
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
      )
      .mockResolvedValueOnce({ payloads: [{ text: "fallback ok" }] });

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toEqual({ payloads: [{ text: "fallback ok" }] });
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.attempts[0]?.provider).toBe("openai");
    expect(result.attempts[0]?.error).toBe("This operation was aborted");
  });

  it("does not fall back when the caller abort signal timed out", async () => {
    const cfg = makeCfg();
    const timeoutReason = new Error("chat run timed out");
    timeoutReason.name = "TimeoutError";
    const controller = new AbortController();
    controller.abort(timeoutReason);
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
      )
      .mockResolvedValueOnce("fallback should not run");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        abortSignal: controller.signal,
        run,
      }),
    ).rejects.toThrow("This operation was aborted");

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not fall back when a timed-out caller abort is classified from the result", async () => {
    const cfg = makeProviderFallbackCfg("openai");
    const timeoutReason = new Error("chat run timed out");
    timeoutReason.name = "TimeoutError";
    const controller = new AbortController();
    controller.abort(timeoutReason);
    const run = vi
      .fn()
      .mockResolvedValueOnce({ payloads: [] })
      .mockResolvedValueOnce({ payloads: [{ text: "fallback should not run" }] });
    const classifyResult = vi.fn(() => ({
      message: "This operation was aborted",
      reason: "timeout" as const,
      code: "terminal_abort",
    }));

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "m1",
        abortSignal: controller.signal,
        run,
        classifyResult,
      }),
    ).rejects.toThrow("This operation was aborted");

    expect(run).toHaveBeenCalledTimes(1);
    expect(classifyResult).toHaveBeenCalledTimes(1);
  });

  it("does not fall back when a user AbortError is classified from the result", async () => {
    const cfg = makeProviderFallbackCfg("openai");
    const abortReason = new Error("chat run cancelled");
    abortReason.name = "AbortError";
    const controller = new AbortController();
    controller.abort(abortReason);
    const run = vi
      .fn()
      .mockResolvedValueOnce({ payloads: [] })
      .mockResolvedValueOnce({ payloads: [{ text: "fallback should not run" }] });
    const classifyResult = vi.fn(() => ({
      message: "This operation was aborted",
      reason: "timeout" as const,
      code: "terminal_abort",
    }));

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "m1",
        abortSignal: controller.signal,
        run,
        classifyResult,
      }),
    ).rejects.toThrow("This operation was aborted");

    expect(run).toHaveBeenCalledTimes(1);
    expect(classifyResult).toHaveBeenCalledTimes(1);
  });

  it("does not fall back when a restart abort is classified from the result", async () => {
    const cfg = makeProviderFallbackCfg("openai");
    const controller = new AbortController();
    controller.abort(createAgentRunRestartAbortError());
    const run = vi
      .fn()
      .mockResolvedValueOnce({ payloads: [] })
      .mockResolvedValueOnce({ payloads: [{ text: "fallback should not run" }] });
    const classifyResult = vi.fn(() => ({
      message: "empty response",
      reason: "format" as const,
      code: "empty_result",
    }));

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "m1",
        abortSignal: controller.signal,
        run,
        classifyResult,
      }),
    ).rejects.toThrow("empty response");

    expect(run).toHaveBeenCalledTimes(1);
    expect(classifyResult).toHaveBeenCalledTimes(1);
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
    it("keeps fallback ordering correct across session overrides", () => {
      const cases = [
        {
          name: "same provider versioned session model",
          cfg: makeCfg({
            agents: {
              defaults: {
                model: {
                  primary: "anthropic/claude-opus-4-6",
                  fallbacks: ["anthropic/claude-sonnet-4-5", "google/gemini-2.5-flash"],
                },
              },
            },
          }),
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          calls: [
            ["anthropic", "claude-sonnet-4-20250514"],
            ["anthropic", "claude-sonnet-4-5"],
          ],
        },
        {
          name: "same provider model version difference",
          cfg: makeCfg({
            agents: {
              defaults: {
                model: {
                  primary: "anthropic/claude-opus-4-6",
                  fallbacks: ["groq/llama-3.3-70b-versatile"],
                },
              },
            },
          }),
          provider: "anthropic",
          model: "claude-opus-4-5",
          calls: [
            ["anthropic", "claude-opus-4-5"],
            ["groq", "llama-3.3-70b-versatile"],
          ],
        },
        {
          name: "different provider uses configured primary when no fallbacks exist",
          cfg: makeCfg({
            agents: {
              defaults: {
                model: {
                  primary: "anthropic/claude-opus-4-6",
                  fallbacks: [],
                },
              },
            },
          }),
          provider: "openai",
          model: "gpt-4.1-mini",
          calls: [
            ["openai", "gpt-4.1-mini"],
            ["anthropic", "claude-opus-4-6"],
          ],
        },
        {
          name: "exact primary uses fallbacks",
          cfg: makeCfg({
            agents: {
              defaults: {
                model: {
                  primary: "anthropic/claude-opus-4-6",
                  fallbacks: ["groq/llama-3.3-70b-versatile"],
                },
              },
            },
          }),
          provider: "anthropic",
          model: "claude-opus-4-6",
          calls: [
            ["anthropic", "claude-opus-4-6"],
            ["groq", "llama-3.3-70b-versatile"],
          ],
        },
      ] satisfies Array<{
        name: string;
        cfg: OpenClawConfig;
        provider: string;
        model: string;
        calls: Array<[string, string]>;
      }>;

      for (const testCase of cases) {
        const candidates = testing.resolveFallbackCandidates({
          cfg: testCase.cfg,
          provider: testCase.provider,
          model: testCase.model,
        });

        expect(candidates.slice(0, testCase.calls.length), testCase.name).toEqual(
          testCase.calls.map(([provider, model]) => ({ provider, model })),
        );
      }
    });
  });

  describe("fallback behavior with provider cooldowns", () => {
    async function makeAuthStoreWithCooldown(
      provider: string,
      reason: "rate_limit" | "overloaded" | "timeout" | "auth" | "billing",
    ): Promise<{ dir: string }> {
      const tmpDir = await makeAuthTempDir();
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
      setAuthRuntimeStore(tmpDir, store);
      return { dir: tmpDir };
    }

    it("maps non-quota cooldown suspensions to circuit-open session state", () => {
      expect(testing.resolveSessionSuspensionReason("rate_limit")).toBe("quota_exhausted");
      expect(testing.resolveSessionSuspensionReason("overloaded")).toBe("circuit_open");
      expect(testing.resolveSessionSuspensionReason("timeout")).toBe("circuit_open");
      expect(testing.resolveSessionSuspensionReason("billing")).toBe("manual");
    });

    it("attempts same-provider fallbacks during transient cooldowns", async () => {
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
      expect(requireMockCall(run, 0, "cooldown probe run")).toMatchObject([
        "anthropic",
        "claude-sonnet-4-5",
        { allowTransientCooldownProbe: true, isFinalFallbackAttempt: false },
      ]);
    });

    it("probes raw alias targets during rate-limit cooldowns", async () => {
      const { dir } = await makeAuthStoreWithCooldown("anthropic", "rate_limit");
      const cfg = makeCfg({
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: ["anthropic/claude-haiku-3-5", "groq/llama-3.3-70b-versatile"],
            },
            models: {
              "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
            },
          },
        },
      });

      const run = vi.fn().mockResolvedValueOnce("sonnet success");

      const result = await runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "sonnet",
        run,
        agentDir: dir,
      });

      expect(result.result).toBe("sonnet success");
      expect(run).toHaveBeenCalledTimes(1);
      expect(requireMockCall(run, 0, "alias probe run")).toMatchObject([
        "anthropic",
        "claude-sonnet-4-6",
        { allowTransientCooldownProbe: true, isFinalFallbackAttempt: false },
      ]);
    });

    it("skips same-provider models on persistent auth cooldowns", async () => {
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
      expect(requireMockCall(run, 0, "cross-provider fallback run")).toMatchObject([
        "groq",
        "llama-3.3-70b-versatile",
        { isFinalFallbackAttempt: true },
      ]);
    });

    it("tries cross-provider fallbacks when same provider has rate limit", async () => {
      const tmpDir = await makeAuthTempDir();
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
      setAuthRuntimeStore(tmpDir, store);

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
      expect(run.mock.calls).toMatchObject([
        [
          "anthropic",
          "claude-opus-4-6",
          { allowTransientCooldownProbe: true, isFinalFallbackAttempt: false },
        ],
        ["groq", "llama-3.3-70b-versatile", { isFinalFallbackAttempt: true }],
      ]);
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
      expect(run.mock.calls).toMatchObject([
        [
          "anthropic",
          "claude-opus-4-6",
          { allowTransientCooldownProbe: true, isFinalFallbackAttempt: false },
        ],
        ["groq", "llama-3.3-70b-versatile", { isFinalFallbackAttempt: true }],
      ]);
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
        .mockRejectedValueOnce(new Error("Model not found: anthropic/claude-opus-4-6"))
        .mockResolvedValueOnce("sonnet success");

      const result = await runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-6",
        run,
        agentDir: dir,
      });

      expect(result.result).toBe("sonnet success");
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls).toMatchObject([
        [
          "anthropic",
          "claude-opus-4-6",
          { allowTransientCooldownProbe: true, isFinalFallbackAttempt: false },
        ],
        [
          "anthropic",
          "claude-sonnet-4-5",
          { allowTransientCooldownProbe: true, isFinalFallbackAttempt: false },
        ],
      ]);
    });
  });

  describe("terminal abort propagation", () => {
    function makeAbortError(message = "aborted"): Error {
      const err = new Error(message);
      err.name = "AbortError";
      return err;
    }

    async function makeAbortableWrapper(reason: Error): Promise<Error> {
      const controller = new AbortController();
      controller.abort(reason);
      try {
        await abortable(controller.signal, Promise.resolve());
      } catch (error: unknown) {
        if (!(error instanceof Error)) {
          throw new Error("abortable() rejected with a non-Error value", { cause: error });
        }
        return error;
      }
      throw new Error("abortable() unexpectedly resolved after abort");
    }

    function makeAbortWrapper(reason: Error): Error {
      const err = new Error("aborted", { cause: reason });
      err.name = "AbortError";
      return err;
    }

    function makeTaggedAbortController(reason: Error): AbortController {
      const controller = new AbortController();
      controller.abort(reason);
      return controller;
    }

    it("rethrows immediately when signal.reason has name=TimeoutError (run-budget timeout)", async () => {
      const cfg = makeCfg();
      const runError = makeAbortError("aborted");
      const run = vi.fn().mockRejectedValue(runError);

      const timeoutReason = new Error("request timed out");
      timeoutReason.name = "TimeoutError";
      const controller = makeTaggedAbortController(timeoutReason);

      await expect(
        runWithModelFallback({
          cfg,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          run,
          abortSignal: controller.signal,
        }),
      ).rejects.toBe(runError);

      expect(run).toHaveBeenCalledTimes(1);
    });

    it("rethrows immediately when signal.reason has name=ClientDisconnectError", async () => {
      const cfg = makeCfg();
      const runError = makeAbortError("aborted");
      const run = vi.fn().mockRejectedValue(runError);

      const disconnectReason = new Error("HTTP client disconnected");
      disconnectReason.name = "ClientDisconnectError";
      const controller = makeTaggedAbortController(disconnectReason);

      await expect(
        runWithModelFallback({
          cfg,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          run,
          abortSignal: controller.signal,
        }),
      ).rejects.toBe(runError);

      expect(run).toHaveBeenCalledTimes(1);
    });

    it("detects TimeoutError nested as cause of an outer Error", async () => {
      const cfg = makeCfg();
      const runError = makeAbortError("aborted");
      const run = vi.fn().mockRejectedValue(runError);

      const innerTimeout = new Error("request timed out");
      innerTimeout.name = "TimeoutError";
      const outerWrap = await makeAbortableWrapper(innerTimeout);
      const controller = makeTaggedAbortController(outerWrap);

      await expect(
        runWithModelFallback({
          cfg,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          run,
          abortSignal: controller.signal,
        }),
      ).rejects.toBe(runError);

      expect(run).toHaveBeenCalledTimes(1);
    });

    it("rethrows when thrown error has TimeoutError in cause chain (embedded run-budget timer)", async () => {
      const cfg = makeCfg();
      const innerTimeout = new Error("request timed out");
      innerTimeout.name = "TimeoutError";
      const outerAbort = await makeAbortableWrapper(innerTimeout);
      const run = vi.fn().mockRejectedValue(outerAbort);

      await expect(
        runWithModelFallback({
          cfg,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          run,
        }),
      ).rejects.toBe(outerAbort);

      expect(run).toHaveBeenCalledTimes(1);
    });

    it("rethrows when thrown error has ClientDisconnectError in cause chain", async () => {
      const cfg = makeCfg();
      const innerDisconnect = new Error("client disconnected");
      innerDisconnect.name = "ClientDisconnectError";
      const outerAbort = await makeAbortableWrapper(innerDisconnect);
      const run = vi.fn().mockRejectedValue(outerAbort);

      await expect(
        runWithModelFallback({
          cfg,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          run,
        }),
      ).rejects.toBe(outerAbort);

      expect(run).toHaveBeenCalledTimes(1);
    });

    it("rethrows when thrown error has restart abort in cause chain", async () => {
      const cfg = makeCfg();
      const restartAbort = createAgentRunRestartAbortError();
      const outerAbort = await makeAbortableWrapper(restartAbort);
      const run = vi.fn().mockRejectedValueOnce(outerAbort).mockResolvedValueOnce("ok");

      await expect(
        runWithModelFallback({
          cfg,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          run,
        }),
      ).rejects.toBe(outerAbort);

      expect(run).toHaveBeenCalledTimes(1);
    });

    it("rethrows when an unmarked AbortError wraps a restart abort", async () => {
      const cfg = makeCfg();
      const restartAbort = createAgentRunRestartAbortError();
      const outerAbort = makeAbortWrapper(restartAbort);
      const run = vi.fn().mockRejectedValueOnce(outerAbort).mockResolvedValueOnce("ok");

      await expect(
        runWithModelFallback({
          cfg,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          run,
        }),
      ).rejects.toBe(outerAbort);

      expect(run).toHaveBeenCalledTimes(1);
    });

    it("discards deferred session suspension for private terminal abort wrappers", async () => {
      const timeout = new Error("request timed out");
      timeout.name = "TimeoutError";
      expect(
        testing.shouldDiscardDeferredSessionSuspension({
          error: await makeAbortableWrapper(timeout),
        }),
      ).toBe(true);

      expect(
        testing.shouldDiscardDeferredSessionSuspension({
          error: makeAbortWrapper(createAgentRunRestartAbortError()),
        }),
      ).toBe(true);

      const providerTimeout = new Error("provider request timed out after 60s");
      providerTimeout.name = "TimeoutError";
      expect(
        testing.shouldDiscardDeferredSessionSuspension({
          error: makeAbortWrapper(providerTimeout),
        }),
      ).toBe(false);
    });

    it("falls back normally when a provider wraps its own timeout as AbortError(cause: TimeoutError) WITHOUT the abortable() marker", async () => {
      const cfg = makeCfg();
      const providerInnerTimeout = new Error("provider request timed out after 60s");
      providerInnerTimeout.name = "TimeoutError";
      const unmarkedAbortError = new Error("aborted", { cause: providerInnerTimeout });
      unmarkedAbortError.name = "AbortError";
      const run = vi.fn().mockRejectedValueOnce(unmarkedAbortError).mockResolvedValueOnce("ok");

      const result = await runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        run,
      });

      expect(result.result).toBe("ok");
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("falls back normally when a top-level provider TimeoutError is thrown (not an AbortError wrapper)", async () => {
      const cfg = makeCfg();
      const directProviderTimeout = new Error("provider request timed out after 60s");
      directProviderTimeout.name = "TimeoutError";
      const run = vi.fn().mockRejectedValueOnce(directProviderTimeout).mockResolvedValueOnce("ok");

      const result = await runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        run,
      });

      expect(result.result).toBe("ok");
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("falls back normally when thrown error is generic AbortError without terminal cause", async () => {
      const cfg = makeCfg();
      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("provider transient failure"))
        .mockResolvedValueOnce("ok");

      const result = await runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        run,
      });

      expect(result.result).toBe("ok");
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("skips fallback when the caller signal is aborted, even with a non-terminal reason", async () => {
      const cfg = makeCfg();
      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("provider had a sad day"))
        .mockResolvedValueOnce("ok");

      const genericReason = new Error("some unrelated abort");
      const controller = makeTaggedAbortController(genericReason);

      await expect(
        runWithModelFallback({
          cfg,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          run,
          abortSignal: controller.signal,
        }),
      ).rejects.toBeInstanceOf(Error);

      expect(run).toHaveBeenCalledTimes(1);
    });

    it("falls back normally when no abortSignal is passed (back-compat)", async () => {
      const cfg = makeCfg();
      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("first attempt failed"))
        .mockResolvedValueOnce("ok");

      const result = await runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        run,
      });

      expect(result.result).toBe("ok");
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("falls back normally when signal is provided but not aborted", async () => {
      const cfg = makeCfg();
      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("first attempt failed"))
        .mockResolvedValueOnce("ok");

      const controller = new AbortController();
      const result = await runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        run,
        abortSignal: controller.signal,
      });

      expect(result.result).toBe("ok");
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("rethrows terminal abort even when error resembles a failover-normalizable error", async () => {
      const cfg = makeCfg();

      const rateLimitLikeError = Object.assign(new Error("RESOURCE_EXHAUSTED: quota exceeded"), {
        status: 429,
        name: "AbortError",
      });

      const run = vi.fn().mockRejectedValue(rateLimitLikeError);

      const timeoutReason = new Error("request timed out");
      timeoutReason.name = "TimeoutError";
      const controller = new AbortController();
      controller.abort(timeoutReason);

      await expect(
        runWithModelFallback({
          cfg,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          run,
          abortSignal: controller.signal,
        }),
      ).rejects.toBe(rateLimitLikeError);

      expect(run).toHaveBeenCalledTimes(1);
    });

    it("does not classify an unrelated string reason as terminal (caller-abort still skips fallback)", async () => {
      const cfg = makeCfg();
      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("first attempt failed"))
        .mockResolvedValueOnce("ok");

      const controller = new AbortController();
      controller.abort("some unrelated cancel reason");

      await expect(
        runWithModelFallback({
          cfg,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          run,
          abortSignal: controller.signal,
        }),
      ).rejects.toBeInstanceOf(Error);

      expect(run).toHaveBeenCalledTimes(1);
    });
  });
});

describe("runWithImageModelFallback", () => {
  it("resolves image-model override providers", async () => {
    const cases = [
      {
        name: "bare override inherits configured provider",
        cfg: makeCfg({
          agents: {
            defaults: {
              imageModel: {
                primary: "openai/gpt-5.4",
                fallbacks: ["openai/gpt-5.4-mini"],
              },
            },
          },
        }),
        modelOverride: "gpt-5.4-mini",
        expected: [["openai", "gpt-5.4-mini"]],
      },
      {
        name: "qualified override keeps provider",
        cfg: makeCfg({
          agents: {
            defaults: {
              imageModel: {
                primary: "openai/gpt-5.4",
              },
            },
          },
        }),
        modelOverride: "google/gemini-3-pro-image",
        expected: [["google", "gemini-3-pro-image"]],
      },
    ] satisfies Array<{
      name: string;
      cfg: OpenClawConfig;
      modelOverride: string;
      expected: Array<[string, string]>;
    }>;

    for (const testCase of cases) {
      await runModelFallbackCase(testCase.name, async () => {
        const run = vi.fn().mockResolvedValueOnce("ok");

        const result = await runWithImageModelFallback({
          cfg: testCase.cfg,
          modelOverride: testCase.modelOverride,
          run,
        });

        expect(result.result).toBe("ok");
        expect(run.mock.calls).toMatchObject(testCase.expected);
      });
    }
  });

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
    expect(run.mock.calls).toMatchObject([
      ["openai", "gpt-image-1"],
      ["google", "gemini-2.5-flash-image-preview"],
    ]);
  });

  it("keeps harness preflight terminal for image fallbacks", async () => {
    const preflightError = new AgentHarnessPreflightError("image preflight failed");
    const run = vi.fn().mockRejectedValue(preflightError);

    await expect(
      runWithImageModelFallback({
        cfg: makeCfg({
          agents: {
            defaults: {
              imageModel: {
                primary: "openai/gpt-image-1",
                fallbacks: ["google/gemini-2.5-flash-image-preview"],
              },
            },
          },
        }),
        run,
      }),
    ).rejects.toBe(preflightError);
    expect(run).toHaveBeenCalledOnce();
  });

  it("preserves caller cancellation without starting an image fallback", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled image fallback");
    const run = vi.fn(async () => {
      controller.abort(reason);
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    });

    await expect(
      runWithImageModelFallback({
        cfg: makeCfg({
          agents: {
            defaults: {
              imageModel: {
                primary: "openai/gpt-5.4-mini",
                fallbacks: ["google/gemini-2.5-flash"],
              },
            },
          },
        }),
        abortSignal: controller.signal,
        run,
      }),
    ).rejects.toBe(reason);

    expect(run).toHaveBeenCalledOnce();
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
