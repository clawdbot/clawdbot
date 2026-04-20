import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  listChannelPlugins: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
}));

import { webHandlers } from "./web.js";

function createOptions(
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method: "web.login.start", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      stopChannel: vi.fn(),
      startChannel: vi.fn(),
      getRuntimeSnapshot: vi.fn(
        (): ChannelRuntimeSnapshot => ({
          channels: {
            whatsapp: {
              accountId: "default",
              running: true,
            },
          },
          channelAccounts: {
            whatsapp: {
              default: {
                accountId: "default",
                running: true,
              },
            },
          },
        }),
      ),
    },
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

describe("webHandlers web.login.start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restarts a previously running channel when login start exits early without a QR", async () => {
    const loginWithQrStart = vi.fn().mockResolvedValue({
      code: "whatsapp-auth-unstable",
      message: "retry later",
    });
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "whatsapp",
        gatewayMethods: ["web.login.start"],
        gateway: { loginWithQrStart },
      },
    ]);
    const startChannel = vi.fn();
    const stopChannel = vi.fn();
    const respond = vi.fn();

    await webHandlers["web.login.start"](
      createOptions(
        { accountId: "default" },
        {
          respond,
          context: {
            stopChannel,
            startChannel,
            getRuntimeSnapshot: vi.fn(
              (): ChannelRuntimeSnapshot => ({
                channels: {
                  whatsapp: {
                    accountId: "default",
                    running: true,
                  },
                },
                channelAccounts: {
                  whatsapp: {
                    default: {
                      accountId: "default",
                      running: true,
                    },
                  },
                },
              }),
            ),
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(stopChannel).toHaveBeenCalledWith("whatsapp", "default");
    expect(startChannel).toHaveBeenCalledWith("whatsapp", "default");
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        code: "whatsapp-auth-unstable",
        message: "retry later",
      },
      undefined,
    );
  });

  it("keeps the channel stopped when login start has taken over with a QR flow", async () => {
    const loginWithQrStart = vi.fn().mockResolvedValue({
      qrDataUrl: "data:image/png;base64,qr",
      message: "scan qr",
    });
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "whatsapp",
        gatewayMethods: ["web.login.start"],
        gateway: { loginWithQrStart },
      },
    ]);
    const startChannel = vi.fn();
    const stopChannel = vi.fn();

    await webHandlers["web.login.start"](
      createOptions(
        { accountId: "default" },
        {
          context: {
            stopChannel,
            startChannel,
            getRuntimeSnapshot: vi.fn(
              (): ChannelRuntimeSnapshot => ({
                channels: {
                  whatsapp: {
                    accountId: "default",
                    running: true,
                  },
                },
                channelAccounts: {
                  whatsapp: {
                    default: {
                      accountId: "default",
                      running: true,
                    },
                  },
                },
              }),
            ),
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(stopChannel).toHaveBeenCalledWith("whatsapp", "default");
    expect(startChannel).not.toHaveBeenCalled();
  });
});
