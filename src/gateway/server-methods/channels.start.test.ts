/**
 * Gateway channels.start method tests.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
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
  const startChannel = vi.fn();
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
            getRuntimeSnapshot: vi.fn(
              (): ChannelRuntimeSnapshot => ({
                channels: {},
                channelAccounts: {
                  whatsapp: {
                    "default-account": {
                      accountId: "default-account",
                      running: false,
                    },
                  },
                },
              }),
            ),
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
});
