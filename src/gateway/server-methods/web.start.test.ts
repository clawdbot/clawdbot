/**
 * Tests web.start gateway method behavior and backend launch responses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  listChannelPlugins: vi.fn(),
  resolveMissingOfficialExternalChannelPluginRepairHint: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
}));

vi.mock("../../plugins/official-external-plugin-repair-hints.js", () => ({
  resolveMissingOfficialExternalChannelPluginRepairHint:
    mocks.resolveMissingOfficialExternalChannelPluginRepairHint,
}));

import { webHandlers } from "./web.js";

function createRunningWhatsappSnapshot(): ChannelRuntimeSnapshot {
  return {
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
  };
}

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
      getRuntimeSnapshot: vi.fn(createRunningWhatsappSnapshot),
      getRuntimeConfig: vi.fn(() => ({ channels: { whatsapp: { enabled: true } } })),
    },
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

function createRunningWhatsappContext() {
  const startChannel = vi.fn();
  const stopChannel = vi.fn();
  return {
    startChannel,
    stopChannel,
    context: {
      stopChannel,
      startChannel,
      getRuntimeSnapshot: vi.fn(createRunningWhatsappSnapshot),
      getRuntimeConfig: vi.fn(() => ({ channels: { whatsapp: { enabled: true } } })),
    } as unknown as GatewayRequestHandlerOptions["context"],
  };
}

describe("webHandlers web.login.start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveMissingOfficialExternalChannelPluginRepairHint.mockReturnValue(null);
  });

  it("surfaces the missing official external plugin hint when no web-login provider is loaded", async () => {
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.resolveMissingOfficialExternalChannelPluginRepairHint.mockReturnValue({
      pluginId: "whatsapp",
      channelId: "whatsapp",
      label: "WhatsApp",
      installSpec: "clawhub:@openclaw/whatsapp",
      installCommand: "openclaw plugins install clawhub:@openclaw/whatsapp",
      doctorFixCommand: "openclaw doctor --fix",
      repairHint:
        "Install the official external plugin with: openclaw plugins install clawhub:@openclaw/whatsapp, or run: openclaw doctor --fix.",
    });
    const respond = vi.fn();

    await webHandlers["web.login.start"](
      createOptions(
        { accountId: "default" },
        {
          respond,
        },
      ),
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message:
          "web login provider is not available. Install the official external plugin with: openclaw plugins install clawhub:@openclaw/whatsapp, or run: openclaw doctor --fix.",
      }),
    );
    expect(mocks.resolveMissingOfficialExternalChannelPluginRepairHint).toHaveBeenCalledWith({
      config: { channels: { whatsapp: { enabled: true } } },
      channelId: "whatsapp",
    });
  });

  it("joins multiple missing official external plugin hints when more than one configured channel is missing", async () => {
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.resolveMissingOfficialExternalChannelPluginRepairHint.mockImplementation(
      ({ channelId }) =>
        channelId === "whatsapp"
          ? {
              pluginId: "whatsapp",
              channelId: "whatsapp",
              label: "WhatsApp",
              installSpec: "clawhub:@openclaw/whatsapp",
              installCommand: "openclaw plugins install clawhub:@openclaw/whatsapp",
              doctorFixCommand: "openclaw doctor --fix",
              repairHint:
                "Install the official external plugin with: openclaw plugins install clawhub:@openclaw/whatsapp, or run: openclaw doctor --fix.",
            }
          : channelId === "signal"
            ? {
                pluginId: "signal",
                channelId: "signal",
                label: "Signal",
                installSpec: "clawhub:@openclaw/signal",
                installCommand: "openclaw plugins install clawhub:@openclaw/signal",
                doctorFixCommand: "openclaw doctor --fix",
                repairHint:
                  "Install the official external plugin with: openclaw plugins install clawhub:@openclaw/signal, or run: openclaw doctor --fix.",
              }
            : null,
    );
    const respond = vi.fn();

    await webHandlers["web.login.start"](
      createOptions(
        { accountId: "default" },
        {
          respond,
          context: {
            stopChannel: vi.fn(),
            startChannel: vi.fn(),
            getRuntimeSnapshot: vi.fn(createRunningWhatsappSnapshot),
            getRuntimeConfig: vi.fn(() => ({
              channels: {
                whatsapp: { enabled: true },
                signal: { enabled: true },
              },
            })),
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message:
          "web login provider is not available. Configured official external channel plugins are missing for WhatsApp, Signal. Install them with: openclaw plugins install clawhub:@openclaw/whatsapp; openclaw plugins install clawhub:@openclaw/signal, or run: openclaw doctor --fix.",
      }),
    );
  });

  it.each([
    {
      name: "leaves a running channel alone when non-forced login start exits early without a QR",
      params: {},
      result: { code: "whatsapp-auth-unstable", message: "retry later" },
      stopsChannel: false,
      restartsChannel: false,
    },
    {
      name: "stops a running channel after non-forced login start takes over with a QR flow",
      params: {},
      result: { qrDataUrl: "data:image/png;base64,qr", message: "scan qr" },
      stopsChannel: true,
      restartsChannel: false,
    },
    {
      name: "stops and restores a running channel around forced login failures without a QR",
      params: { force: true },
      result: { code: "whatsapp-auth-unstable", message: "retry later" },
      stopsChannel: true,
      restartsChannel: true,
    },
  ] as const)("$name", async ({ params, result, stopsChannel, restartsChannel }) => {
    const loginWithQrStart = vi.fn().mockResolvedValue(result);
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "whatsapp",
        gatewayMethods: ["web.login.start"],
        gateway: { loginWithQrStart },
      },
    ]);
    const { context, startChannel, stopChannel } = createRunningWhatsappContext();
    const respond = vi.fn();

    await webHandlers["web.login.start"](
      createOptions(
        { accountId: "default", ...params },
        {
          respond,
          context,
        },
      ),
    );

    if (stopsChannel) {
      expect(stopChannel).toHaveBeenCalledWith("whatsapp", "default");
    } else {
      expect(stopChannel).not.toHaveBeenCalled();
    }
    if (restartsChannel) {
      expect(startChannel).toHaveBeenCalledWith("whatsapp", "default");
    } else {
      expect(startChannel).not.toHaveBeenCalled();
    }
    expect(respond).toHaveBeenCalledWith(true, result, undefined);
  });

  it("preserves gateway method receiver state for login start", async () => {
    const gateway = {
      marker: "gateway-state",
      async loginWithQrStart(this: { marker: string }) {
        return {
          connected: true,
          message: this.marker,
        };
      },
    };
    const loginWithQrStart = vi.spyOn(gateway, "loginWithQrStart");
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "whatsapp",
        gatewayMethods: ["web.login.start"],
        gateway,
      },
    ]);
    const respond = vi.fn();

    await webHandlers["web.login.start"](
      createOptions(
        { accountId: "default" },
        {
          respond,
        },
      ),
    );

    expect(loginWithQrStart).toHaveBeenCalledWith({
      accountId: "default",
      force: false,
      timeoutMs: undefined,
      verbose: false,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        connected: true,
        message: "gateway-state",
      },
      undefined,
    );
  });
});

describe("webHandlers web.login.wait", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveMissingOfficialExternalChannelPluginRepairHint.mockReturnValue(null);
  });

  it("passes refreshed QR payloads back to the client while login is still pending", async () => {
    const loginWithQrWait = vi.fn().mockResolvedValue({
      connected: false,
      message: "QR refreshed. Scan the latest code in WhatsApp → Linked Devices.",
      qrDataUrl: "data:image/png;base64,next-qr",
    });
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "whatsapp",
        gatewayMethods: ["web.login.wait"],
        gateway: { loginWithQrWait },
      },
    ]);
    const respond = vi.fn();

    await webHandlers["web.login.wait"](
      createOptions(
        {
          accountId: "default",
          timeoutMs: 5000,
          currentQrDataUrl: "data:image/png;base64,current-qr",
        },
        {
          req: {
            type: "req",
            id: "req-2",
            method: "web.login.wait",
            params: {
              accountId: "default",
              timeoutMs: 5000,
              currentQrDataUrl: "data:image/png;base64,current-qr",
            },
          } as GatewayRequestHandlerOptions["req"],
          respond,
        },
      ),
    );

    expect(loginWithQrWait).toHaveBeenCalledWith({
      accountId: "default",
      timeoutMs: 5000,
      currentQrDataUrl: "data:image/png;base64,current-qr",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        connected: false,
        message: "QR refreshed. Scan the latest code in WhatsApp → Linked Devices.",
        qrDataUrl: "data:image/png;base64,next-qr",
      },
      undefined,
    );
  });
});
