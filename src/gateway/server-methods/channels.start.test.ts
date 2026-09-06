/**
 * Gateway channels.start method tests.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import { createChannelManager } from "../server-channels.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  readConfigFileSnapshot: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
  getChannelPlugin: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn(),
  getChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: (value: string) => value,
}));

import { channelsHandlers } from "./channels.js";

function createChannelRuntimeSnapshot(running: boolean): ChannelRuntimeSnapshot {
  return {
    channels: {
      whatsapp: {
        accountId: "default-account",
        running,
      },
    },
    channelAccounts: {
      whatsapp: {
        "default-account": {
          accountId: "default-account",
          running,
        },
      },
    },
  };
}

function createOptions(
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method: "channels.start", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      getRuntimeConfig: mocks.getRuntimeConfig,
      startChannel: vi.fn(),
      stopChannel: vi.fn(),
      markChannelLoggedOut: vi.fn(),
      getRuntimeSnapshot: vi.fn(() => createChannelRuntimeSnapshot(true)),
    },
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

async function runChannelsStart(running: boolean) {
  const startChannel = vi.fn(async () => new Map([["default-account", { status: "handed-off" }]]));
  const respond = vi.fn();

  await expectDefined(
    channelsHandlers["channels.start"],
    'channelsHandlers["channels.start"] test invariant',
  )(
    createOptions(
      { channel: "whatsapp" },
      {
        respond,
        context: {
          getRuntimeConfig: mocks.getRuntimeConfig,
          startChannel,
          getRuntimeSnapshot: vi.fn(() => createChannelRuntimeSnapshot(running)),
        } as unknown as GatewayRequestHandlerOptions["context"],
      },
    ),
  );

  return { respond, startChannel };
}

describe("channelsHandlers channels.start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      gateway: { startAccount: vi.fn() },
      config: {
        defaultAccountId: () => "default-account",
        listAccountIds: () => ["default-account"],
        resolveAccount: () => ({}),
      },
    });
  });

  it("resolves the default account and starts the channel runtime", async () => {
    const { respond, startChannel } = await runChannelsStart(true);

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
    });
    expect(startChannel).toHaveBeenCalledWith("whatsapp", "default-account", { manual: true });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        channel: "whatsapp",
        accountId: "default-account",
        started: true,
        outcome: { status: "handed-off" },
      },
      undefined,
    );
  });

  it("reports started=false when the channel runtime remains stopped", async () => {
    const { respond, startChannel } = await runChannelsStart(false);

    expect(startChannel).toHaveBeenCalledWith("whatsapp", "default-account", { manual: true });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        channel: "whatsapp",
        accountId: "default-account",
        started: false,
        outcome: { status: "handed-off" },
      },
      undefined,
    );
  });
});

describe("channelsHandlers channels.stop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      config: {
        defaultAccountId: () => "default-account",
        listAccountIds: () => ["default-account"],
        resolveAccount: () => ({}),
      },
    });
  });

  it("stops a channel account without clearing auth state", async () => {
    const stopChannel = vi.fn(async () => undefined);
    const respond = vi.fn();

    await expectDefined(
      channelsHandlers["channels.stop"],
      'channelsHandlers["channels.stop"] test invariant',
    )(
      createOptions(
        { channel: "whatsapp" },
        {
          respond,
          context: {
            getRuntimeConfig: mocks.getRuntimeConfig,
            stopChannel,
            getRuntimeSnapshot: vi.fn((): ChannelRuntimeSnapshot => ({
              channels: {},
              channelAccounts: {
                whatsapp: {
                  "default-account": {
                    accountId: "default-account",
                    running: false,
                  },
                },
              },
            })),
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(stopChannel).toHaveBeenCalledWith("whatsapp", "default-account");
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        channel: "whatsapp",
        accountId: "default-account",
        stopped: true,
      },
      undefined,
    );
  });
});

describe("channelsHandlers channels.logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: {
        channels: {
          whatsapp: {
            token: { source: "env", provider: "default", id: "WHATSAPP_TOKEN" },
          },
        },
      },
    });
  });

  it("passes the active runtime config to channel plugins", async () => {
    const runtimeConfig = {
      channels: {
        whatsapp: {
          token: "runtime-token",
        },
      },
    };
    const stopChannel = vi.fn();
    const markChannelLoggedOut = vi.fn();
    const logoutAccount = vi.fn(async ({ cfg }: { cfg: typeof runtimeConfig }) => {
      expect(cfg.channels.whatsapp.token).toBe("runtime-token");
      return { cleared: true, envToken: false, loggedOut: true };
    });
    const respond = vi.fn();
    mocks.getRuntimeConfig.mockReturnValue(runtimeConfig);
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      gateway: { logoutAccount },
      config: {
        defaultAccountId: () => "default-account",
        listAccountIds: () => ["default-account"],
        resolveAccount: () => ({}),
      },
    });

    await expectDefined(
      channelsHandlers["channels.logout"],
      'channelsHandlers["channels.logout"] test invariant',
    )(
      createOptions(
        { channel: "whatsapp" },
        {
          respond,
          context: {
            getRuntimeConfig: mocks.getRuntimeConfig,
            stopChannel,
            markChannelLoggedOut,
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(stopChannel).toHaveBeenCalledWith("whatsapp", "default-account");
    expect(markChannelLoggedOut).toHaveBeenCalledWith("whatsapp", true, "default-account");
    expect(logoutAccount).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        channel: "whatsapp",
        accountId: "default-account",
        cleared: true,
        envToken: false,
        loggedOut: true,
      },
      undefined,
    );
  });

  it("does not clear channel auth when runtime teardown fails", async () => {
    const stopChannel = vi.fn(async () => {
      throw new Error("stop failed");
    });
    const logoutAccount = vi.fn(async () => ({ cleared: true, loggedOut: true }));
    const markChannelLoggedOut = vi.fn();
    const respond = vi.fn();
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      gateway: { logoutAccount },
      config: {
        defaultAccountId: () => "default-account",
        listAccountIds: () => ["default-account"],
        resolveAccount: () => ({}),
      },
    });

    await expectDefined(
      channelsHandlers["channels.logout"],
      'channelsHandlers["channels.logout"] test invariant',
    )(
      createOptions(
        { channel: "whatsapp" },
        {
          respond,
          context: {
            getRuntimeConfig: mocks.getRuntimeConfig,
            stopChannel,
            markChannelLoggedOut,
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(logoutAccount).not.toHaveBeenCalled();
    expect(markChannelLoggedOut).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", message: "Error: stop failed" }),
    );
  });
});

describe("channel controls remain independent of diagnostic inspection", () => {
  it.each(["start", "stop"] as const)(
    "controls the default account on %s without inspecting another configured account",
    async (action) => {
      const inspectAccount = vi.fn((_cfg: unknown, accountId?: string | null) => {
        if (accountId === "diagnostic-only") {
          throw new Error("diagnostic inspector unavailable");
        }
        return { accountId, enabled: true, configured: true };
      });
      const startAccount = vi.fn(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
        await new Promise<void>((resolve) => {
          if (abortSignal.aborted) {
            resolve();
            return;
          }
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      });
      const stopAccount = vi.fn(async () => undefined);
      const plugin = {
        ...createChannelTestPluginBase({
          id: "whatsapp",
          config: {
            defaultAccountId: () => "default-account",
            listAccountIds: () => ["default-account", "diagnostic-only"],
            resolveAccount: (_cfg, accountId) => ({ accountId, enabled: true }),
            isConfigured: () => true,
            inspectAccount,
          },
        }),
        gateway: { startAccount, stopAccount },
      };
      const registry = createTestRegistry([{ pluginId: "whatsapp", plugin, source: "test" }]);
      setActivePluginRegistry(registry);
      mocks.getRuntimeConfig.mockReturnValue({});
      mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
      mocks.getChannelPlugin.mockReturnValue(plugin);
      const manager = createChannelManager({
        getRuntimeConfig: mocks.getRuntimeConfig,
        getPluginRegistry: () => registry,
        channelLogs: {},
        channelRuntimeEnvs: {},
      });
      const startChannel = vi.spyOn(manager, "startChannel");
      const stopChannel = vi.spyOn(manager, "stopChannel");
      try {
        if (action === "stop") {
          await manager.startChannel("whatsapp", "default-account");
        }
        const options = createOptions({ channel: "whatsapp" });
        options.context = {
          ...options.context,
          startChannel,
          stopChannel,
          getRuntimeSnapshot: manager.getRuntimeSnapshot,
        };
        await expectDefined(
          channelsHandlers[`channels.${action}`],
          "channel control handler",
        )(options);
        expect(action === "start" ? startChannel : stopChannel).toHaveBeenCalledWith(
          "whatsapp",
          "default-account",
          ...(action === "start" ? [{ manual: true }] : []),
        );
        expect(options.respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            channel: "whatsapp",
            accountId: "default-account",
            [action === "start" ? "started" : "stopped"]: true,
          }),
          undefined,
        );
        expect(inspectAccount).not.toHaveBeenCalled();
      } finally {
        await manager.stopChannel("whatsapp");
        resetPluginRuntimeStateForTest();
        resetGatewayWorkAdmission();
      }
    },
  );
});
