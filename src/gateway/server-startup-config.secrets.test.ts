// Startup config secret tests protect gateway token preparation, weak-secret
// detection, auth profile loading, warning emission, and runtime activation.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles.js";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshot,
  setRuntimeAuthProfileStoreSnapshot,
} from "../agents/auth-profiles/runtime-snapshots.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import { measureDiagnosticsTimelineSpan } from "../infra/diagnostics-timeline.js";
import { providerResolutionError, refResolutionError } from "../secrets/resolve-errors.js";
import { associateSecretResolutionErrorOwners } from "../secrets/runtime-degraded-state.js";
import { activateProviderAuthRuntimeSnapshot } from "../secrets/runtime-provider-auth-activation.js";
import {
  activateSecretsRuntimeSnapshotState,
  activateSecretsRuntimeSnapshotStateIfCurrent,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
} from "../secrets/runtime-state.js";
import type { PreparedSecretsRuntimeSnapshot, SecretResolverWarning } from "../secrets/runtime.js";
import {
  createRuntimeSecretsActivator,
  prepareGatewayStartupConfig,
  publishRuntimeSecretsStateTransition,
} from "./server-startup-config.js";
import { buildTestConfigSnapshot } from "./test-helpers.config-snapshots.js";

const KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS = [
  "change-me-to-a-long-random-token",
  "change-me-now",
] as const;

type PrepareRuntimeSecretsSnapshotForTest =
  typeof import("../secrets/runtime.js").prepareSecretsRuntimeSnapshot;
type ActivateRuntimeSecretsSnapshotForTest =
  typeof import("../secrets/runtime.js").activateSecretsRuntimeSnapshot;

type GatewayStartupSecretsRuntimeMock = {
  runtimeImport: () => void;
  prepareRuntimeSecretsSnapshot: PrepareRuntimeSecretsSnapshotForTest;
  activateRuntimeSecretsSnapshot: ActivateRuntimeSecretsSnapshotForTest;
};

type GatewayStartupLogMock = {
  info: ReturnType<typeof vi.fn<(message: string) => void>>;
  warn: ReturnType<typeof vi.fn<(message: string, meta?: Record<string, unknown>) => void>>;
  error: ReturnType<typeof vi.fn<(message: string) => void>>;
};

type GatewayStartupStateEmitterMock = ReturnType<
  typeof vi.fn<(code: string, message: string, cfg: OpenClawConfig) => void>
>;

const RESOLVED_GATEWAY_TOKEN = "resolved-gateway-token";
const autoCleanupTempDirs = useAutoCleanupTempDirTracker(afterEach);

function activateSecretsRuntimeSnapshotForTest(snapshot: PreparedSecretsRuntimeSnapshot): void {
  activateSecretsRuntimeSnapshotState({
    snapshot,
    refreshContext: null,
    refreshHandler: null,
  });
}

function gatewayTokenConfig(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    gateway: {
      ...config.gateway,
      auth: {
        ...config.gateway?.auth,
        mode: config.gateway?.auth?.mode ?? "token",
        token: config.gateway?.auth?.token ?? "startup-test-token",
      },
    },
  };
}

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function buildSnapshot(config: OpenClawConfig): ConfigFileSnapshot {
  const raw = `${JSON.stringify(config, null, 2)}\n`;
  return buildTestConfigSnapshot({
    path: "/tmp/openclaw-startup-secrets-test.json",
    exists: true,
    raw,
    parsed: config,
    valid: true,
    config,
    issues: [],
    legacyIssues: [],
  });
}

function preparedSnapshot(config: OpenClawConfig): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: config,
    config,
    authStores: [],
    authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
    warnings: [],
    webTools: {
      search: {
        providerSource: "none",
        diagnostics: [],
      },
      fetch: {
        providerSource: "none",
        diagnostics: [],
      },
      diagnostics: [],
    },
  };
}

function preparedSnapshotWithGatewayToken(
  config: OpenClawConfig,
  token = RESOLVED_GATEWAY_TOKEN,
): PreparedSecretsRuntimeSnapshot {
  return {
    ...preparedSnapshot(config),
    config: {
      ...config,
      gateway: {
        ...config.gateway,
        auth: {
          ...config.gateway?.auth,
          token,
        },
      },
    },
  };
}

