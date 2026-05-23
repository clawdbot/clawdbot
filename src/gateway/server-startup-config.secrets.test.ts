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
  activateRuntimeSecretsSnapshot: ActivateRuntimeSecretsSnapshotForTest;
}) {
  return createRuntimeSecretsActivator({
    logSecrets: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    emitStateEvent: vi.fn(),
    prepareRuntimeSecretsSnapshot: params.prepareRuntimeSecretsSnapshot,
    activateRuntimeSecretsSnapshot: params.activateRuntimeSecretsSnapshot,
  });
}

function readTimelineEvents(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
      activateRuntimeSecrets: createRuntimeSecretsActivator({
        logSecrets: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        emitStateEvent: vi.fn(),
        prepareRuntimeSecretsSnapshot,
        activateRuntimeSecretsSnapshot: vi.fn(),
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
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-startup-secrets-timeline-"));
    const timelinePath = path.join(root, "timeline.jsonl");
    const previousDiagnostics = process.env.OPENCLAW_DIAGNOSTICS;
    const previousTimelinePath = process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH;
    process.env.OPENCLAW_DIAGNOSTICS = "timeline";
    process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = timelinePath;
    try {
      const config = gatewaySecretRefSnapshot().config;
      const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => preparedSnapshot(config));

      const activateRuntimeSecrets = createRuntimeSecretsActivator({
        logSecrets: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        emitStateEvent: vi.fn(),
        prepareRuntimeSecretsSnapshot,
        activateRuntimeSecretsSnapshot: vi.fn(),
      });

      await activateRuntimeSecrets(config, { reason: "startup", activate: false });

      const events = readTimelineEvents(timelinePath);
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
    }
  });

  it("omits secret preparation error messages from diagnostics timeline spans", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-startup-secrets-timeline-"));
    const timelinePath = path.join(root, "timeline.jsonl");
    const previousDiagnostics = process.env.OPENCLAW_DIAGNOSTICS;
    const previousTimelinePath = process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH;
    process.env.OPENCLAW_DIAGNOSTICS = "timeline";
    process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = timelinePath;
    try {
      const prepareRuntimeSecretsSnapshot = vi.fn(async () => {
        throw new Error('Secret provider "default" is not configured for GATEWAY_TOKEN_REF.');
      });

      const activateRuntimeSecrets = createRuntimeSecretsActivator({
        logSecrets: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        emitStateEvent: vi.fn(),
        prepareRuntimeSecretsSnapshot,
        activateRuntimeSecretsSnapshot: vi.fn(),
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

      const events = readTimelineEvents(timelinePath);
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
    }
  });

  it("wraps startup secret activation failures without emitting reload state events", async () => {
    const error = new Error('Environment variable "OPENAI_API_KEY" is missing or empty.');
    const prepareRuntimeSecretsSnapshot = vi.fn(async () => {
      throw error;
    });
    const emitStateEvent = vi.fn();
    const activateRuntimeSecrets = createRuntimeSecretsActivator({
      logSecrets: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      emitStateEvent,
      prepareRuntimeSecretsSnapshot,
      activateRuntimeSecretsSnapshot: vi.fn(),
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
    const activateRuntimeSecrets = createRuntimeSecretsActivator({
      logSecrets: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      emitStateEvent: vi.fn(),
      prepareRuntimeSecretsSnapshot,
      activateRuntimeSecretsSnapshot: vi.fn(),
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
    const logSecrets = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const activateRuntimeSecrets = createRuntimeSecretsActivator({
      logSecrets,
      emitStateEvent,
      prepareRuntimeSecretsSnapshot,
      activateRuntimeSecretsSnapshot: vi.fn(),
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

  it.each(KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS)(
    "rejects known weak gateway tokens resolved during secret activation: %s",
    async (token) => {
      const sourceConfig = gatewayTokenConfig({
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
      const activateRuntimeSecrets = createRuntimeSecretsActivator({
        logSecrets: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        emitStateEvent: vi.fn(),
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
    const activateRuntimeSecrets = createRuntimeSecretsActivator({
      logSecrets: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      emitStateEvent: vi.fn(),
      prepareRuntimeSecretsSnapshot,
      activateRuntimeSecretsSnapshot: vi.fn(),
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
      activateRuntimeSecrets: createRuntimeSecretsActivator({
        logSecrets: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        emitStateEvent: vi.fn(),
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
      activateRuntimeSecrets: createRuntimeSecretsActivator({
        logSecrets: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        emitStateEvent: vi.fn(),
        prepareRuntimeSecretsSnapshot,
        activateRuntimeSecretsSnapshot: vi.fn(),
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
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => ({
      ...preparedSnapshot(config),
      config: {
        ...config,
        gateway: {
          ...config.gateway,
          auth: {
            ...config.gateway?.auth,
            token: "resolved-gateway-token",
          },
        },
      },
    }));
    const activateRuntimeSecretsSnapshot = vi.fn();

    const result = await prepareGatewayStartupConfig({
      configSnapshot: gatewaySecretRefSnapshot(),
      activateRuntimeSecrets: runtimeSecretsActivatorForTest({
        prepareRuntimeSecretsSnapshot,
        activateRuntimeSecretsSnapshot,
      }),
    });

    expect(result.auth.mode).toBe("token");
    expect(result.auth.token).toBe("resolved-gateway-token");
    expect(result.cfg.gateway?.auth?.token).toBe("resolved-gateway-token");
    expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledTimes(1);
    expect(activateRuntimeSecretsSnapshot).toHaveBeenCalledTimes(1);
    expect(activateRuntimeSecretsSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          gateway: expect.objectContaining({
            auth: expect.objectContaining({
              token: "resolved-gateway-token",
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
      config: {
        ...config,
        gateway: {
          ...config.gateway,
          auth: {
            ...config.gateway?.auth,
            token: "resolved-gateway-token",
          },
        },
      },
    }));
    const activateRuntimeSecretsSnapshot = vi.fn();

    const result = await prepareGatewayStartupConfig({
      configSnapshot: gatewaySecretRefSnapshot(),
      activateRuntimeSecrets: runtimeSecretsActivatorForTest({
        prepareRuntimeSecretsSnapshot,
        activateRuntimeSecretsSnapshot,
      }),
    });

    expect(result.auth.mode).toBe("token");
    expect(result.auth.token).toBe("resolved-gateway-token");
    expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledTimes(2);
    expect(activateRuntimeSecretsSnapshot).toHaveBeenCalledTimes(1);
  });

  it("activates no-SecretRef startup config without importing the full secrets runtime", async () => {
    vi.resetModules();
    const agentDir = mkdtempSync(path.join(tmpdir(), "openclaw-startup-fast-path-"));
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
      const { createRuntimeSecretsActivator: createActivator } =
        await import("./server-startup-config.js");
      const { clearSecretsRuntimeSnapshot, getActiveSecretsRuntimeSnapshot } =
        await import("../secrets/runtime-state.js");
      const { getRuntimeConfigSnapshotRefreshHandler } =
        await import("../config/runtime-snapshot.js");
      const result = await createActivator({
        logSecrets: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        emitStateEvent: vi.fn(),
      })(
        gatewayTokenConfig(
          asConfig({
            agents: {
              list: [{ id: "default", agentDir }],
            },
          }),
        ),
        {
          reason: "startup",
          activate: true,
        },
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
    vi.resetModules();
    const agentDir = mkdtempSync(path.join(tmpdir(), "openclaw-startup-secret-ref-"));
    const runtimeImport = vi.fn();
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => preparedSnapshot(config));
    const activateRuntimeSecretsSnapshot = vi.fn();
    installGatewayStartupSecretsRuntimeMock({
      runtimeImport,
      prepareRuntimeSecretsSnapshot,
      activateRuntimeSecretsSnapshot,
    });

    try {
      const { createRuntimeSecretsActivator: createActivator } =
        await import("./server-startup-config.js");
      await createActivator({
        logSecrets: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        emitStateEvent: vi.fn(),
      })(
        gatewayTokenConfig(
          asConfig({
            agents: {
              list: [{ id: "default", agentDir }],
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
        ),
        {
          reason: "startup",
          activate: true,
        },
      );

      expect(runtimeImport).toHaveBeenCalledTimes(1);
      expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledTimes(1);
      expect(activateRuntimeSecretsSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      cleanupGatewayStartupSecretsRuntimeMock();
      rmSync(agentDir, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it("keeps the full secrets runtime path when auth profile files are present", async () => {
    vi.resetModules();
    const agentDir = mkdtempSync(path.join(tmpdir(), "openclaw-startup-auth-store-"));
    writeFileSync(
      path.join(agentDir, "auth-profiles.json"),
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
    const runtimeImport = vi.fn();
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => preparedSnapshot(config));
    const activateRuntimeSecretsSnapshot = vi.fn();
    installGatewayStartupSecretsRuntimeMock({
      runtimeImport,
      prepareRuntimeSecretsSnapshot,
      activateRuntimeSecretsSnapshot,
    });

    try {
      const { createRuntimeSecretsActivator: createActivator } =
        await import("./server-startup-config.js");
      await createActivator({
        logSecrets: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        emitStateEvent: vi.fn(),
      })(
        gatewayTokenConfig(
          asConfig({
            agents: {
              list: [{ id: "default", agentDir }],
            },
          }),
        ),
        {
          reason: "startup",
          activate: true,
        },
      );

      expect(runtimeImport).toHaveBeenCalledTimes(1);
      expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledTimes(1);
      expect(activateRuntimeSecretsSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      cleanupGatewayStartupSecretsRuntimeMock();
      rmSync(agentDir, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});
