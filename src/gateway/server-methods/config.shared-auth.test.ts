import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import {
  createConfigHandlerHarness,
  createConfigWriteSnapshot,
  flushConfigHandlerMicrotasks,
} from "./config.test-helpers.js";

const readConfigFileSnapshotForWriteMock = vi.fn();
const writeConfigFileMock = vi.fn();
const validateConfigObjectWithPluginsMock = vi.fn();
const prepareSecretsRuntimeSnapshotMock = vi.fn();
const scheduleGatewaySigusr1RestartMock = vi.fn(() => ({
  scheduled: true,
  delayMs: 1_000,
  coalesced: false,
}));
const restartSentinelMocks = vi.hoisted(() => ({
  writeRestartSentinel: vi.fn(async (_payload: RestartSentinelPayload) => {
    return "/tmp/restart-sentinel.json";
  }),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    createConfigIO: () => ({ configPath: "/tmp/openclaw.json" }),
    readConfigFileSnapshotForWrite: readConfigFileSnapshotForWriteMock,
    validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
    writeConfigFile: writeConfigFileMock,
    replaceConfigFile: async (params: { nextConfig: unknown; writeOptions?: unknown }) =>
      await writeConfigFileMock(params.nextConfig, params.writeOptions),
  };
});

vi.mock("../../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: () => ({ uiHints: undefined }),
}));

vi.mock("../../secrets/runtime.js", () => ({
  getActiveSecretsRuntimeSnapshot: () => null,
  prepareSecretsRuntimeSnapshot: prepareSecretsRuntimeSnapshotMock,
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

afterEach(() => {
  vi.clearAllMocks();
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
});

describe("config shared auth disconnects", () => {
  it("does not disconnect shared-auth clients for config.set auth writes without restart", async () => {
    const prevConfig: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "old-token",
        },
      },
    };
    const nextConfig: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "new-token",
        },
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));

    const { options, disconnectClientsUsingSharedGatewayAuth } = createConfigHandlerHarness({
      method: "config.set",
      params: {
        raw: JSON.stringify(nextConfig, null, 2),
        baseHash: "base-hash",
      },
    });

    await configHandlers["config.set"](options);
    await flushConfigHandlerMicrotasks();

    expect(writeConfigFileMock).toHaveBeenCalledWith(nextConfig, {});
    expect(disconnectClientsUsingSharedGatewayAuth).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
  });

  it("lets the config reloader own hybrid-mode auth restarts", async () => {
    const prevConfig: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "old-token",
        },
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));

    const { options, disconnectClientsUsingSharedGatewayAuth } = createConfigHandlerHarness({
      method: "config.patch",
      params: {
        baseHash: "base-hash",
        raw: JSON.stringify({ gateway: { auth: { token: "new-token" } } }),
        restartDelayMs: 1_000,
      },
    });

    await configHandlers["config.patch"](options);
    await flushConfigHandlerMicrotasks();

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(disconnectClientsUsingSharedGatewayAuth).toHaveBeenCalledTimes(1);
  });

  it("does not disconnect shared-auth clients when config.patch changes only inactive password auth", async () => {
    const prevConfig: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "old-token",
        },
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));

    const { options, disconnectClientsUsingSharedGatewayAuth } = createConfigHandlerHarness({
      method: "config.patch",
      params: {
        baseHash: "base-hash",
        raw: JSON.stringify({ gateway: { auth: { password: "new-password" } } }),
        restartDelayMs: 1_000,
      },
    });

    await configHandlers["config.patch"](options);
    await flushConfigHandlerMicrotasks();

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(disconnectClientsUsingSharedGatewayAuth).not.toHaveBeenCalled();
  });

  it("disconnects gateway-auth clients when active trusted-proxy policy changes", async () => {
    const prevConfig: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-forwarded-user",
            allowUsers: ["alice@example.com"],
          },
        },
        trustedProxies: ["127.0.0.1"],
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));

    const { options, disconnectClientsUsingSharedGatewayAuth } = createConfigHandlerHarness({
      method: "config.patch",
      params: {
        baseHash: "base-hash",
        raw: JSON.stringify({
          gateway: {
            auth: {
              trustedProxy: {
                userHeader: "x-forwarded-user",
                allowUsers: ["bob@example.com"],
              },
            },
          },
        }),
        restartDelayMs: 1_000,
      },
    });

    await configHandlers["config.patch"](options);
    await flushConfigHandlerMicrotasks();

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(disconnectClientsUsingSharedGatewayAuth).toHaveBeenCalledTimes(1);
  });

  it("disconnects gateway-auth clients when trusted-proxy source list changes", async () => {
    const prevConfig: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-forwarded-user",
          },
        },
        trustedProxies: ["127.0.0.1"],
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));

    const { options, disconnectClientsUsingSharedGatewayAuth } = createConfigHandlerHarness({
      method: "config.patch",
      params: {
        baseHash: "base-hash",
        raw: JSON.stringify({
          gateway: {
            trustedProxies: ["10.0.0.10"],
          },
        }),
        restartDelayMs: 1_000,
      },
    });

    await configHandlers["config.patch"](options);
    await flushConfigHandlerMicrotasks();

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(disconnectClientsUsingSharedGatewayAuth).toHaveBeenCalledTimes(1);
  });

  it("does not disconnect gateway-auth clients when trusted-proxy lists are reordered", async () => {
    const prevConfig: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-forwarded-user",
            requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
            allowUsers: ["alice@example.com", "bob@example.com"],
          },
        },
        trustedProxies: ["127.0.0.1", "10.0.0.10"],
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));

    const { options, disconnectClientsUsingSharedGatewayAuth } = createConfigHandlerHarness({
      method: "config.patch",
      params: {
        baseHash: "base-hash",
        raw: JSON.stringify({
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
        }),
        restartDelayMs: 1_000,
      },
    });

    await configHandlers["config.patch"](options);
    await flushConfigHandlerMicrotasks();

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(disconnectClientsUsingSharedGatewayAuth).not.toHaveBeenCalled();
  });

  it("still schedules a direct restart for hot mode when the reloader cannot apply the change", async () => {
    const prevConfig: OpenClawConfig = {
      gateway: {
        reload: {
          mode: "hot",
        },
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));

    const { options } = createConfigHandlerHarness({
      method: "config.patch",
      params: {
        baseHash: "base-hash",
        raw: JSON.stringify({ gateway: { port: 19001 } }),
        restartDelayMs: 1_000,
      },
    });

    await configHandlers["config.patch"](options);
    await flushConfigHandlerMicrotasks();

    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
  });

  it("does not add an agent continuation from generic control-plane sessionKey params", async () => {
    const prevConfig: OpenClawConfig = {
      gateway: {
        reload: {
          mode: "hot",
        },
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));

    const { options } = createConfigHandlerHarness({
      method: "config.patch",
      params: {
        baseHash: "base-hash",
        raw: JSON.stringify({ gateway: { port: 19001 } }),
        restartDelayMs: 1_000,
        sessionKey: "agent:main:main",
      },
    });

    await configHandlers["config.patch"](options);

    expect(restartSentinelMocks.writeRestartSentinel).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
      }),
    );
    const payload = restartSentinelMocks.writeRestartSentinel.mock.calls.at(-1)?.[0];
    expect(payload?.continuation).toBeUndefined();
  });
});