function callArg<T>(mock: { mock: { calls: unknown[][] } }, index = 0, _type?: (value: T) => T): T {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected mock call ${index}`);
  }
  return call[0] as T;
}

function gatewaySecretRefSnapshot(): ConfigFileSnapshot {
  return buildSnapshot({
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
    gateway: {
      auth: {
        mode: "token",
        token: { source: "env", provider: "default", id: "GATEWAY_TOKEN_REF" },
      },
    },
  });
}

function runtimeSecretsActivatorForTest(params: {
  prepareRuntimeSecretsSnapshot: PrepareRuntimeSecretsSnapshotForTest;
  activateRuntimeSecretsSnapshot?: ActivateRuntimeSecretsSnapshotForTest;
  emitStateEvent?: GatewayStartupStateEmitterMock;
  logSecrets?: GatewayStartupLogMock;
}) {
  const defaultActivatorOptions = runtimeSecretsActivatorOptionsForTest();
  return createRuntimeSecretsActivator({
    logSecrets: params.logSecrets ?? defaultActivatorOptions.logSecrets,
    emitStateEvent: params.emitStateEvent ?? defaultActivatorOptions.emitStateEvent,
    prepareRuntimeSecretsSnapshot: params.prepareRuntimeSecretsSnapshot,
    activateRuntimeSecretsSnapshot: params.activateRuntimeSecretsSnapshot ?? vi.fn(),
  });
}

function runtimeSecretsActivatorOptionsForTest() {
  return {
    logSecrets: mockLogSecretsForTest(),
    emitStateEvent: vi.fn<(code: string, message: string, cfg: OpenClawConfig) => void>(),
  };
}

function mockLogSecretsForTest(): GatewayStartupLogMock {
  return {
    info: vi.fn<(message: string) => void>(),
    warn: vi.fn<(message: string, meta?: Record<string, unknown>) => void>(),
    error: vi.fn<(message: string) => void>(),
  };
}

function readTimelineEvents(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function installDiagnosticsTimelineEnv() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-startup-secrets-timeline-"));
  const timelinePath = path.join(root, "timeline.jsonl");
  const previousDiagnostics = process.env.OPENCLAW_DIAGNOSTICS;
  const previousTimelinePath = process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH;
  process.env.OPENCLAW_DIAGNOSTICS = "timeline";
  process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = timelinePath;

  return {
    timelinePath,
    cleanup: () => {
      if (previousDiagnostics === undefined) {
        delete process.env.OPENCLAW_DIAGNOSTICS;
      } else {
        process.env.OPENCLAW_DIAGNOSTICS = previousDiagnostics;
      }
      if (previousTimelinePath === undefined) {
        delete process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH;
      } else {
        process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = previousTimelinePath;
      }
      rmSync(root, { force: true, recursive: true });
    },
  };
}

/** Isolate path-based auth store discovery so prior full-suite env cannot force slow path. */
function installIsolatedStartupFastPathEnv() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-startup-fast-path-env-"));
  const keys = [
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_OAUTH_DIR",
  ] as const;
  const previous = new Map<(typeof keys)[number], string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
  }
  process.env.OPENCLAW_HOME = path.join(root, "home");
  process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
  process.env.OPENCLAW_CONFIG_PATH = path.join(root, "state", "openclaw.json");
  process.env.OPENCLAW_OAUTH_DIR = path.join(root, "credentials");

  return {
    cleanup: () => {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      rmSync(root, { force: true, recursive: true });
    },
  };
}

function installGatewayStartupSecretsRuntimeMock(state: GatewayStartupSecretsRuntimeMock) {
  (
    globalThis as typeof globalThis & {
      __gatewayStartupSecretsRuntimeMock?: typeof state;
    }
  )["__gatewayStartupSecretsRuntimeMock"] = state;
  vi.doMock("../agents/auth-profiles.js", () => ({
    loadAuthProfileStoreWithoutExternalProfiles: vi.fn(() => ({
      version: 1,
      profiles: {},
    })),
  }));
  vi.doMock("../secrets/runtime.js", () => {
    const runtimeState = (
      globalThis as typeof globalThis & {
        __gatewayStartupSecretsRuntimeMock?: typeof state;
      }
    )["__gatewayStartupSecretsRuntimeMock"];
    if (!runtimeState) {
      throw new Error("missing gateway startup secrets runtime mock");
    }
    runtimeState.runtimeImport();
    return {
      prepareSecretsRuntimeSnapshot: runtimeState.prepareRuntimeSecretsSnapshot,
      activateSecretsRuntimeSnapshot: runtimeState.activateRuntimeSecretsSnapshot,
      preflightActiveSecretsRuntimeSnapshotRefresh: async ({
        sourceConfig,
      }: {
        sourceConfig: OpenClawConfig;
      }) => await runtimeState.prepareRuntimeSecretsSnapshot({ config: sourceConfig }),
      refreshActiveSecretsRuntimeSnapshotForConfig: async ({
        sourceConfig,
        preflightResult,
      }: {
        sourceConfig: OpenClawConfig;
        preflightResult?: unknown;
      }) => {
        const snapshot =
          preflightResult && typeof preflightResult === "object"
            ? (preflightResult as PreparedSecretsRuntimeSnapshot)
            : await runtimeState.prepareRuntimeSecretsSnapshot({ config: sourceConfig });
        runtimeState.activateRuntimeSecretsSnapshot(snapshot);
        return true;
      },
    };
  });
}

function cleanupGatewayStartupSecretsRuntimeMock(): void {
  vi.doUnmock("../agents/auth-profiles.js");
  vi.doUnmock("../secrets/runtime.js");
  delete (
    globalThis as typeof globalThis & {
      __gatewayStartupSecretsRuntimeMock?: unknown;
    }
  )["__gatewayStartupSecretsRuntimeMock"];
}

function createGatewayStartupSecretsRuntimeHarness(prefix: string) {
  vi.resetModules();
  const agentDir = mkdtempSync(path.join(tmpdir(), prefix));
  const runtimeImport = vi.fn();
  const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => preparedSnapshot(config));
  const activateRuntimeSecretsSnapshot = vi.fn();
  return {
    activateRuntimeSecretsSnapshot,
    agentDir,
    install: () => {
      installGatewayStartupSecretsRuntimeMock({
        runtimeImport,
        prepareRuntimeSecretsSnapshot,
        activateRuntimeSecretsSnapshot,
      });
    },
    prepareRuntimeSecretsSnapshot,
    runtimeImport,
    cleanup: () => {
      cleanupGatewayStartupSecretsRuntimeMock();
      rmSync(agentDir, { recursive: true, force: true });
      vi.resetModules();
    },
  };
}

async function activateImportedStartupConfig(config: OpenClawConfig) {
  const { createRuntimeSecretsActivator: createActivator } =
    await import("./server-startup-config.js");
  return await createActivator(runtimeSecretsActivatorOptionsForTest())(
    gatewayTokenConfig(config),
    {
      reason: "startup",
      activate: true,
    },
  );
}

async function prepareGatewaySecretRefStartupConfig(params: {
  prepareRuntimeSecretsSnapshot: PrepareRuntimeSecretsSnapshotForTest;
  activateRuntimeSecretsSnapshot: ActivateRuntimeSecretsSnapshotForTest;
}) {
  return await prepareGatewayStartupConfig({
    configSnapshot: gatewaySecretRefSnapshot(),
    activateRuntimeSecrets: runtimeSecretsActivatorForTest(params),
  });
}

function expectBootstrapAuthResolvedGatewayToken(
  result: Awaited<ReturnType<typeof prepareGatewayStartupConfig>>,
): void {
  expect(result.auth).toMatchObject({
    mode: "token",
    token: RESOLVED_GATEWAY_TOKEN,
  });
}

async function expectImportedStartupConfigUsesFullSecretsRuntime(
  harness: ReturnType<typeof createGatewayStartupSecretsRuntimeHarness>,
  config: OpenClawConfig,
): Promise<void> {
  harness.install();

  try {
    await activateImportedStartupConfig(config);

    expect(harness.runtimeImport).toHaveBeenCalledTimes(1);
    expect(harness.prepareRuntimeSecretsSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.activateRuntimeSecretsSnapshot).toHaveBeenCalledTimes(1);
  } finally {
    harness.cleanup();
  }
}

describe("gateway startup config secret preflight", () => {
  const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
  const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
    if (previousSkipChannels === undefined) {
      delete process.env.OPENCLAW_SKIP_CHANNELS;
    } else {
      process.env.OPENCLAW_SKIP_CHANNELS = previousSkipChannels;
    }
    if (previousSkipProviders === undefined) {
      delete process.env.OPENCLAW_SKIP_PROVIDERS;
    } else {
      process.env.OPENCLAW_SKIP_PROVIDERS = previousSkipProviders;
    }
  });

  it("activates a prepared snapshot only while its expected predecessor is current", async () => {
    const initial = preparedSnapshot(gatewayTokenConfig({}));
    const refreshed = preparedSnapshotWithGatewayToken(initial.sourceConfig, "refreshed-token");
    const candidate = preparedSnapshotWithGatewayToken(initial.sourceConfig, "candidate-token");
    const activateRuntimeSecretsSnapshot = vi.fn(activateSecretsRuntimeSnapshotForTest);
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      prepareRuntimeSecretsSnapshot: vi.fn(async ({ config: preparedConfig }) =>
        preparedSnapshot(preparedConfig),
      ),
      activateRuntimeSecretsSnapshot,
    });
    activateSecretsRuntimeSnapshotForTest(initial);
    const initialRevision = getActiveSecretsRuntimeSnapshotRevision();
    activateSecretsRuntimeSnapshotForTest(refreshed);
    const refreshedRevision = getActiveSecretsRuntimeSnapshotRevision();

    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent?.(candidate, initialRevision, {
        reason: "reload",
        activate: true,
      }),
    ).resolves.toBeNull();
    expect(activateRuntimeSecretsSnapshot).not.toHaveBeenCalled();

    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent?.(candidate, refreshedRevision, {
        reason: "reload",
        activate: true,
      }),
    ).resolves.toBe(candidate);
    expect(activateRuntimeSecretsSnapshot).toHaveBeenCalledOnce();
  });

  it("signals degradation for a snapshot activated by an external CAS owner", async () => {
    const initial = preparedSnapshot(
      gatewayTokenConfig(
        asConfig({
          models: {
            providers: {
              openai: {
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                models: [],
              },
            },
          },
        }),
      ),
    );
    const candidate = {
      ...preparedSnapshotWithGatewayToken(initial.sourceConfig, "candidate-token"),
      degradedOwners: [
        {
          ownerKind: "provider" as const,
          ownerId: "openai",
          state: "unavailable" as const,
          degradationState: "stale" as const,
          paths: ["models.providers.openai.apiKey"],
          refKeys: ["env:default:OPENAI_API_KEY"],
          reason: "secret reference was not found",
        },
      ],
    };
    const emitStateEvent = vi.fn();
    const logSecrets = mockLogSecretsForTest();
    const activateRuntimeSecretsSnapshot = vi.fn();
    runtimeSecretsActivatorForTest({
      prepareRuntimeSecretsSnapshot: vi.fn(async ({ config: preparedConfig }) =>
        preparedSnapshot(preparedConfig),
      ),
      activateRuntimeSecretsSnapshot,
      emitStateEvent,
      logSecrets,
    });
    activateSecretsRuntimeSnapshotForTest(initial);
    const expectedRevision = getActiveSecretsRuntimeSnapshotRevision();
    const activateSnapshotIfCurrent = vi.fn(() => {
      activateSecretsRuntimeSnapshotForTest(candidate);
      return true;
    });

    await expect(
      activateProviderAuthRuntimeSnapshot({
        snapshot: candidate,
        expectedRevision,
        activateSnapshotIfCurrent,
      }),
    ).resolves.toBe(true);

    expect(activateSnapshotIfCurrent).toHaveBeenCalledOnce();
    expect(activateRuntimeSecretsSnapshot).not.toHaveBeenCalled();
    expect(emitStateEvent).toHaveBeenCalledWith(
      "SECRETS_RELOADER_DEGRADED",
      "Secret resolution degraded one or more owners; healthy owners were refreshed.",
      candidate.config,
    );
    expect(logSecrets.warn).toHaveBeenCalledWith(
      expect.stringContaining("[SECRETS_DEGRADED] stale provider:openai"),
      expect.objectContaining({ event: "secrets.degraded", state: "stale" }),
    );
  });

  it("does not recover an unrelated reload failure during provider-auth publication", async () => {
    const config = gatewayTokenConfig({});
    const initial = preparedSnapshot(config);
    const candidate = preparedSnapshot(config);
    const failure = new Error("gateway secret unavailable");
    associateSecretResolutionErrorOwners(failure, [
      {
        ownerKind: "gateway",
        ownerId: "ingress-auth",
        state: "unavailable",
        paths: ["gateway.auth.token"],
        refKeys: ["env:default:GATEWAY_TOKEN"],
        reason: "secret reference was not found",
        degradationState: "cold",
        failureMatched: true,
        source: "config",
      },
    ]);
    const emitStateEvent = vi.fn();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      emitStateEvent,
      prepareRuntimeSecretsSnapshot: vi.fn(async () => {
        throw failure;
      }),
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
    });
    activateSecretsRuntimeSnapshotForTest(initial);

    await expect(
      activateRuntimeSecrets(config, {
        reason: "reload",
        activate: false,
        publishFailureAsDegraded: true,
      }),
    ).rejects.toThrow(failure.message);
    const expectedRevision = getActiveSecretsRuntimeSnapshotRevision();
    await expect(
      activateProviderAuthRuntimeSnapshot({
        snapshot: candidate,
        expectedRevision,
        activateSnapshotIfCurrent: () => {
          activateSecretsRuntimeSnapshotForTest(candidate);
          return true;
        },
      }),
    ).resolves.toBe(true);

    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual(["SECRETS_RELOADER_DEGRADED"]);
  });

  it("promotes provider-auth degradation when a later full reload fails", async () => {
    const config = gatewayTokenConfig(
      asConfig({ models: { providers: { openai: { apiKey: "fixture", models: [] } } } }),
    );
    const initial = preparedSnapshot(config);
    const providerDegraded = {
      ...preparedSnapshot(config),
      degradedOwners: [
        {
          ownerKind: "provider" as const,
          ownerId: "openai",
          state: "unavailable" as const,
          paths: ["models.providers.openai.apiKey"],
          refKeys: ["env:default:OPENAI_API_KEY"],
          reason: "secret provider failed" as const,
          degradationState: "stale" as const,
        },
      ],
    };
    const failure = new Error("gateway secret unavailable");
    associateSecretResolutionErrorOwners(failure, [
      {
        ownerKind: "gateway",
        ownerId: "ingress-auth",
        state: "unavailable",
        paths: ["gateway.auth.token"],
        refKeys: ["env:default:GATEWAY_TOKEN"],
        reason: "secret reference was not found",
        degradationState: "cold",
        failureMatched: true,
        source: "config",
      },
    ]);
    const emitStateEvent = vi.fn();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      emitStateEvent,
      prepareRuntimeSecretsSnapshot: vi.fn(async () => {
        throw failure;
      }),
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
    });
    activateSecretsRuntimeSnapshotForTest(initial);

    await activateProviderAuthRuntimeSnapshot({
      snapshot: providerDegraded,
      expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
      activateSnapshotIfCurrent: () => {
        activateSecretsRuntimeSnapshotForTest(providerDegraded);
        return true;
      },
    });
    await expect(
      activateRuntimeSecrets(config, {
        reason: "reload",
        activate: false,
        publishFailureAsDegraded: true,
      }),
    ).rejects.toThrow(failure.message);
    const recovered = preparedSnapshot(config);
    await activateProviderAuthRuntimeSnapshot({
      snapshot: recovered,
      expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
      activateSnapshotIfCurrent: () => {
        activateSecretsRuntimeSnapshotForTest(recovered);
        return true;
      },
    });

    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual(["SECRETS_RELOADER_DEGRADED"]);
  });

  it("does not publish web-tool degradation as provider-auth state", async () => {
    const config = gatewayTokenConfig({});
    const candidate = {
      ...preparedSnapshot(config),
      degradedOwners: [
        {
          ownerKind: "provider" as const,
          ownerId: "web-search:external",
          state: "unavailable" as const,
          paths: ["plugins.entries.external.config.webSearch.apiKey"],
          refKeys: ["env:default:EXTERNAL_SEARCH_REF"],
          reason: "secret provider failed" as const,
          degradationState: "stale" as const,
        },
      ],
    };
    const emitStateEvent = vi.fn();
    runtimeSecretsActivatorForTest({
      emitStateEvent,
      prepareRuntimeSecretsSnapshot: vi.fn(),
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
    });
    activateSecretsRuntimeSnapshotForTest(candidate);

    await expect(
      activateProviderAuthRuntimeSnapshot({
        snapshot: candidate,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        activateSnapshotIfCurrent: () => true,
      }),
    ).resolves.toBe(true);

    expect(emitStateEvent).not.toHaveBeenCalled();
  });

  it("recovers provider-only degradation from a full reload through auth refresh", async () => {
    const config = gatewayTokenConfig(
      asConfig({ models: { providers: { openai: { apiKey: "fixture", models: [] } } } }),
    );
    const initial = preparedSnapshot(config);
    const providerDegraded = {
      ...preparedSnapshot(config),
      degradedOwners: [
        {
          ownerKind: "provider" as const,
          ownerId: "openai",
          state: "unavailable" as const,
          paths: ["models.providers.openai.apiKey"],
          refKeys: ["env:default:OPENAI_API_KEY"],
          reason: "secret provider failed" as const,
          degradationState: "stale" as const,
        },
      ],
    };
    const emitStateEvent = vi.fn();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      emitStateEvent,
      prepareRuntimeSecretsSnapshot: vi.fn(async () => providerDegraded),
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
    });
    activateSecretsRuntimeSnapshotForTest(initial);

    await activateRuntimeSecrets(config, { reason: "reload", activate: true });
    const recovered = preparedSnapshot(config);
    await activateProviderAuthRuntimeSnapshot({
      snapshot: recovered,
      expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
      activateSnapshotIfCurrent: () => {
        activateSecretsRuntimeSnapshotForTest(recovered);
        return true;
      },
    });

    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([
      "SECRETS_RELOADER_DEGRADED",
      "SECRETS_RELOADER_RECOVERED",
    ]);
  });

  it("narrows full degradation when a committed reload leaves only provider owners", async () => {
    const config = gatewayTokenConfig(
      asConfig({ models: { providers: { openai: { apiKey: "fixture", models: [] } } } }),
    );
    const initial = preparedSnapshot(config);
    const providerDegraded = {
      ...preparedSnapshot(config),
      degradedOwners: [
        {
          ownerKind: "provider" as const,
          ownerId: "openai",
          state: "unavailable" as const,
          paths: ["models.providers.openai.apiKey"],
          refKeys: ["env:default:OPENAI_API_KEY"],
          reason: "secret provider failed" as const,
          degradationState: "stale" as const,
        },
      ],
    };
    const fullFailure = new Error("gateway secret unavailable");
    associateSecretResolutionErrorOwners(fullFailure, [
      {
        ownerKind: "gateway",
        ownerId: "ingress-auth",
        state: "unavailable",
        paths: ["gateway.auth.token"],
        refKeys: ["env:default:GATEWAY_TOKEN"],
        reason: "secret reference was not found",
        degradationState: "cold",
        failureMatched: true,
        source: "config",
      },
    ]);
    const emitStateEvent = vi.fn();
    const prepareRuntimeSecretsSnapshot = vi
      .fn<PrepareRuntimeSecretsSnapshotForTest>()
      .mockRejectedValueOnce(fullFailure)
      .mockResolvedValueOnce(providerDegraded);
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      emitStateEvent,
      prepareRuntimeSecretsSnapshot,
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
    });
    activateSecretsRuntimeSnapshotForTest(initial);

    await expect(
      activateRuntimeSecrets(config, {
        reason: "reload",
        activate: false,
        publishFailureAsDegraded: true,
      }),
    ).rejects.toThrow(fullFailure.message);
    await activateRuntimeSecrets(config, { reason: "reload", activate: true });
    const recovered = preparedSnapshot(config);
    await activateProviderAuthRuntimeSnapshot({
      snapshot: recovered,
      expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
      activateSnapshotIfCurrent: () => {
        activateSecretsRuntimeSnapshotForTest(recovered);
        return true;
      },
    });

    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([
      "SECRETS_RELOADER_DEGRADED",
      "SECRETS_RELOADER_RECOVERED",
    ]);
  });

  it("publishes prepared degradation only after the reload transaction commits", async () => {
    const initial = preparedSnapshot(gatewayTokenConfig({}));
    const degradedSnapshot = (token: string): PreparedSecretsRuntimeSnapshot => ({
      ...preparedSnapshotWithGatewayToken(initial.sourceConfig, token),
      warnings: [
        {
          code: "SECRETS_OWNER_UNAVAILABLE",
          path: "models.providers.openai.apiKey",
          message: "Secret owner provider:openai is using last-known-good.",
        },
      ],
      degradedOwners: [
        {
          ownerKind: "provider",
          ownerId: "openai",
          state: "unavailable",
          degradationState: "stale",
          paths: ["models.providers.openai.apiKey"],
          refKeys: ["env:default:OPENAI_API_KEY"],
          reason: "secret reference was not found",
        },
      ],
    });
    const rolledBackCandidate = degradedSnapshot("rolled-back-token");
    const committedCandidate = degradedSnapshot("committed-token");
    const emitStateEvent = vi.fn();
    const logSecrets = mockLogSecretsForTest();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      prepareRuntimeSecretsSnapshot: vi.fn(async ({ config }) => preparedSnapshot(config)),
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
      emitStateEvent,
      logSecrets,
    });
    activateSecretsRuntimeSnapshotForTest(initial);

    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent?.(
        rolledBackCandidate,
        getActiveSecretsRuntimeSnapshotRevision(),
        { reason: "reload", activate: true, deferStatePublication: true },
      ),
    ).resolves.toBe(rolledBackCandidate);
    expect(emitStateEvent).not.toHaveBeenCalled();
    expect(logSecrets.warn).not.toHaveBeenCalled();

    activateSecretsRuntimeSnapshotForTest(initial);
    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent?.(
        committedCandidate,
        getActiveSecretsRuntimeSnapshotRevision(),
        { reason: "reload", activate: true, deferStatePublication: true },
      ),
    ).resolves.toBe(committedCandidate);
    expect(emitStateEvent).not.toHaveBeenCalled();
    expect(logSecrets.warn).not.toHaveBeenCalled();

    publishRuntimeSecretsStateTransition(activateRuntimeSecrets, rolledBackCandidate);
    expect(emitStateEvent).not.toHaveBeenCalled();
    expect(logSecrets.warn).not.toHaveBeenCalled();

    publishRuntimeSecretsStateTransition(activateRuntimeSecrets, committedCandidate);
    expect(emitStateEvent).toHaveBeenCalledOnce();
    expect(emitStateEvent).toHaveBeenCalledWith(
      "SECRETS_RELOADER_DEGRADED",
      "Secret resolution degraded one or more owners; healthy owners were refreshed.",
      committedCandidate.config,
    );
    expect(logSecrets.warn).toHaveBeenCalledTimes(2);
    expect(logSecrets.warn).toHaveBeenCalledWith(
      "[SECRETS_OWNER_UNAVAILABLE] Secret owner provider:openai is using last-known-good.",
    );
    expect(logSecrets.warn).toHaveBeenCalledWith(
      expect.stringContaining("[SECRETS_DEGRADED] stale provider:openai"),
      expect.objectContaining({ event: "secrets.degraded", state: "stale" }),
    );
  });

  it("publishes deferred degradation after a provider-auth descendant activation", async () => {
    const config = gatewayTokenConfig(
      asConfig({ models: { providers: { openai: { apiKey: "fixture", models: [] } } } }),
    );
    const initial = preparedSnapshot(config);
    const degraded = {
      ...preparedSnapshot(initial.sourceConfig),
      degradedOwners: [
        {
          ownerKind: "capability" as const,
          ownerId: "tts",
          state: "unavailable" as const,
          degradationState: "cold" as const,
          paths: ["messages.tts.providers.elevenlabs.apiKey"],
          refKeys: ["env:default:ELEVENLABS_API_KEY"],
          reason: "secret reference was not found" as const,
        },
      ],
    };
    const emitStateEvent = vi.fn();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      emitStateEvent,
      prepareRuntimeSecretsSnapshot: vi.fn(async ({ config: preparedConfig }) =>
        preparedSnapshot(preparedConfig),
      ),
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
    });
    activateSecretsRuntimeSnapshotForTest(initial);
    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent?.(
        degraded,
        getActiveSecretsRuntimeSnapshotRevision(),
        { reason: "reload", activate: true, deferStatePublication: true },
      ),
    ).resolves.toBe(degraded);
    const outerRevision = getActiveSecretsRuntimeSnapshotRevision();
    const descendant: PreparedSecretsRuntimeSnapshot = structuredClone(degraded);
    descendant.degradedOwners?.push({
      ownerKind: "provider",
      ownerId: "openai",
      state: "unavailable",
      degradationState: "stale",
      paths: ["models.providers.openai.apiKey"],
      refKeys: ["env:default:OPENAI_API_KEY"],
      reason: "secret reference was not found",
    });

    await expect(
      activateProviderAuthRuntimeSnapshot({
        snapshot: descendant,
        expectedRevision: outerRevision,
        activateSnapshotIfCurrent: () =>
          activateSecretsRuntimeSnapshotStateIfCurrent({
            snapshot: descendant,
            expectedRevision: outerRevision,
            refreshContext: null,
            refreshHandler: null,
            preserveActivationLineage: true,
          }),
      }),
    ).resolves.toBe(true);
    expect(emitStateEvent).not.toHaveBeenCalled();

    publishRuntimeSecretsStateTransition(activateRuntimeSecrets, degraded);
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual(["SECRETS_RELOADER_DEGRADED"]);
  });

  it("does not publish stale degradation after a provider-auth descendant recovers", async () => {
    const config = gatewayTokenConfig(
      asConfig({ models: { providers: { openai: { apiKey: "fixture", models: [] } } } }),
    );
    const initial = preparedSnapshot(config);
    const degraded = {
      ...preparedSnapshot(config),
      degradedOwners: [
        {
          ownerKind: "provider" as const,
          ownerId: "openai",
          state: "unavailable" as const,
          degradationState: "stale" as const,
          paths: ["models.providers.openai.apiKey"],
          refKeys: ["env:default:OPENAI_API_KEY"],
          reason: "secret reference was not found" as const,
        },
      ],
    };
    const emitStateEvent = vi.fn();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      emitStateEvent,
      prepareRuntimeSecretsSnapshot: vi.fn(async ({ config: candidate }) =>
        preparedSnapshot(candidate),
      ),
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
    });
    activateSecretsRuntimeSnapshotForTest(initial);
    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent?.(
        degraded,
        getActiveSecretsRuntimeSnapshotRevision(),
        { reason: "reload", activate: true, deferStatePublication: true },
      ),
    ).resolves.toBe(degraded);
    const outerRevision = getActiveSecretsRuntimeSnapshotRevision();
    const recovered = preparedSnapshot(config);

    await expect(
      activateProviderAuthRuntimeSnapshot({
        snapshot: recovered,
        expectedRevision: outerRevision,
        activateSnapshotIfCurrent: () =>
          activateSecretsRuntimeSnapshotStateIfCurrent({
            snapshot: recovered,
            expectedRevision: outerRevision,
            refreshContext: null,
            refreshHandler: null,
            preserveActivationLineage: true,
          }),
      }),
    ).resolves.toBe(true);

    publishRuntimeSecretsStateTransition(activateRuntimeSecrets, degraded);
    expect(emitStateEvent).not.toHaveBeenCalled();
  });

  it("recovers prior full degradation when a deferred degraded snapshot is healed", async () => {
    const config = gatewayTokenConfig(
      asConfig({ models: { providers: { openai: { apiKey: "fixture", models: [] } } } }),
    );
    const initial = preparedSnapshot(config);
    const fullDegraded = {
      ...preparedSnapshot(config),
      degradedOwners: [
        {
          ownerKind: "capability" as const,
          ownerId: "tts",
          state: "unavailable" as const,
          degradationState: "cold" as const,
          paths: ["messages.tts.providers.elevenlabs.apiKey"],
          refKeys: ["env:default:ELEVENLABS_API_KEY"],
          reason: "secret reference was not found" as const,
        },
      ],
    };
    const providerDegraded = {
      ...preparedSnapshot(config),
      degradedOwners: [
        {
          ownerKind: "provider" as const,
          ownerId: "openai",
          state: "unavailable" as const,
          degradationState: "stale" as const,
          paths: ["models.providers.openai.apiKey"],
          refKeys: ["env:default:OPENAI_API_KEY"],
          reason: "secret reference was not found" as const,
        },
      ],
    };
    const emitStateEvent = vi.fn();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      emitStateEvent,
      prepareRuntimeSecretsSnapshot: vi.fn(async ({ config: candidate }) =>
        preparedSnapshot(candidate),
      ),
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
    });
    activateSecretsRuntimeSnapshotForTest(initial);
    await activateRuntimeSecrets.activatePreparedSnapshot?.(fullDegraded, {
      reason: "reload",
      activate: true,
    });
    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent?.(
        providerDegraded,
        getActiveSecretsRuntimeSnapshotRevision(),
        { reason: "reload", activate: true, deferStatePublication: true },
      ),
    ).resolves.toBe(providerDegraded);
    const outerRevision = getActiveSecretsRuntimeSnapshotRevision();
    const recovered = preparedSnapshot(config);

    await expect(
      activateProviderAuthRuntimeSnapshot({
        snapshot: recovered,
        expectedRevision: outerRevision,
        activateSnapshotIfCurrent: () =>
          activateSecretsRuntimeSnapshotStateIfCurrent({
            snapshot: recovered,
            expectedRevision: outerRevision,
            refreshContext: null,
            refreshHandler: null,
            preserveActivationLineage: true,
          }),
      }),
    ).resolves.toBe(true);
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual(["SECRETS_RELOADER_DEGRADED"]);

    publishRuntimeSecretsStateTransition(activateRuntimeSecrets, providerDegraded);
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([
      "SECRETS_RELOADER_DEGRADED",
      "SECRETS_RELOADER_RECOVERED",
    ]);
  });

  it("publishes deferred recovery after a provider-auth descendant activation", async () => {
    const config = gatewayTokenConfig(
      asConfig({ models: { providers: { openai: { apiKey: "fixture", models: [] } } } }),
    );
    const initial = preparedSnapshot(config);
    const degraded = {
      ...preparedSnapshot(initial.sourceConfig),
      degradedOwners: [
        {
          ownerKind: "provider" as const,
          ownerId: "openai",
          state: "unavailable" as const,
          degradationState: "stale" as const,
          paths: ["models.providers.openai.apiKey"],
          refKeys: ["env:default:OPENAI_API_KEY"],
          reason: "secret reference was not found" as const,
        },
      ],
    };
    const recovered = preparedSnapshot(config);
    const emitStateEvent = vi.fn();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      emitStateEvent,
      prepareRuntimeSecretsSnapshot: vi.fn(async ({ config: preparedConfig }) =>
        preparedSnapshot(preparedConfig),
      ),
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
    });
    activateSecretsRuntimeSnapshotForTest(initial);
    await activateRuntimeSecrets.activatePreparedSnapshot?.(degraded, {
      reason: "reload",
      activate: true,
    });
    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent?.(
        recovered,
        getActiveSecretsRuntimeSnapshotRevision(),
        { reason: "reload", activate: true, deferStatePublication: true },
      ),
    ).resolves.toBe(recovered);
    const outerRevision = getActiveSecretsRuntimeSnapshotRevision();
    const descendant = structuredClone(recovered);

    await expect(
      activateProviderAuthRuntimeSnapshot({
        snapshot: descendant,
        expectedRevision: outerRevision,
        activateSnapshotIfCurrent: () =>
          activateSecretsRuntimeSnapshotStateIfCurrent({
            snapshot: descendant,
            expectedRevision: outerRevision,
            refreshContext: null,
            refreshHandler: null,
            preserveActivationLineage: true,
          }),
      }),
    ).resolves.toBe(true);
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual(["SECRETS_RELOADER_DEGRADED"]);

    publishRuntimeSecretsStateTransition(activateRuntimeSecrets, recovered);
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([
      "SECRETS_RELOADER_DEGRADED",
      "SECRETS_RELOADER_RECOVERED",
    ]);
  });

  it("publishes source-only recovery after a provider-auth descendant activation", async () => {
    const stableConfig = gatewayTokenConfig({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "env", provider: "default", id: "OPENAI_STABLE" },
            models: [],
          },
        },
      },
    });
    const failedConfig = structuredClone(stableConfig);
    failedConfig.models!.providers!.openai!.apiKey = {
      source: "env",
      provider: "default",
      id: "OPENAI_CHANGED",
    };
    const failure = new Error("provider secret unavailable");
    associateSecretResolutionErrorOwners(failure, [
      {
        ownerKind: "provider",
        ownerId: "openai",
        state: "unavailable",
        paths: ["models.providers.openai.apiKey"],
        refKeys: ["env:default:OPENAI_CHANGED"],
        reason: "secret reference was not found",
        degradationState: "cold",
        failureMatched: true,
        source: "config",
      },
    ]);
    const emitStateEvent = vi.fn();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      emitStateEvent,
      prepareRuntimeSecretsSnapshot: vi.fn(async () => {
        throw failure;
      }),
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
    });
    const initial = preparedSnapshot(stableConfig);
    activateSecretsRuntimeSnapshotForTest(initial);
    await expect(
      activateRuntimeSecrets(failedConfig, {
        reason: "reload",
        activate: false,
        publishFailureAsDegraded: true,
      }),
    ).rejects.toBe(failure);

    const sourceOnly = preparedSnapshot(stableConfig);
    activateSecretsRuntimeSnapshotForTest(sourceOnly);
    const committedRevision = getActiveSecretsRuntimeSnapshotRevision();
    const descendant = structuredClone(sourceOnly);
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: descendant,
        expectedRevision: committedRevision,
        refreshContext: null,
        refreshHandler: null,
        preserveActivationLineage: true,
      }),
    ).toBe(true);

    publishRuntimeSecretsStateTransition(activateRuntimeSecrets, sourceOnly, {
      sourceOnly: true,
      expectedRevision: committedRevision,
    });
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([
      "SECRETS_RELOADER_DEGRADED",
      "SECRETS_RELOADER_RECOVERED",
    ]);
  });

  it("rejects a managed reload prepared before an OAuth credential mutation", async () => {
    const agentDir = "/tmp/openclaw-managed-auth-store-cas";
    const initial = preparedSnapshot(gatewayTokenConfig({}));
    const candidate: PreparedSecretsRuntimeSnapshot = {
      ...preparedSnapshotWithGatewayToken(initial.sourceConfig, "candidate-token"),
      authStores: [
        {
          agentDir,
          store: {
            version: 1,
            profiles: {
              "openai:default": {
                type: "oauth",
                provider: "openai",
                access: "access-old",
                refresh: "refresh-old",
                expires: Date.now() + 60_000,
              },
            },
          },
        },
      ],
    };
    const activateRuntimeSecretsSnapshot = vi.fn(activateSecretsRuntimeSnapshotForTest);
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      prepareRuntimeSecretsSnapshot: vi.fn(async ({ config }) => preparedSnapshot(config)),
      activateRuntimeSecretsSnapshot,
    });
    activateSecretsRuntimeSnapshotForTest(initial);
    const initialRevision = getActiveSecretsRuntimeSnapshotRevision();
    setRuntimeAuthProfileStoreSnapshot(
      {
        version: 1,
        profiles: {
          "openai:default": {
            type: "oauth",
            provider: "openai",
            access: "access-new",
            refresh: "refresh-new",
            expires: Date.now() + 120_000,
          },
        },
      },
      agentDir,
    );

    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent?.(candidate, initialRevision, {
        reason: "reload",
        activate: true,
      }),
    ).resolves.toBeNull();
    expect(activateRuntimeSecretsSnapshot).not.toHaveBeenCalled();
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:default"]).toMatchObject({
      access: "access-new",
      refresh: "refresh-new",
    });
  });

  it("holds activation ownership through the accepted publication callback", async () => {
    const initial = preparedSnapshot(gatewayTokenConfig({}));
    const candidate = preparedSnapshotWithGatewayToken(initial.sourceConfig, "candidate-token");
    const later = preparedSnapshotWithGatewayToken(initial.sourceConfig, "later-token");
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      prepareRuntimeSecretsSnapshot: vi.fn(async ({ config }) => preparedSnapshot(config)),
      activateRuntimeSecretsSnapshot: vi.fn(activateSecretsRuntimeSnapshotForTest),
    });
    activateSecretsRuntimeSnapshotForTest(initial);
    const initialRevision = getActiveSecretsRuntimeSnapshotRevision();
    let releasePublication: (() => void) | undefined;
    const publicationBlocked = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    let publicationStarted: (() => void) | undefined;
    const publicationEntered = new Promise<void>((resolve) => {
      publicationStarted = resolve;
    });

    const candidateActivation = activateRuntimeSecrets.activatePreparedSnapshotIfCurrent?.(
      candidate,
      initialRevision,
      { reason: "reload", activate: true },
      async () => {
        publicationStarted?.();
        await publicationBlocked;
      },
    );
    await publicationEntered;
    let laterActivated = false;
    const laterActivation = activateRuntimeSecrets
      .activatePreparedSnapshot?.(later, { reason: "reload", activate: true })
      .then(() => {
        laterActivated = true;
      });
    await Promise.resolve();
    expect(laterActivated).toBe(false);

    releasePublication?.();
    await candidateActivation;
    await laterActivation;
    expect(getActiveSecretsRuntimeSnapshot()?.config.gateway?.auth?.token).toBe("later-token");
  });

  it("measures startup auth subphases", async () => {
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => preparedSnapshot(config));
    const measured: string[] = [];

    await prepareGatewayStartupConfig({
      configSnapshot: buildSnapshot(gatewayTokenConfig({})),
      activateRuntimeSecrets: runtimeSecretsActivatorForTest({
        prepareRuntimeSecretsSnapshot,
      }),
      measure: async (name, run) => {
        measured.push(name);
        return await run();
      },
    });

    expect(measured).toEqual([
      "config.auth.snapshot-validate",
      "config.auth.runtime-overrides",
      "config.auth.startup-overrides",
      "config.auth.secret-surface",
      "config.auth.secret-preflight",
      "config.auth.preflight-override",
      "config.auth.ensure",
      "config.auth.runtime-startup-overrides",
      "config.auth.secrets-activate",
    ]);
  });

  it("emits sanitized diagnostics timeline spans for secrets preparation", async () => {
    const timelineEnv = installDiagnosticsTimelineEnv();
    try {
      const config = gatewaySecretRefSnapshot().config;
      const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config: preparedConfig }) =>
        preparedSnapshot(preparedConfig),
      );

      const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
        prepareRuntimeSecretsSnapshot,
      });

      await activateRuntimeSecrets(config, { reason: "startup", activate: false });

      const events = readTimelineEvents(timelineEnv.timelinePath);
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.type)).toEqual(["span.start", "span.end"]);
      for (const event of events) {
        expect(event.name).toBe("secrets.prepare");
        expect(event.phase).toBe("startup");
        expect(event.attributes).toEqual({
          activate: false,
          gatewayAuthSecretRef: true,
          reason: "startup",
        });
      }
      expect(JSON.stringify(events)).not.toContain("GATEWAY_TOKEN_REF");
    } finally {
      timelineEnv.cleanup();
    }
  });

  it("omits secret preparation error messages from diagnostics timeline spans", async () => {
    const timelineEnv = installDiagnosticsTimelineEnv();
    try {
      const prepareRuntimeSecretsSnapshot = vi.fn(async () => {
        throw new Error('Secret provider "default" is not configured for GATEWAY_TOKEN_REF.');
      });

      const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
        prepareRuntimeSecretsSnapshot,
      });

      await expect(
        prepareGatewayStartupConfig({
          configSnapshot: gatewaySecretRefSnapshot(),
          activateRuntimeSecrets,
          measure: (name, run, options) =>
            measureDiagnosticsTimelineSpan(name, run, {
              env: process.env,
              omitErrorMessage: options?.omitErrorMessage,
              phase: "startup",
            }),
        }),
      ).rejects.toThrow("Startup failed: required secrets are unavailable.");

      const events = readTimelineEvents(timelineEnv.timelinePath);
      const errorEvents = events.filter((event) => event.type === "span.error");
      expect(errorEvents.map((event) => event.name)).toEqual([
        "secrets.prepare",
        "config.auth.secret-preflight",
      ]);
      for (const event of errorEvents) {
        expect(event.phase).toBe("startup");
        expect(event.errorName).toBe("Error");
        expect(event.errorMessage).toBeUndefined();
      }
      expect(JSON.stringify(events)).not.toContain("GATEWAY_TOKEN_REF");
      expect(JSON.stringify(events)).not.toContain("default");
    } finally {
      timelineEnv.cleanup();
    }
  });

  it("wraps startup secret activation failures without emitting reload state events", async () => {
    const error = refResolutionError({
      code: "SECRET_REF_NOT_FOUND",
      source: "env",
      provider: "default",
      refId: "PRIVATE_STARTUP_AUTH_REF",
      message: 'Environment variable "PRIVATE_STARTUP_AUTH_REF" is missing or empty.',
    });
    associateSecretResolutionErrorOwners(error, [
      {
        ownerKind: "gateway",
        ownerId: "auth",
        state: "unavailable",
        paths: ["gateway.auth.token"],
        refKeys: ["env:default:PRIVATE_STARTUP_AUTH_REF"],
        reason: "secret reference was not found",
        degradationState: "cold",
        failureMatched: true,
        source: "config",
      },
    ]);
    const prepareRuntimeSecretsSnapshot = vi.fn(async () => {
      throw error;
    });
    const emitStateEvent = vi.fn();
    const logSecrets = mockLogSecretsForTest();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      emitStateEvent,
      logSecrets,
      prepareRuntimeSecretsSnapshot,
    });

    const startupFailure = await activateRuntimeSecrets(gatewayTokenConfig({}), {
      reason: "startup",
      activate: false,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(startupFailure).toBeInstanceOf(Error);
    expect(String(startupFailure)).toBe("Error: Startup failed: required secrets are unavailable.");
    expect((startupFailure as Error).cause).toBeUndefined();
    expect(String(startupFailure)).not.toContain("PRIVATE_STARTUP_AUTH_REF");
    expect(logSecrets.warn).toHaveBeenCalledWith(
      "[SECRETS_DEGRADED] cold gateway:auth: secret reference was not found. " +
        "Retry: openclaw secrets reload.",
      {
        event: "secrets.degraded",
        ownerKind: "gateway",
        ownerId: "auth",
        reason: "secret reference was not found",
        state: "cold",
        retryHint: "openclaw secrets reload",
      },
    );
    expect(JSON.stringify(logSecrets.warn.mock.calls)).not.toContain("PRIVATE_STARTUP_AUTH_REF");
    expect(emitStateEvent).not.toHaveBeenCalled();
  });

  it("preserves diagnostics for unclassified startup activation failures", async () => {
    const error = new Error("secret provider transport failed");
    const logSecrets = mockLogSecretsForTest();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      logSecrets,
      prepareRuntimeSecretsSnapshot: vi.fn(async () => {
        throw error;
      }),
    });

    const startupFailure = await activateRuntimeSecrets(gatewayTokenConfig({}), {
      reason: "startup",
      activate: false,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(String(startupFailure)).toContain("secret provider transport failed");
    expect((startupFailure as Error).cause).toBe(error);
    expect(logSecrets.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("SECRETS_DEGRADED"),
      expect.anything(),
    );
  });

  it("allows cold startup snapshots with isolated SecretRef owners", async () => {
    const sourceConfig = gatewayTokenConfig({
      messages: {
        tts: {
          providers: {
            elevenlabs: {
              apiKey: { source: "env", provider: "default", id: "ELEVENLABS_API_KEY" },
            },
          },
        },
      },
    });
    const warning: SecretResolverWarning = {
      code: "SECRETS_OWNER_UNAVAILABLE",
      path: "messages.tts.providers.elevenlabs.apiKey",
      message:
        "Secret owner capability:tts is configured-unavailable; paths: messages.tts.providers.elevenlabs.apiKey; reason: secret provider policy denied resolution.",
    };
    const prepareRuntimeSecretsSnapshot = vi.fn(async () => ({
      ...preparedSnapshot(sourceConfig),
      config: structuredClone(sourceConfig),
      warnings: [warning],
      degradedOwners: [
        {
          ownerKind: "capability" as const,
          ownerId: "tts",
          state: "unavailable" as const,
          paths: ["messages.tts.providers.elevenlabs.apiKey"],
          refKeys: ["env:default:ELEVENLABS_API_KEY"],
          reason: "secret provider policy denied resolution",
        },
      ],
    }));
    const emitStateEvent = vi.fn();
    const logSecrets = mockLogSecretsForTest();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      emitStateEvent,
      logSecrets,
      prepareRuntimeSecretsSnapshot,
    });

    const result = await activateRuntimeSecrets(sourceConfig, {
      reason: "startup",
      activate: true,
    });

    expect(result.config.messages?.tts?.providers?.elevenlabs?.apiKey).toEqual(
      sourceConfig.messages?.tts?.providers?.elevenlabs?.apiKey,
    );
    expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ allowUnavailableSecretOwners: true }),
    );
    expect(logSecrets.warn).toHaveBeenCalledWith(`[${warning.code}] ${warning.message}`);
    expect(logSecrets.warn).toHaveBeenCalledWith(
      "[SECRETS_DEGRADED] cold capability:tts: secret provider policy denied resolution. " +
        "Retry: openclaw secrets reload.",
      {
        event: "secrets.degraded",
        ownerKind: "capability",
        ownerId: "tts",
        reason: "secret provider policy denied resolution",
        state: "cold",
        retryHint: "openclaw secrets reload",
      },
    );
    expect(JSON.stringify(logSecrets.warn.mock.calls)).not.toContain("ELEVENLABS_API_KEY");
    expect(emitStateEvent).not.toHaveBeenCalled();
  });

  it("publishes one provider outage diagnostic with its affected owner list", async () => {
    const sourceConfig = gatewayTokenConfig({});
    const providerFailures = [{ source: "exec" as const, provider: "vault" }];
    const prepared = {
      ...preparedSnapshot(sourceConfig),
      warnings: [
        {
          code: "SECRETS_OWNER_UNAVAILABLE" as const,
          path: "models.providers.openai.apiKey",
          message: "Secret owner provider:openai is configured-unavailable.",
        },
        {
          code: "SECRETS_OWNER_UNAVAILABLE" as const,
          path: "messages.tts.providers.elevenlabs.apiKey",
          message: "Secret owner capability:tts is configured-unavailable.",
        },
      ],
      degradedOwners: [
        {
          ownerKind: "provider" as const,
          ownerId: "openai",
          state: "unavailable" as const,
          degradationState: "cold" as const,
          paths: ["models.providers.openai.apiKey"],
          refKeys: ["exec:vault:models/openai"],
          reason: "secret provider failed",
          providerFailures,
        },
        {
          ownerKind: "capability" as const,
          ownerId: "tts",
          state: "unavailable" as const,
          degradationState: "stale" as const,
          paths: ["messages.tts.providers.elevenlabs.apiKey"],
          refKeys: ["exec:vault:tts/elevenlabs"],
          reason: "secret provider failed",
          providerFailures,
        },
      ],
    };
    const logSecrets = mockLogSecretsForTest();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      logSecrets,
      prepareRuntimeSecretsSnapshot: vi.fn(async () => prepared),
    });

    await activateRuntimeSecrets(sourceConfig, { reason: "startup", activate: true });

    expect(logSecrets.warn).toHaveBeenCalledOnce();
    expect(logSecrets.warn).toHaveBeenCalledWith(
      "[SECRETS_PROVIDER_DEGRADED] exec:vault: secret provider failed. " +
        "Affected owners: stale capability:tts, cold provider:openai. " +
        "Retry: openclaw secrets reload.",
      {
        event: "secrets.provider_degraded",
        source: "exec",
        provider: "vault",
        reason: "secret provider failed",
        affectedOwners: [
          { ownerKind: "capability", ownerId: "tts", state: "stale" },
          { ownerKind: "provider", ownerId: "openai", state: "cold" },
        ],
        retryHint: "openclaw secrets reload",
      },
    );
  });

  it.each(["reload", "restart-check"] as const)(
    "does not classify untyped %s errors as secret degradation",
    async (reason) => {
      activateSecretsRuntimeSnapshotForTest(preparedSnapshot(gatewayTokenConfig({})));
      const missingSecretError = new Error(
        'Environment variable "ELEVENLABS_API_KEY" is missing or empty.',
      );
      const prepareRuntimeSecretsSnapshot = vi.fn(async () => {
        throw missingSecretError;
      });
      const activateRuntimeSecretsSnapshot = vi.fn();
      const emitStateEvent = vi.fn();
      const logSecrets = mockLogSecretsForTest();
      const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
        prepareRuntimeSecretsSnapshot,
        activateRuntimeSecretsSnapshot,
        emitStateEvent,
        logSecrets,
      });

      await expect(
        activateRuntimeSecrets(gatewayTokenConfig({}), {
          reason,
          activate: false,
          publishFailureAsDegraded: true,
        }),
      ).rejects.toThrow(missingSecretError.message);

      expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ allowUnavailableSecretOwners: true }),
      );
      expect(activateRuntimeSecretsSnapshot).not.toHaveBeenCalled();
      expect(logSecrets.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("SECRETS_DEGRADED"),
        expect.anything(),
      );
      expect(emitStateEvent).not.toHaveBeenCalled();
    },
  );

  it.each(["reload", "restart-check"] as const)(
    "rejects invalid resolved values without publishing degradation during %s",
    async (reason) => {
      activateSecretsRuntimeSnapshotForTest(preparedSnapshot(gatewayTokenConfig({})));
      const invalidSecretError = new Error(
        "messages.tts.providers.elevenlabs.apiKey resolved to a non-string or empty value.",
      );
      associateSecretResolutionErrorOwners(invalidSecretError, [
        {
          ownerKind: "capability",
          ownerId: "tts",
          state: "unavailable",
          paths: ["messages.tts.providers.elevenlabs.apiKey"],
          refKeys: ["file:ttsfile:/private/value"],
          reason: "resolved secret value was invalid",
          degradationState: "stale",
          failureMatched: true,
          source: "config",
        },
      ]);
      const prepareRuntimeSecretsSnapshot = vi.fn(async () => {
        throw invalidSecretError;
      });
      const emitStateEvent = vi.fn();
      const logSecrets = mockLogSecretsForTest();
      const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
        prepareRuntimeSecretsSnapshot,
        emitStateEvent,
        logSecrets,
      });

      await expect(
        activateRuntimeSecrets(gatewayTokenConfig({}), {
          reason,
          activate: false,
          publishFailureAsDegraded: true,
        }),
      ).rejects.toThrow(invalidSecretError.message);

      expect(logSecrets.warn).not.toHaveBeenCalled();
      expect(emitStateEvent).not.toHaveBeenCalled();
    },
  );

  it("does not publish typed degradation after reload ownership expires", async () => {
    activateSecretsRuntimeSnapshotForTest(preparedSnapshot(gatewayTokenConfig({})));
    const failure = refResolutionError({
      code: "SECRET_REF_NOT_FOUND",
      source: "env",
      provider: "default",
      refId: "EXPIRED_RELOAD_REF",
      message: "expired reload fixture",
    });
    associateSecretResolutionErrorOwners(failure, [
      {
        ownerKind: "capability",
        ownerId: "tts",
        state: "unavailable",
        paths: ["messages.tts.providers.elevenlabs.apiKey"],
        refKeys: ["env:default:EXPIRED_RELOAD_REF"],
        reason: "secret reference was not found",
        degradationState: "stale",
        failureMatched: true,
        source: "config",
      },
    ]);
    const emitStateEvent = vi.fn();
    const logSecrets = mockLogSecretsForTest();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      prepareRuntimeSecretsSnapshot: vi.fn(async () => {
        throw failure;
      }),
      emitStateEvent,
      logSecrets,
    });

    await expect(
      activateRuntimeSecrets(gatewayTokenConfig({}), {
        reason: "reload",
        activate: false,
        publishFailureAsDegraded: true,
        canPublishFailureAsDegraded: () => false,
      }),
    ).rejects.toThrow(failure.message);

    expect(logSecrets.warn).not.toHaveBeenCalled();
    expect(emitStateEvent).not.toHaveBeenCalled();
  });

  it("publishes a redacted unknown-owner warning for an unmapped typed reload failure", async () => {
    activateSecretsRuntimeSnapshotForTest(preparedSnapshot(gatewayTokenConfig({})));
    const missingSecretError = refResolutionError({
      code: "SECRET_REF_NOT_FOUND",
      source: "env",
      provider: "default",
      refId: "PRIVATE_UNMAPPED_REF",
      message: 'Environment variable "PRIVATE_UNMAPPED_REF" is missing or empty.',
    });
    const prepareRuntimeSecretsSnapshot = vi.fn(async () => {
      throw missingSecretError;
    });
    const emitStateEvent = vi.fn();
    const logSecrets = mockLogSecretsForTest();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      prepareRuntimeSecretsSnapshot,
      emitStateEvent,
      logSecrets,
    });

    await expect(
      activateRuntimeSecrets(gatewayTokenConfig({}), {
        reason: "reload",
        activate: false,
        publishFailureAsDegraded: true,
      }),
    ).rejects.toThrow(missingSecretError.message);

    expect(logSecrets.warn).toHaveBeenCalledWith(
      "[SECRETS_DEGRADED] cold unknown:unmapped: secret reference was not found. " +
        "Retry: openclaw secrets reload.",
      {
        event: "secrets.degraded",
        ownerKind: "unknown",
        ownerId: "unmapped",
        reason: "secret reference was not found",
        state: "cold",
        retryHint: "openclaw secrets reload",
      },
    );
    expect(JSON.stringify(logSecrets.warn.mock.calls)).not.toContain("PRIVATE_UNMAPPED_REF");
    expect(emitStateEvent).toHaveBeenCalledWith(
      "SECRETS_RELOADER_DEGRADED",
      "Secret resolution failed; runtime remains on the last-known-good snapshot.",
      expect.anything(),
    );
  });

  it("preserves invalid provider diagnostics instead of reporting runtime degradation", async () => {
    const invalidProviderError = providerResolutionError({
      code: "SECRET_PROVIDER_INVALID",
      source: "env",
      provider: "missing",
      message: 'Secret provider "missing" is not configured.',
    });
    const emitStateEvent = vi.fn();
    const logSecrets = mockLogSecretsForTest();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      prepareRuntimeSecretsSnapshot: vi.fn(async () => {
        throw invalidProviderError;
      }),
      emitStateEvent,
      logSecrets,
    });

    await expect(
      activateRuntimeSecrets(gatewayTokenConfig({}), {
        reason: "startup",
        activate: false,
      }),
    ).rejects.toThrow('Secret provider "missing" is not configured.');

    expect(logSecrets.warn).not.toHaveBeenCalled();
    expect(emitStateEvent).not.toHaveBeenCalled();
  });

  it("does not publish a rejected candidate-only preflight as active degradation", async () => {
    let shouldFail = true;
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => {
      if (shouldFail) {
        throw new Error("candidate secret resolution failed");
      }
      return preparedSnapshot(config);
    });
    const emitStateEvent = vi.fn();
    const logSecrets = mockLogSecretsForTest();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      prepareRuntimeSecretsSnapshot,
      emitStateEvent,
      logSecrets,
    });

    await expect(
      activateRuntimeSecrets(gatewayTokenConfig({}), {
        reason: "reload",
        activate: false,
      }),
    ).rejects.toThrow("candidate secret resolution failed");

    expect(emitStateEvent).not.toHaveBeenCalled();
    expect(logSecrets.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("SECRETS_DEGRADED"),
      expect.anything(),
    );

    shouldFail = false;
    await expect(
      activateRuntimeSecrets(gatewayTokenConfig({}), {
        reason: "reload",
        activate: false,
      }),
    ).resolves.toBeDefined();
    expect(emitStateEvent).not.toHaveBeenCalled();
    expect(logSecrets.info).not.toHaveBeenCalledWith(
      expect.stringContaining("SECRETS_RELOADER_RECOVERED"),
    );
  });

  it("enables cold-start owner isolation during non-activating startup preparation", async () => {
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => ({
      ...preparedSnapshot(config),
      degradedOwners: [
        {
          ownerKind: "capability" as const,
          ownerId: "tts",
          state: "unavailable" as const,
          paths: ["messages.tts.providers.elevenlabs.apiKey"],
          refKeys: ["env:default:ELEVENLABS_API_KEY"],
          reason: "secret reference was not found",
        },
      ],
    }));
    const activateRuntimeSecretsSnapshot = vi.fn();
    const logSecrets = mockLogSecretsForTest();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      prepareRuntimeSecretsSnapshot,
      activateRuntimeSecretsSnapshot,
      logSecrets,
    });

    await activateRuntimeSecrets(gatewayTokenConfig({}), {
      reason: "startup",
      activate: false,
    });

    expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ allowUnavailableSecretOwners: true }),
    );
    expect(activateRuntimeSecretsSnapshot).not.toHaveBeenCalled();
    expect(logSecrets.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("SECRETS_DEGRADED"),
      expect.anything(),
    );
  });

  it("does not enable cold-start degradation while a runtime snapshot is active", async () => {
    activateSecretsRuntimeSnapshotForTest(preparedSnapshot(gatewayTokenConfig({})));
    const missingSecretError = new Error(
      'Environment variable "ELEVENLABS_API_KEY" is missing or empty.',
    );
    const prepareRuntimeSecretsSnapshot = vi.fn(async () => {
      throw missingSecretError;
    });
    const activateRuntimeSecretsSnapshot = vi.fn();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      prepareRuntimeSecretsSnapshot,
      activateRuntimeSecretsSnapshot,
    });

    await expect(
      activateRuntimeSecrets(gatewayTokenConfig({}), {
        reason: "startup",
        activate: false,
      }),
    ).rejects.toThrow("Startup failed: required secrets are unavailable.");

    expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ allowUnavailableSecretOwners: false }),
    );
    expect(activateRuntimeSecretsSnapshot).not.toHaveBeenCalled();
  });

  it("uses persisted auth stores only for startup secret preflight", async () => {
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => preparedSnapshot(config));
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      prepareRuntimeSecretsSnapshot,
    });

    await activateRuntimeSecrets(gatewayTokenConfig({}), {
      reason: "startup",
      activate: false,
    });

    const preflightInput = callArg<{
      config?: unknown;
      loadAuthStore?: unknown;
    }>(prepareRuntimeSecretsSnapshot);
    expect(typeof preflightInput.config).toBe("object");
    expect(preflightInput.loadAuthStore).toBe(loadAuthProfileStoreWithoutExternalProfiles);
  });

  it("does not emit degraded or recovered events for warning-only secret reloads", async () => {
    const warning: SecretResolverWarning = {
      code: "WEB_SEARCH_AUTODETECT_SELECTED",
      path: "tools.web.search.provider",
      message: "web search provider was auto-detected",
    };
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => ({
      ...preparedSnapshot(config),
      warnings: [warning],
    }));
    const emitStateEvent = vi.fn();
    const logSecrets = mockLogSecretsForTest();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      logSecrets,
      emitStateEvent,
      prepareRuntimeSecretsSnapshot,
    });

    const config = {
      plugins: {
        entries: {
          google: {
            enabled: true,
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "MISSING_GEMINI_KEY" },
              },
            },
          },
        },
      },
    };
    const result = await activateRuntimeSecrets(config, {
      reason: "reload",
      activate: true,
    });
    expect(result.sourceConfig).toBe(config);
    expect(result.config).toBe(config);
    expect(result.warnings).toEqual([warning]);
    expect(logSecrets.warn).toHaveBeenCalledWith(
      "[WEB_SEARCH_AUTODETECT_SELECTED] web search provider was auto-detected",
    );
    expect(emitStateEvent).not.toHaveBeenCalled();
    const preflightInput = callArg<{ config?: unknown }>(prepareRuntimeSecretsSnapshot);
    expect(typeof preflightInput.config).toBe("object");
  });

  it("emits one-shot degraded and recovered events during secret reload transitions", async () => {
    const missingSecretError = new Error(
      'Environment variable "OPENAI_API_KEY" is missing or empty.',
    );
    let shouldResolve = false;
    const sourceConfig = gatewayTokenConfig({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            models: [],
          },
        },
      },
    });
    const activeSnapshot = preparedSnapshot(sourceConfig);
    activeSnapshot.config.models!.providers!.openai!.apiKey = "test-api-key";
    activateSecretsRuntimeSnapshotForTest(activeSnapshot);
    associateSecretResolutionErrorOwners(missingSecretError, [
      {
        ownerKind: "provider",
        ownerId: "openai",
        state: "unavailable",
        paths: ["models.providers.openai.apiKey"],
        refKeys: ["env:default:OPENAI_API_KEY"],
        reason: "secret reference was not found",
        degradationState: "stale",
        failureMatched: true,
        source: "config",
      },
    ]);
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => {
      if (!shouldResolve) {
        throw missingSecretError;
      }
      return preparedSnapshot(config);
    });
    const emitStateEvent = vi.fn();
    const logSecrets = mockLogSecretsForTest();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      logSecrets,
      emitStateEvent,
      prepareRuntimeSecretsSnapshot,
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
    });

    await expect(
      activateRuntimeSecrets(sourceConfig, {
        reason: "reload",
        activate: false,
        publishFailureAsDegraded: true,
      }),
    ).rejects.toThrow(missingSecretError.message);
    await expect(
      activateRuntimeSecrets(sourceConfig, {
        reason: "reload",
        activate: false,
        publishFailureAsDegraded: true,
      }),
    ).rejects.toThrow(missingSecretError.message);
    shouldResolve = true;
    const activeRevision = getActiveSecretsRuntimeSnapshotRevision();
    const prepared = await activateRuntimeSecrets(sourceConfig, {
      reason: "restart-check",
      activate: false,
    });
    expect(emitStateEvent).toHaveBeenCalledTimes(1);

    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent?.(prepared, activeRevision, {
        reason: "reload",
        activate: true,
      }),
    ).resolves.toMatchObject({ config: sourceConfig });
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([
      "SECRETS_RELOADER_DEGRADED",
      "SECRETS_RELOADER_RECOVERED",
    ]);
    expect(emitStateEvent.mock.calls[0]?.[1]).toBe(
      "Secret resolution failed; runtime remains on the last-known-good snapshot.",
    );
    expect(logSecrets.error).not.toHaveBeenCalled();
    expect(logSecrets.warn).toHaveBeenCalledTimes(2);
    expect(logSecrets.warn).toHaveBeenCalledWith(
      "[SECRETS_DEGRADED] stale provider:openai: secret reference was not found. " +
        "Retry: openclaw secrets reload.",
      {
        event: "secrets.degraded",
        ownerKind: "provider",
        ownerId: "openai",
        reason: "secret reference was not found",
        state: "stale",
        retryHint: "openclaw secrets reload",
      },
    );
    expect(JSON.stringify(logSecrets.warn.mock.calls)).not.toContain("OPENAI_API_KEY");
    expect(logSecrets.info).toHaveBeenCalledWith(
      "[SECRETS_RELOADER_RECOVERED] Secret resolution recovered; runtime remained on last-known-good during the outage.",
    );

    shouldResolve = false;
    await expect(
      activateRuntimeSecrets(sourceConfig, {
        reason: "reload",
        activate: false,
        publishFailureAsDegraded: true,
      }),
    ).rejects.toThrow(missingSecretError.message);
    shouldResolve = true;
    const sourceOnlyRevision = getActiveSecretsRuntimeSnapshotRevision();
    const sourceOnly = await activateRuntimeSecrets(sourceConfig, {
      reason: "reload",
      activate: false,
      publishFailureAsDegraded: true,
    });
    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent?.(sourceOnly, sourceOnlyRevision, {
        reason: "reload",
        activate: true,
        deferStatePublication: true,
      }),
    ).resolves.toMatchObject({ config: sourceConfig });
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([
      "SECRETS_RELOADER_DEGRADED",
      "SECRETS_RELOADER_RECOVERED",
      "SECRETS_RELOADER_DEGRADED",
    ]);
    shouldResolve = false;
    await expect(
      activateRuntimeSecrets(sourceConfig, {
        reason: "reload",
        activate: false,
        publishFailureAsDegraded: true,
      }),
    ).rejects.toThrow(missingSecretError.message);
    publishRuntimeSecretsStateTransition(activateRuntimeSecrets, sourceOnly);
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([
      "SECRETS_RELOADER_DEGRADED",
      "SECRETS_RELOADER_RECOVERED",
      "SECRETS_RELOADER_DEGRADED",
    ]);
    shouldResolve = true;
    const newerRevision = getActiveSecretsRuntimeSnapshotRevision();
    const newerPrepared = await activateRuntimeSecrets(sourceConfig, {
      reason: "reload",
      activate: false,
    });
    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent?.(newerPrepared, newerRevision, {
        reason: "reload",
        activate: true,
      }),
    ).resolves.toMatchObject({ config: sourceConfig });
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([
      "SECRETS_RELOADER_DEGRADED",
      "SECRETS_RELOADER_RECOVERED",
      "SECRETS_RELOADER_DEGRADED",
      "SECRETS_RELOADER_RECOVERED",
    ]);

    const changedSourceConfig: OpenClawConfig = structuredClone(sourceConfig);
    changedSourceConfig.models!.providers!.openai!.apiKey = {
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY_NEXT",
    };
    associateSecretResolutionErrorOwners(missingSecretError, [
      {
        ownerKind: "provider",
        ownerId: "openai",
        state: "unavailable",
        paths: ["models.providers.openai.apiKey"],
        refKeys: ["env:default:OPENAI_API_KEY_NEXT"],
        reason: "secret reference was not found",
        degradationState: "cold",
        failureMatched: true,
        source: "config",
      },
    ]);
    shouldResolve = false;
    await expect(
      activateRuntimeSecrets(changedSourceConfig, {
        reason: "reload",
        activate: false,
        publishFailureAsDegraded: true,
      }),
    ).rejects.toThrow(missingSecretError.message);
    const revertedSnapshot = getActiveSecretsRuntimeSnapshot()!;
    const revertedRevision = getActiveSecretsRuntimeSnapshotRevision();
    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent?.(
        revertedSnapshot,
        revertedRevision,
        {
          reason: "reload",
          activate: true,
          deferStatePublication: true,
        },
      ),
    ).resolves.toMatchObject({ sourceConfig });
    publishRuntimeSecretsStateTransition(activateRuntimeSecrets, revertedSnapshot, {
      sourceOnly: true,
    });
    expect(emitStateEvent.mock.calls.map((call) => call[0]).slice(-2)).toEqual([
      "SECRETS_RELOADER_DEGRADED",
      "SECRETS_RELOADER_RECOVERED",
    ]);

    const unrelatedChangedSourceConfig = structuredClone(sourceConfig);
    unrelatedChangedSourceConfig.messages = {
      tts: {
        providers: {
          elevenlabs: {
            apiKey: { source: "env", provider: "default", id: "UNRELATED_TTS_KEY" },
          },
        },
      },
    };
    associateSecretResolutionErrorOwners(missingSecretError, [
      {
        ownerKind: "provider",
        ownerId: "openai",
        state: "unavailable",
        paths: ["models.providers.openai.apiKey"],
        refKeys: ["env:default:OPENAI_API_KEY"],
        reason: "secret reference was not found",
        degradationState: "stale",
        failureMatched: true,
        source: "config",
      },
    ]);
    await expect(
      activateRuntimeSecrets(unrelatedChangedSourceConfig, {
        reason: "reload",
        activate: false,
        publishFailureAsDegraded: true,
      }),
    ).rejects.toThrow(missingSecretError.message);
    const unrelatedRevertedSnapshot = getActiveSecretsRuntimeSnapshot()!;
    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent?.(
        unrelatedRevertedSnapshot,
        getActiveSecretsRuntimeSnapshotRevision(),
        { reason: "reload", activate: true, deferStatePublication: true },
      ),
    ).resolves.toMatchObject({ sourceConfig });
    publishRuntimeSecretsStateTransition(activateRuntimeSecrets, unrelatedRevertedSnapshot, {
      sourceOnly: true,
    });
    expect(emitStateEvent.mock.calls.map((call) => call[0]).slice(-2)).toEqual([
      "SECRETS_RELOADER_RECOVERED",
      "SECRETS_RELOADER_DEGRADED",
    ]);

    await expect(
      activateRuntimeSecrets(sourceConfig, {
        reason: "reload",
        activate: false,
        publishFailureAsDegraded: true,
      }),
    ).rejects.toThrow(missingSecretError.message);
    const unchangedSnapshot = getActiveSecretsRuntimeSnapshot()!;
    const unchangedRevision = getActiveSecretsRuntimeSnapshotRevision();
    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent?.(
        unchangedSnapshot,
        unchangedRevision,
        {
          reason: "reload",
          activate: true,
          deferStatePublication: true,
        },
      ),
    ).resolves.toMatchObject({ sourceConfig });
    publishRuntimeSecretsStateTransition(activateRuntimeSecrets, unchangedSnapshot, {
      sourceOnly: true,
    });
    expect(emitStateEvent.mock.calls.map((call) => call[0]).slice(-2)).toEqual([
      "SECRETS_RELOADER_RECOVERED",
      "SECRETS_RELOADER_DEGRADED",
    ]);
  });

  it("does not recover auth-store degradation from a config-only source reversion", async () => {
    const stableConfig = gatewayTokenConfig({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "env", provider: "default", id: "OPENAI_STABLE" },
            models: [],
          },
        },
      },
    });
    const changedConfig = structuredClone(stableConfig);
    changedConfig.models!.providers!.openai!.apiKey = {
      source: "env",
      provider: "default",
      id: "OPENAI_CHANGED",
    };
    const configFailure = new Error("config secret failed");
    associateSecretResolutionErrorOwners(configFailure, [
      {
        ownerKind: "provider",
        ownerId: "openai",
        state: "unavailable",
        paths: ["models.providers.openai.apiKey"],
        refKeys: ["env:default:OPENAI_CHANGED"],
        reason: "secret reference was not found",
        degradationState: "cold",
        failureMatched: true,
        source: "config",
      },
    ]);
    const authStoreFailure = new Error("auth store secret failed");
    associateSecretResolutionErrorOwners(authStoreFailure, [
      {
        ownerKind: "account",
        ownerId: "auth-profile-owner",
        state: "unavailable",
        paths: ["/tmp/agent.auth-profiles.openai:default.key"],
        refKeys: ["env:default:AUTH_PROFILE_KEY"],
        reason: "secret reference was not found",
        degradationState: "stale",
        failureMatched: true,
        source: "auth-store",
      },
    ]);
    const emitStateEvent = vi.fn();
    let nextFailure = configFailure;
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      emitStateEvent,
      prepareRuntimeSecretsSnapshot: vi.fn(async () => {
        throw nextFailure;
      }),
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
    });
    activateSecretsRuntimeSnapshotForTest(preparedSnapshot(stableConfig));

    await expect(
      activateRuntimeSecrets(changedConfig, {
        reason: "reload",
        activate: false,
        publishFailureAsDegraded: true,
      }),
    ).rejects.toBe(configFailure);
    nextFailure = authStoreFailure;
    await expect(
      activateRuntimeSecrets(changedConfig, {
        reason: "reload",
        activate: false,
        publishFailureAsDegraded: true,
      }),
    ).rejects.toBe(authStoreFailure);

    const revertedSnapshot = preparedSnapshot(stableConfig);
    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent?.(
        revertedSnapshot,
        getActiveSecretsRuntimeSnapshotRevision(),
        { reason: "reload", activate: true, deferStatePublication: true },
      ),
    ).resolves.toBe(revertedSnapshot);
    publishRuntimeSecretsStateTransition(activateRuntimeSecrets, revertedSnapshot, {
      sourceOnly: true,
    });
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual(["SECRETS_RELOADER_DEGRADED"]);

    const fullyResolvedSnapshot = preparedSnapshot(stableConfig);
    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent?.(
        fullyResolvedSnapshot,
        getActiveSecretsRuntimeSnapshotRevision(),
        { reason: "reload", activate: true, deferStatePublication: true },
      ),
    ).resolves.toBe(fullyResolvedSnapshot);
    publishRuntimeSecretsStateTransition(activateRuntimeSecrets, fullyResolvedSnapshot);
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([
      "SECRETS_RELOADER_DEGRADED",
      "SECRETS_RELOADER_RECOVERED",
    ]);

    nextFailure = authStoreFailure;
    await expect(
      activateRuntimeSecrets(changedConfig, {
        reason: "reload",
        activate: false,
        publishFailureAsDegraded: true,
      }),
    ).rejects.toBe(authStoreFailure);
    nextFailure = configFailure;
    await expect(
      activateRuntimeSecrets(changedConfig, {
        reason: "reload",
        activate: false,
        publishFailureAsDegraded: true,
      }),
    ).rejects.toBe(configFailure);

    const secondRevertedSnapshot = preparedSnapshot(stableConfig);
    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent?.(
        secondRevertedSnapshot,
        getActiveSecretsRuntimeSnapshotRevision(),
        { reason: "reload", activate: true, deferStatePublication: true },
      ),
    ).resolves.toBe(secondRevertedSnapshot);
    publishRuntimeSecretsStateTransition(activateRuntimeSecrets, secondRevertedSnapshot, {
      sourceOnly: true,
    });
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([
      "SECRETS_RELOADER_DEGRADED",
      "SECRETS_RELOADER_RECOVERED",
      "SECRETS_RELOADER_DEGRADED",
    ]);
  });

  it.each(KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS)(
    "rejects known weak gateway tokens resolved during secret activation: %s",
    async (token) => {
      const sourceConfig = gatewayTokenConfig(gatewaySecretRefSnapshot().config);
      const prepareRuntimeSecretsSnapshot = vi.fn(async () =>
        preparedSnapshot({
          ...sourceConfig,
          gateway: {
            ...sourceConfig.gateway,
            auth: {
              ...sourceConfig.gateway?.auth,
              token,
            },
          },
        }),
      );
      const activateRuntimeSecretsSnapshot = vi.fn();
      const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
        prepareRuntimeSecretsSnapshot,
        activateRuntimeSecretsSnapshot,
      });

      await expect(
        activateRuntimeSecrets(sourceConfig, {
          reason: "reload",
          activate: true,
        }),
      ).rejects.toThrow(/published example placeholder/);
      expect(activateRuntimeSecretsSnapshot).not.toHaveBeenCalled();
    },
  );

  it("prunes channel refs from startup secret preflight when channels are skipped", async () => {
    process.env.OPENCLAW_SKIP_CHANNELS = "1";
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => preparedSnapshot(config));
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      prepareRuntimeSecretsSnapshot,
    });
    const config = gatewayTokenConfig(
      asConfig({
        channels: {
          telegram: {
            botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
          },
        },
      }),
    );

    const result = await activateRuntimeSecrets(config, {
      reason: "startup",
      activate: false,
    });
    expect(typeof result.config.gateway).toBe("object");
    const preflightInput = callArg<{
      config?: OpenClawConfig;
      loadAuthStore?: unknown;
    }>(prepareRuntimeSecretsSnapshot);
    expect(preflightInput.config?.channels).toBeUndefined();
    expect(preflightInput.loadAuthStore).toBe(loadAuthProfileStoreWithoutExternalProfiles);
  });

  it("honors startup auth overrides before secret preflight gating", async () => {
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => preparedSnapshot(config));
    const activateRuntimeSecretsSnapshot = vi.fn();
    const result = await prepareGatewayStartupConfig({
      configSnapshot: buildSnapshot({
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
        gateway: {
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "MISSING_STARTUP_GW_TOKEN" },
          },
        },
      }),
      authOverride: {
        mode: "password",
        password: "override-password", // pragma: allowlist secret
      },
      activateRuntimeSecrets: runtimeSecretsActivatorForTest({
        prepareRuntimeSecretsSnapshot,
        activateRuntimeSecretsSnapshot,
      }),
    });

    expect(result.auth.mode).toBe("password");
    expect(result.auth.password).toBe("override-password");
    const preflightInput = callArg<{
      config?: OpenClawConfig;
      loadAuthStore?: unknown;
    }>(prepareRuntimeSecretsSnapshot);
    expect(preflightInput.config?.gateway?.auth?.mode).toBe("password");
    expect(preflightInput.config?.gateway?.auth?.password).toBe("override-password");
    expect(preflightInput.loadAuthStore).toBe(loadAuthProfileStoreWithoutExternalProfiles);
    expect(activateRuntimeSecretsSnapshot).toHaveBeenCalledTimes(1);
  });

  it("skips inactive gateway auth secret preflight when auth has plain strings", async () => {
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => preparedSnapshot(config));
    const result = await prepareGatewayStartupConfig({
      configSnapshot: buildSnapshot(gatewayTokenConfig({})),
      activateRuntimeSecrets: runtimeSecretsActivatorForTest({
        prepareRuntimeSecretsSnapshot,
      }),
    });

    expect(result.auth.mode).toBe("token");
    expect(result.auth.token).toBe("startup-test-token");
    expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledTimes(1);
    const preflightInput = callArg<{
      config?: OpenClawConfig;
      loadAuthStore?: unknown;
    }>(prepareRuntimeSecretsSnapshot);
    expect(preflightInput.config?.gateway?.auth?.token).toBe("startup-test-token");
    expect(preflightInput.loadAuthStore).toBe(loadAuthProfileStoreWithoutExternalProfiles);
  });

  it("uses gateway auth strings resolved during startup preflight for bootstrap auth", async () => {
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) =>
      preparedSnapshotWithGatewayToken(config),
    );
    const activateRuntimeSecretsSnapshot = vi.fn();

    const result = await prepareGatewaySecretRefStartupConfig({
      prepareRuntimeSecretsSnapshot,
      activateRuntimeSecretsSnapshot,
    });

    expectBootstrapAuthResolvedGatewayToken(result);
    expect(result.cfg.gateway?.auth?.token).toBe(RESOLVED_GATEWAY_TOKEN);
    expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledTimes(1);
    expect(activateRuntimeSecretsSnapshot).toHaveBeenCalledTimes(1);
    expect(activateRuntimeSecretsSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          gateway: expect.objectContaining({
            auth: expect.objectContaining({
              token: RESOLVED_GATEWAY_TOKEN,
            }),
          }),
        }),
      }),
    );
  });

  it("falls back to a fresh startup activation when the preflight snapshot source is not reusable", async () => {
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => ({
      ...preparedSnapshot(
        prepareRuntimeSecretsSnapshot.mock.calls.length === 1
          ? {
              ...config,
              diagnostics: {
                enabled: true,
              },
            }
          : config,
      ),
      config: preparedSnapshotWithGatewayToken(config).config,
    }));
    const activateRuntimeSecretsSnapshot = vi.fn();

    const result = await prepareGatewaySecretRefStartupConfig({
      prepareRuntimeSecretsSnapshot,
      activateRuntimeSecretsSnapshot,
    });

    expectBootstrapAuthResolvedGatewayToken(result);
    expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledTimes(2);
    expect(activateRuntimeSecretsSnapshot).toHaveBeenCalledTimes(1);
  });

  it("activates no-SecretRef startup config without importing the full secrets runtime", async () => {
    vi.resetModules();
    const agentDir = mkdtempSync(path.join(tmpdir(), "openclaw-startup-fast-path-"));
    const isolatedEnv = installIsolatedStartupFastPathEnv();
    const runtimeImport = vi.fn();
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => preparedSnapshot(config));
    const activateRuntimeSecretsSnapshot = vi.fn();
    const loadAuthProfileStoreWithoutExternalProfilesMock = vi.fn(() => ({
      version: 1,
      profiles: {},
    }));
    (
      globalThis as typeof globalThis & {
        __gatewayStartupSecretsRuntimeMock?: {
          runtimeImport: typeof runtimeImport;
          prepareRuntimeSecretsSnapshot: typeof prepareRuntimeSecretsSnapshot;
          activateRuntimeSecretsSnapshot: typeof activateRuntimeSecretsSnapshot;
        };
      }
    )["__gatewayStartupSecretsRuntimeMock"] = {
      runtimeImport,
      prepareRuntimeSecretsSnapshot,
      activateRuntimeSecretsSnapshot,
    };
    vi.doMock("../agents/auth-profiles.js", () => ({
      loadAuthProfileStoreWithoutExternalProfiles: loadAuthProfileStoreWithoutExternalProfilesMock,
    }));
    vi.doMock("../secrets/runtime.js", () => {
      const state = (
        globalThis as typeof globalThis & {
          __gatewayStartupSecretsRuntimeMock?: {
            runtimeImport: typeof runtimeImport;
            prepareRuntimeSecretsSnapshot: typeof prepareRuntimeSecretsSnapshot;
            activateRuntimeSecretsSnapshot: typeof activateRuntimeSecretsSnapshot;
          };
        }
      )["__gatewayStartupSecretsRuntimeMock"];
      if (!state) {
        throw new Error("missing gateway startup secrets runtime mock");
      }
      state.runtimeImport();
      return {
        prepareSecretsRuntimeSnapshot: state.prepareRuntimeSecretsSnapshot,
        activateSecretsRuntimeSnapshot: state.activateRuntimeSecretsSnapshot,
        preflightActiveSecretsRuntimeSnapshotRefresh: async ({
          sourceConfig,
        }: {
          sourceConfig: OpenClawConfig;
        }) => await state.prepareRuntimeSecretsSnapshot({ config: sourceConfig }),
        refreshActiveSecretsRuntimeSnapshotForConfig: async ({
          sourceConfig,
          preflightResult,
        }: {
          sourceConfig: OpenClawConfig;
          preflightResult?: unknown;
        }) => {
          const snapshot =
            preflightResult && typeof preflightResult === "object"
              ? (preflightResult as PreparedSecretsRuntimeSnapshot)
              : await state.prepareRuntimeSecretsSnapshot({ config: sourceConfig });
          state.activateRuntimeSecretsSnapshot(snapshot);
          return true;
        },
      };
    });

    try {
      const {
        clearSecretsRuntimeSnapshot: clearImportedSecretsRuntimeSnapshot,
        getActiveSecretsRuntimeSnapshot: getImportedSecretsRuntimeSnapshot,
      } = await import("../secrets/runtime-state.js");
      const { getRuntimeConfigSnapshotRefreshHandler } =
        await import("../config/runtime-snapshot.js");
      const result = await activateImportedStartupConfig(
        asConfig({
          agents: {
            list: [{ id: "default", agentDir }],
          },
        }),
      );

      expect(runtimeImport).not.toHaveBeenCalled();
      expect(prepareRuntimeSecretsSnapshot).not.toHaveBeenCalled();
      expect(activateRuntimeSecretsSnapshot).not.toHaveBeenCalled();
      expect(loadAuthProfileStoreWithoutExternalProfilesMock).not.toHaveBeenCalled();
      expect(result.config.gateway?.auth?.token).toBe("startup-test-token");
      expect(getImportedSecretsRuntimeSnapshot()?.config.gateway?.auth?.token).toBe(
        "startup-test-token",
      );
      const refreshHandler = getRuntimeConfigSnapshotRefreshHandler();
      await expect(
        refreshHandler?.refresh({
          sourceConfig: gatewayTokenConfig(
            asConfig({
              agents: {
                list: [{ id: "default", agentDir }],
              },
            }),
          ),
        }),
      ).resolves.toBe(true);
      expect(runtimeImport).toHaveBeenCalledTimes(1);
      const refreshInput = callArg<{
        loadAuthStore?: unknown;
      }>(prepareRuntimeSecretsSnapshot);
      expect(refreshInput.loadAuthStore).toBeUndefined();
      clearImportedSecretsRuntimeSnapshot();
    } finally {
      isolatedEnv.cleanup();
      vi.doUnmock("../agents/auth-profiles.js");
      vi.doUnmock("../secrets/runtime.js");
      delete (
        globalThis as typeof globalThis & {
          __gatewayStartupSecretsRuntimeMock?: unknown;
        }
      )["__gatewayStartupSecretsRuntimeMock"];
      rmSync(agentDir, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it("retries a stale startup fast-path preflight against the newer runtime context", async () => {
    const agentDir = autoCleanupTempDirs.make("openclaw-startup-fast-path-cas-");
    let clearImportedSecretsRuntimeSnapshot: (() => void) | undefined;
    const config = (port: number) =>
      gatewayTokenConfig(
        asConfig({
          agents: { list: [{ id: "default", agentDir }] },
          gateway: { port },
        }),
      );
    try {
      // A preceding lazy-import test resets Vitest's module cache. Import this
      // whole runtime graph together so the activator and handler share state.
      const { createRuntimeSecretsActivator: createImportedRuntimeSecretsActivator } =
        await import("./server-startup-config.js");
      const secretsRuntime = await import("../secrets/runtime.js");
      clearImportedSecretsRuntimeSnapshot = secretsRuntime.clearSecretsRuntimeSnapshot;
      const activateRuntimeSecrets = createImportedRuntimeSecretsActivator(
        runtimeSecretsActivatorOptionsForTest(),
      );
      await activateRuntimeSecrets(config(19_021), {
        reason: "startup",
        activate: true,
      });
      const { getRuntimeConfigSnapshotRefreshHandler } =
        await import("../config/runtime-snapshot.js");
      const staleRefreshHandler = getRuntimeConfigSnapshotRefreshHandler();
      if (!staleRefreshHandler?.preflight) {
        throw new Error("expected startup fast-path refresh preflight handler");
      }
      const desiredConfig = config(19_023);
      const preflightResult = await staleRefreshHandler.preflight({
        sourceConfig: desiredConfig,
      });
      const concurrent = await secretsRuntime.prepareSecretsRuntimeSnapshot({
        config: config(19_022),
        agentDirs: [agentDir],
        loadAuthStore: () => ({
          version: 1,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "newer-context-key",
            },
          },
        }),
      });
      secretsRuntime.activateSecretsRuntimeSnapshot(concurrent);

      await expect(
        staleRefreshHandler.refresh({ sourceConfig: desiredConfig, preflightResult }),
      ).resolves.toBe(true);

      const active = secretsRuntime.getActiveSecretsRuntimeSnapshot();
      expect(active?.sourceConfig.gateway?.port).toBe(19_023);
      expect(active?.authStores[0]?.store.profiles["openai:default"]).toMatchObject({
        key: "newer-context-key",
      });
    } finally {
      clearImportedSecretsRuntimeSnapshot?.();
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("grafts live auth stores onto one-shot config-write snapshots", async () => {
    const agentDir = "/tmp/openclaw-managed-write-auth-store";
    const credential = {
      type: "api_key" as const,
      provider: "openai",
      key: "live-auth-store-key",
    };
    setRuntimeAuthProfileStoreSnapshot(
      { version: 1, profiles: { "openai:default": credential } },
      agentDir,
    );
    const active = preparedSnapshot(gatewayTokenConfig({}));
    active.authStores = [
      {
        agentDir,
        store: { version: 1, profiles: { "openai:default": credential } },
      },
    ];
    active.authStoreCredentialsRevision = getRuntimeAuthProfileStoreCredentialsRevision();
    activateSecretsRuntimeSnapshotState({
      snapshot: active,
      refreshContext: {
        env: {},
        explicitAgentDirs: null,
        includeAuthStoreRefs: true,
        loadablePluginOrigins: new Map(),
      },
      refreshHandler: null,
    });
    const prepareRuntimeSecretsSnapshot = vi.fn(async (params: { config: OpenClawConfig }) =>
      preparedSnapshot(params.config),
    );
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      prepareRuntimeSecretsSnapshot,
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
    });

    const prepared = await activateRuntimeSecrets(
      gatewayTokenConfig({ logging: { level: "debug" } }),
      {
        reason: "reload",
        activate: false,
        includeAuthStoreRefs: false,
      },
    );
    expect(prepared.authStores[0]?.store.profiles["openai:default"]).toEqual(credential);
    await activateRuntimeSecrets.activatePreparedSnapshot?.(prepared, {
      reason: "reload",
      activate: true,
      includeAuthStoreRefs: false,
    });
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:default"]).toEqual(
      credential,
    );
  });

  it("keeps the full secrets runtime path when startup config has a SecretRef", async () => {
    const harness = createGatewayStartupSecretsRuntimeHarness("openclaw-startup-secret-ref-");
    await expectImportedStartupConfigUsesFullSecretsRuntime(
      harness,
      asConfig({
        agents: {
          list: [{ id: "default", agentDir: harness.agentDir }],
        },
        models: {
          providers: {
            openai: {
              models: [],
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            },
          },
        },
      }),
    );
  });

  it("keeps the full secrets runtime path when auth profile files are present", async () => {
    const harness = createGatewayStartupSecretsRuntimeHarness("openclaw-startup-auth-store-");
    writeFileSync(
      path.join(harness.agentDir, "auth-profiles.json"),
      `${JSON.stringify({
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-test",
          },
        },
      })}\n`,
    );
    await expectImportedStartupConfigUsesFullSecretsRuntime(
      harness,
      asConfig({
        agents: {
          list: [{ id: "default", agentDir: harness.agentDir }],
        },
      }),
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
