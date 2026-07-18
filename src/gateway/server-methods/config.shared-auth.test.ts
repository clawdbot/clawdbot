/**
 * Tests shared gateway auth behavior across config method updates.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  createConfigHandlerHarness,
  createConfigWriteSnapshot,
  flushConfigHandlerMicrotasks,
} from "./config.test-helpers.js";

const readConfigFileSnapshotForWriteMock = vi.fn();
const writeConfigFileMock = vi.fn();
const persistedConfigResultMock = vi.fn((config: OpenClawConfig) => config);
const validateConfigObjectWithPluginsMock = vi.fn();
const prepareSecretsRuntimeSnapshotMock = vi.fn();
const scheduleGatewaySigusr1RestartMock = vi.fn(() => ({
  scheduled: true,
  delayMs: 1_000,
  coalesced: false,
}));
const restartSentinelMocks = vi.hoisted(() => ({
  writeRestartSentinel: vi.fn(async (_payload: RestartSentinelPayload) => undefined),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    createConfigIO: () => ({ configPath: "/tmp/openclaw.json" }),
    writeConfigFile: writeConfigFileMock,
    replaceConfigFile: async (params: { nextConfig: OpenClawConfig; writeOptions?: unknown }) => {
      await writeConfigFileMock(params.nextConfig, params.writeOptions);
      const persistedConfig = persistedConfigResultMock(params.nextConfig);
      return {
        path: "/tmp/openclaw.json",
        previousHash: "base-hash",
        snapshot: createConfigWriteSnapshot(params.nextConfig),
        nextConfig: persistedConfig,
        persistedHash: "next-hash",
        afterWrite: { mode: "auto" },
        followUp: { mode: "auto", requiresRestart: false },
      };
    },
  };
});

vi.mock("../../config/io.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/io.js")>("../../config/io.js");
  return {
    ...actual,
    createConfigIO: () => ({ configPath: "/tmp/openclaw.json" }),
    readConfigFileSnapshotForWrite: readConfigFileSnapshotForWriteMock,
  };
});

vi.mock("../../config/validation.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/validation.js")>(
    "../../config/validation.js",
  );
  return {
    ...actual,
    validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
  };
});

vi.mock("../../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: () => ({ uiHints: undefined }),
}));

vi.mock("../../secrets/runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: prepareSecretsRuntimeSnapshotMock,
}));

vi.mock("../../secrets/runtime-state.js", () => ({
  getActiveSecretsRuntimeSnapshot: () => null,
}));

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: scheduleGatewaySigusr1RestartMock,
}));

vi.mock("../../infra/restart-sentinel.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/restart-sentinel.js")>(
    "../../infra/restart-sentinel.js",
  );
  return {
    ...actual,
    writeRestartSentinel: restartSentinelMocks.writeRestartSentinel,
  };
});

const { configHandlers } = await import("./config.js");

const GATEWAY_CONFIG_WRITE_OPTIONS = {
  runtimeRefresh: {
    includeAuthStoreRefs: false,
  },
};

function tokenAuthConfig(token: string): OpenClawConfig {
  return {
    gateway: {
      auth: {
        mode: "token",
        token,
      },
    },
  };
}

function trustedProxyConfig(params: {
  trustedProxies?: string[];
  requiredHeaders?: string[];
  allowUsers?: string[];
}): OpenClawConfig {
  return {
    gateway: {
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          ...(params.requiredHeaders ? { requiredHeaders: params.requiredHeaders } : {}),
          ...(params.allowUsers ? { allowUsers: params.allowUsers } : {}),
        },
      },
      ...(params.trustedProxies ? { trustedProxies: params.trustedProxies } : {}),
    },
  };
}

function hotReloadConfig(): OpenClawConfig {
  return {
    gateway: {
      reload: {
        mode: "hot",
      },
    },
  };
}

function installBrowserReloadRegistry(): void {
  const registry = createTestRegistry([]);
  registry.reloads = [
    {
      pluginId: "browser",
      pluginName: "Browser",
      registration: { restartPrefixes: ["browser"], hotPrefixes: ["browser.profiles"] },
      source: "test",
    },
  ];
  setActivePluginRegistry(registry);
}

function mockPreviousConfig(config: OpenClawConfig): void {
  readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(config));
}

async function runConfigPatch(
  raw: unknown,
  params: { sessionKey?: string; restartDelayMs?: number; replacePaths?: string[] } = {},
) {
  const { options, disconnectClientsUsingSharedGatewayAuth } = createConfigHandlerHarness({
    method: "config.patch",
    params: {
      baseHash: "base-hash",
      raw: typeof raw === "string" ? raw : JSON.stringify(raw),
      restartDelayMs: params.restartDelayMs ?? 1_000,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.replacePaths ? { replacePaths: params.replacePaths } : {}),
    },
  });

  await expectDefined(
    configHandlers["config.patch"],
    'configHandlers["config.patch"] test invariant',
  )(options);
  await flushConfigHandlerMicrotasks();
  return { disconnectClientsUsingSharedGatewayAuth };
}

function expectNoDirectRestart(): void {
  expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.clearAllMocks();
  resetPluginRuntimeStateForTest();
});

beforeEach(() => {
  validateConfigObjectWithPluginsMock.mockImplementation((config: OpenClawConfig) => ({
    ok: true,
    config,
  }));
  prepareSecretsRuntimeSnapshotMock.mockImplementation(
    async ({ config }: { config: OpenClawConfig }) => ({
      config,
    }),
  );
  restartSentinelMocks.writeRestartSentinel.mockClear();
  persistedConfigResultMock.mockImplementation((config: OpenClawConfig) => config);
});

describe("config shared auth disconnects", () => {
  it("returns the persisted config from config.set write results", async () => {
    const prevConfig: OpenClawConfig = {
      gateway: {
        port: 19000,
      },
    };
    const submittedConfig: OpenClawConfig = {
      gateway: {
        port: 19001,
      },
    };
    const persistedConfig: OpenClawConfig = {
      gateway: {
        port: 19001,
      },
      meta: {
        lastTouchedVersion: "test",
      },
    };
    persistedConfigResultMock.mockReturnValueOnce(persistedConfig);
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));

    const { options, respond } = createConfigHandlerHarness({
      method: "config.set",
      params: {
        raw: JSON.stringify(submittedConfig, null, 2),
        baseHash: "base-hash",
      },
    });

    await expectDefined(
      configHandlers["config.set"],
      'configHandlers["config.set"] test invariant',
    )(options);
    await flushConfigHandlerMicrotasks();

    expect(writeConfigFileMock).toHaveBeenCalledWith(submittedConfig, GATEWAY_CONFIG_WRITE_OPTIONS);
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        ok: true,
        path: "/tmp/openclaw.json",
        // Ack hash from the persisted write; equals what config.get reports.
        hash: "next-hash",
        config: persistedConfig,
      },
      undefined,
    );
  });

  it("acks config.apply with the persisted snapshot hash", async () => {
    mockPreviousConfig(tokenAuthConfig("old-token"));

    const { options, respond } = createConfigHandlerHarness({
      method: "config.apply",
      params: {
        raw: JSON.stringify(tokenAuthConfig("new-token"), null, 2),
        baseHash: "base-hash",
        restartDelayMs: 1_000,
      },
    });

    await expectDefined(
      configHandlers["config.apply"],
      'configHandlers["config.apply"] test invariant',
    )(options);
    await flushConfigHandlerMicrotasks();

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, hash: "next-hash" }),
      undefined,
    );
  });

  it("rejects unresolved TTS SecretRefs before config.set writes", async () => {
    const submittedConfig: OpenClawConfig = {
      messages: {
        tts: {
          providers: {
            elevenlabs: {
              apiKey: { source: "env", provider: "default", id: "ELEVENLABS_API_KEY" },
            },
          },
        },
      },
    };
    mockPreviousConfig({});
    prepareSecretsRuntimeSnapshotMock.mockRejectedValueOnce(
      new Error('Environment variable "ELEVENLABS_API_KEY" is missing or empty.'),
    );
    const { options, respond } = createConfigHandlerHarness({
      method: "config.set",
      params: {
        raw: JSON.stringify(submittedConfig),
        baseHash: "base-hash",
      },
    });

    await expectDefined(
      configHandlers["config.set"],
      'configHandlers["config.set"] test invariant',
    )(options);
    await flushConfigHandlerMicrotasks();

    expect(prepareSecretsRuntimeSnapshotMock).toHaveBeenCalledWith({
      config: submittedConfig,
      includeAuthStoreRefs: false,
    });
    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("active SecretRef resolution failed"),
      }),
    );
  });

  it("does not disconnect shared-auth clients for config.set auth writes without restart", async () => {
    const nextConfig = tokenAuthConfig("new-token");
    mockPreviousConfig(tokenAuthConfig("old-token"));

    const { options, disconnectClientsUsingSharedGatewayAuth } = createConfigHandlerHarness({
      method: "config.set",
      params: {
        raw: JSON.stringify(nextConfig, null, 2),
        baseHash: "base-hash",
      },
    });

    await expectDefined(
      configHandlers["config.set"],
      'configHandlers["config.set"] test invariant',
    )(options);
    await flushConfigHandlerMicrotasks();

    expect(writeConfigFileMock).toHaveBeenCalledWith(nextConfig, GATEWAY_CONFIG_WRITE_OPTIONS);
    expect(disconnectClientsUsingSharedGatewayAuth).not.toHaveBeenCalled();
    expectNoDirectRestart();
  });

  it("lets the config reloader own hybrid-mode auth restarts", async () => {
    mockPreviousConfig(tokenAuthConfig("old-token"));

    const { disconnectClientsUsingSharedGatewayAuth } = await runConfigPatch({
      gateway: { auth: { token: "new-token" } },
    });

    expectNoDirectRestart();
    expect(disconnectClientsUsingSharedGatewayAuth).toHaveBeenCalledTimes(1);
  });

  it("does not disconnect shared-auth clients when config.patch changes only inactive password auth", async () => {
    mockPreviousConfig(tokenAuthConfig("old-token"));

    const { disconnectClientsUsingSharedGatewayAuth } = await runConfigPatch({
      gateway: { auth: { password: "new-password" } },
    });

    expectNoDirectRestart();
    expect(disconnectClientsUsingSharedGatewayAuth).not.toHaveBeenCalled();
  });

  it("disconnects gateway-auth clients when active trusted-proxy policy changes", async () => {
    mockPreviousConfig(
      trustedProxyConfig({
        allowUsers: ["alice@example.com"],
        trustedProxies: ["127.0.0.1"],
      }),
    );

    const { disconnectClientsUsingSharedGatewayAuth } = await runConfigPatch(
      {
        gateway: {
          auth: {
            trustedProxy: {
              userHeader: "x-forwarded-user",
              allowUsers: ["bob@example.com"],
            },
          },
        },
      },
      { replacePaths: ["gateway.auth.trustedProxy.allowUsers"] },
    );

    expectNoDirectRestart();
    expect(disconnectClientsUsingSharedGatewayAuth).toHaveBeenCalledTimes(1);
  });

  it("disconnects gateway-auth clients when trusted-proxy source list changes", async () => {
    mockPreviousConfig(
      trustedProxyConfig({
        trustedProxies: ["127.0.0.1"],
      }),
    );

    const { disconnectClientsUsingSharedGatewayAuth } = await runConfigPatch(
      {
        gateway: {
          trustedProxies: ["10.0.0.10"],
        },
      },
      { replacePaths: ["gateway.trustedProxies"] },
    );

    expectNoDirectRestart();
    expect(disconnectClientsUsingSharedGatewayAuth).toHaveBeenCalledTimes(1);
  });

  it("does not disconnect gateway-auth clients when trusted-proxy lists are reordered", async () => {
    mockPreviousConfig(
      trustedProxyConfig({
        requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
        allowUsers: ["alice@example.com", "bob@example.com"],
        trustedProxies: ["127.0.0.1", "10.0.0.10"],
      }),
    );

    const { disconnectClientsUsingSharedGatewayAuth } = await runConfigPatch({
      gateway: {
        auth: {
          trustedProxy: {
            userHeader: "x-forwarded-user",
            requiredHeaders: ["x-forwarded-host", "x-forwarded-proto"],
            allowUsers: ["bob@example.com", "alice@example.com"],
          },
        },
        trustedProxies: ["10.0.0.10", "127.0.0.1"],
      },
    });

    expectNoDirectRestart();
    expect(disconnectClientsUsingSharedGatewayAuth).not.toHaveBeenCalled();
  });

  it("still schedules a direct restart for hot mode when the reloader cannot apply the change", async () => {
    mockPreviousConfig(hotReloadConfig());

    await runConfigPatch({ gateway: { port: 19001 } });

    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
    const payload = restartSentinelMocks.writeRestartSentinel.mock.calls.at(-1)?.[0];
    expect(payload?.stats?.requiresRestart).toBe(true);
  });

  it("marks hot-reloaded config.patch writes as not restart required", async () => {
    const prevConfig: OpenClawConfig = {
      gateway: {
        channelHealthCheckMinutes: 10,
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));

    const { options } = createConfigHandlerHarness({
      method: "config.patch",
      params: {
        baseHash: "base-hash",
        raw: JSON.stringify({ gateway: { channelHealthCheckMinutes: 15 } }),
        restartDelayMs: 1_000,
      },
    });

    await expectDefined(
      configHandlers["config.patch"],
      'configHandlers["config.patch"] test invariant',
    )(options);
    await flushConfigHandlerMicrotasks();

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    const payload = restartSentinelMocks.writeRestartSentinel.mock.calls.at(-1)?.[0];
    expect(payload?.stats?.requiresRestart).toBe(false);
  });

  it("does not schedule a direct restart for hot-mode browser profile config.patch writes", async () => {
    installBrowserReloadRegistry();
    mockPreviousConfig({
      ...hotReloadConfig(),
      browser: {
        profiles: {
          sandbox: {
            cdpUrl: "http://127.0.0.1:9222",
            color: "#0066CC",
          },
        },
      },
    });

    await runConfigPatch({
      browser: {
        profiles: {
          sandbox: {
            cdpUrl: "http://127.0.0.1:9223",
            color: "#0066CC",
          },
        },
      },
    });

    expectNoDirectRestart();
  });

  it("does not add an agent continuation from generic control-plane sessionKey params", async () => {
    mockPreviousConfig(hotReloadConfig());

    await runConfigPatch(
      { gateway: { port: 19001 } },
      {
        sessionKey: "agent:main:main",
      },
    );

    const payload = restartSentinelMocks.writeRestartSentinel.mock.calls.at(-1)?.[0];
    expect(payload?.sessionKey).toBe("agent:main:main");
    expect(payload?.continuation).toBeUndefined();
  });
});
