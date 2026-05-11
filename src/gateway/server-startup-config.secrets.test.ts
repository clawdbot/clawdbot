import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import type { PreparedSecretsRuntimeSnapshot, SecretResolverWarning } from "../secrets/runtime.js";
import { KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS } from "./known-weak-gateway-secrets.js";
import {
  createRuntimeSecretsActivator,
  prepareGatewayStartupConfig,
} from "./server-startup-config.js";
import { buildTestConfigSnapshot } from "./test-helpers.config-snapshots.js";

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
  expect(call).toBeDefined();
  return call?.[0] as T;
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
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) =>
      preparedSnapshot({
        ...config,
        gateway: {
          ...config.gateway,
          auth: {
            ...config.gateway?.auth,
            token: "resolved-gateway-token",
          },
        },
      }),
    );

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
            token: { source: "env", provider: "default", id: "GATEWAY_TOKEN_REF" },
          },
        },
      }),
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
    expect(result.auth.token).toBe("resolved-gateway-token");
    expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledTimes(2);
  });
});
