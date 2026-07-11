// Startup config secret tests protect gateway token preparation, weak-secret
// detection, auth profile loading, warning emission, and runtime activation.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import { measureDiagnosticsTimelineSpan } from "../infra/diagnostics-timeline.js";
import type { PreparedSecretsRuntimeSnapshot, SecretResolverWarning } from "../secrets/runtime.js";
import { KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS } from "./known-weak-gateway-secrets.js";
import {
  createRuntimeSecretsActivator,
  prepareGatewayStartupConfig,
} from "./server-startup-config.js";
import { buildTestConfigSnapshot } from "./test-helpers.config-snapshots.js";

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
  warn: ReturnType<typeof vi.fn<(message: string) => void>>;
  error: ReturnType<typeof vi.fn<(message: string) => void>>;
};

type GatewayStartupStateEmitterMock = ReturnType<
  typeof vi.fn<(code: string, message: string, cfg: OpenClawConfig) => void>
>;

const RESOLVED_GATEWAY_TOKEN = "resolved-gateway-token";

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
    warn: vi.fn<(message: string) => void>(),
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
    const error = new Error('Environment variable "OPENAI_API_KEY" is missing or empty.');
    const prepareRuntimeSecretsSnapshot = vi.fn(async () => {
      throw error;
    });
    const emitStateEvent = vi.fn();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      emitStateEvent,
      prepareRuntimeSecretsSnapshot,
    });

    await expect(
      activateRuntimeSecrets(gatewayTokenConfig({}), {
        reason: "startup",
        activate: false,
      }),
    ).rejects.toThrow(
      'Startup failed: required secrets are unavailable. Error: Environment variable "OPENAI_API_KEY" is missing or empty.',
    );
    expect(emitStateEvent).not.toHaveBeenCalled();
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
      code: "WEB_SEARCH_KEY_UNRESOLVED_FALLBACK_USED",
      path: "plugins.entries.google.config.webSearch.apiKey",
      message: "web search provider fell back to environment credentials",
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
      "[WEB_SEARCH_KEY_UNRESOLVED_FALLBACK_USED] web search provider fell back to environment credentials",
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
    });

    await expect(
      activateRuntimeSecrets(sourceConfig, {
        reason: "reload",
        activate: true,
      }),
    ).rejects.toThrow(missingSecretError.message);
    await expect(
      activateRuntimeSecrets(sourceConfig, {
        reason: "reload",
        activate: true,
      }),
    ).rejects.toThrow(missingSecretError.message);
    shouldResolve = true;
    await expect(
      activateRuntimeSecrets(sourceConfig, {
        reason: "reload",
        activate: true,
      }),
    ).resolves.toMatchObject({ config: sourceConfig });

    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([
      "SECRETS_RELOADER_DEGRADED",
      "SECRETS_RELOADER_RECOVERED",
    ]);
    expect(logSecrets.error).toHaveBeenCalledTimes(1);
    expect(logSecrets.warn).toHaveBeenCalledWith(
      `[SECRETS_RELOADER_DEGRADED] Error: ${missingSecretError.message}`,
    );
    expect(logSecrets.info).toHaveBeenCalledWith(
      "[SECRETS_RELOADER_RECOVERED] Secret resolution recovered; runtime remained on last-known-good during the outage.",
    );
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
      };
    });

    try {
      const { clearSecretsRuntimeSnapshot, getActiveSecretsRuntimeSnapshot } =
        await import("../secrets/runtime-state.js");
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
      expect(getActiveSecretsRuntimeSnapshot()?.config.gateway?.auth?.token).toBe(
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
      clearSecretsRuntimeSnapshot();
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
