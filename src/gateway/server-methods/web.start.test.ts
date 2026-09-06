/**
 * Tests web.start gateway method behavior and backend launch responses.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  listChannelPlugins: vi.fn(),
  normalizeChannelId: vi.fn(),
  resolveMissingOfficialExternalChannelPluginRepairHints: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
  normalizeChannelId: mocks.normalizeChannelId,
}));

vi.mock("../../plugins/official-external-plugin-repair-hints.js", () => ({
  resolveMissingOfficialExternalChannelPluginRepairHints:
    mocks.resolveMissingOfficialExternalChannelPluginRepairHints,
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
    mocks.normalizeChannelId.mockImplementation((channelId: string) =>
      channelId === "wechat" || channelId === "weixin" ? "openclaw-weixin" : channelId,
    );
    mocks.resolveMissingOfficialExternalChannelPluginRepairHints.mockReturnValue([]);
  });

  it("surfaces the missing official external plugin hint when no web-login provider is loaded", async () => {
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.resolveMissingOfficialExternalChannelPluginRepairHints.mockReturnValue([
      {
        pluginId: "whatsapp",
        channelId: "whatsapp",
        label: "WhatsApp",
        installSpec: "clawhub:@openclaw/whatsapp",
        installCommand: "openclaw plugins install clawhub:@openclaw/whatsapp",
        doctorFixCommand: "openclaw doctor --fix",
        repairHint:
          "Install the official external plugin with: openclaw plugins install clawhub:@openclaw/whatsapp, or run: openclaw doctor --fix.",
      },
    ]);
    const respond = vi.fn();

    await expectDefined(
      webHandlers["web.login.start"],
      'webHandlers["web.login.start"] test invariant',
    )(
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
    expect(mocks.resolveMissingOfficialExternalChannelPluginRepairHints).toHaveBeenCalledWith({
      config: { channels: { whatsapp: { enabled: true } } },
      channelIds: ["whatsapp"],
    });
  });

  it("joins multiple missing official external plugin hints when more than one configured channel is missing", async () => {
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.resolveMissingOfficialExternalChannelPluginRepairHints.mockImplementation(
      ({ channelIds }) =>
        channelIds.flatMap((channelId: string) =>
          channelId === "whatsapp"
            ? [
                {
                  pluginId: "whatsapp",
                  channelId: "whatsapp",
                  label: "WhatsApp",
                  installSpec: "clawhub:@openclaw/whatsapp",
                  installCommand: "openclaw plugins install clawhub:@openclaw/whatsapp",
                  doctorFixCommand: "openclaw doctor --fix",
                  repairHint:
                    "Install the official external plugin with: openclaw plugins install clawhub:@openclaw/whatsapp, or run: openclaw doctor --fix.",
                },
              ]
            : channelId === "signal"
              ? [
                  {
                    pluginId: "signal",
                    channelId: "signal",
                    label: "Signal",
                    installSpec: "clawhub:@openclaw/signal",
                    installCommand: "openclaw plugins install clawhub:@openclaw/signal",
                    doctorFixCommand: "openclaw doctor --fix",
                    repairHint:
                      "Install the official external plugin with: openclaw plugins install clawhub:@openclaw/signal, or run: openclaw doctor --fix.",
                  },
                ]
              : [],
        ),
    );
    const respond = vi.fn();

    await expectDefined(
      webHandlers["web.login.start"],
      'webHandlers["web.login.start"] test invariant',
    )(
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

    await expectDefined(
      webHandlers["web.login.start"],
      'webHandlers["web.login.start"] test invariant',
    )(
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

    await expectDefined(
      webHandlers["web.login.start"],
      'webHandlers["web.login.start"] test invariant',
    )(
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

  it("routes the explicit WeChat alias to its QR-login provider", async () => {
    const whatsappLogin = vi.fn();
    const weixinLogin = vi.fn().mockResolvedValue({
      message: "scan in WeChat",
      qrDataUrl: "data:image/png;base64,weixin-qr",
      sessionKey: "weixin-session",
    });
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "whatsapp",
        gatewayMethods: ["web.login.start", "web.login.wait"],
        gateway: { loginWithQrStart: whatsappLogin, loginWithQrWait: vi.fn() },
      },
      {
        id: "openclaw-weixin",
        gatewayMethods: ["web.login.start", "web.login.wait"],
        gateway: { loginWithQrStart: weixinLogin, loginWithQrWait: vi.fn() },
      },
    ]);
    const respond = vi.fn();

    await expectDefined(
      webHandlers["web.login.start"],
      'webHandlers["web.login.start"] test invariant',
    )(
      createOptions(
        { channel: "wechat", accountId: "work" },
        {
          respond,
        },
      ),
    );

    expect(whatsappLogin).not.toHaveBeenCalled();
    expect(weixinLogin).toHaveBeenCalledWith({
      accountId: "work",
      force: false,
      timeoutMs: undefined,
      verbose: false,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sessionKey: "weixin-session" }),
      undefined,
    );
  });

  it("does not fall back to the first provider for an unknown channel", async () => {
    const whatsappLogin = vi.fn();
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "whatsapp",
        gatewayMethods: ["web.login.start"],
        gateway: { loginWithQrStart: whatsappLogin },
      },
    ]);
    const respond = vi.fn();

    await expectDefined(
      webHandlers["web.login.start"],
      'webHandlers["web.login.start"] test invariant',
    )(
      createOptions(
        { channel: "missing-channel" },
        {
          respond,
        },
      ),
    );

    expect(whatsappLogin).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("keeps the legacy first-provider fallback when channel is omitted", async () => {
    const whatsappLogin = vi.fn().mockResolvedValue({ message: "whatsapp" });
    const weixinLogin = vi.fn();
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "whatsapp",
        gatewayMethods: ["web.login.start"],
        gateway: { loginWithQrStart: whatsappLogin },
      },
      {
        id: "openclaw-weixin",
        gatewayMethods: ["web.login.start"],
        gateway: { loginWithQrStart: weixinLogin },
      },
    ]);
    const respond = vi.fn();

    await expectDefined(
      webHandlers["web.login.start"],
      'webHandlers["web.login.start"] test invariant',
    )(createOptions({}, { respond }));

    expect(whatsappLogin).toHaveBeenCalled();
    expect(weixinLogin).not.toHaveBeenCalled();
  });
});

describe("webHandlers web.login.wait", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.normalizeChannelId.mockImplementation((channelId: string) =>
      channelId === "wechat" || channelId === "weixin" ? "openclaw-weixin" : channelId,
    );
    mocks.resolveMissingOfficialExternalChannelPluginRepairHints.mockReturnValue([]);
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

    await expectDefined(
      webHandlers["web.login.wait"],
      'webHandlers["web.login.wait"] test invariant',
    )(
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
      sessionKey: undefined,
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

  it("routes and correlates the explicit Weixin alias login session", async () => {
    const whatsappWait = vi.fn();
    const weixinWait = vi.fn().mockResolvedValue({ connected: true, message: "connected" });
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "whatsapp",
        gatewayMethods: ["web.login.start", "web.login.wait"],
        gateway: { loginWithQrStart: vi.fn(), loginWithQrWait: whatsappWait },
      },
      {
        id: "openclaw-weixin",
        gatewayMethods: ["web.login.start", "web.login.wait"],
        gateway: { loginWithQrStart: vi.fn(), loginWithQrWait: weixinWait },
      },
    ]);
    const respond = vi.fn();

    await expectDefined(
      webHandlers["web.login.wait"],
      'webHandlers["web.login.wait"] test invariant',
    )(
      createOptions(
        {
          channel: "weixin",
          accountId: "work",
          sessionKey: "weixin-session",
        },
        {
          req: {
            type: "req",
            id: "req-3",
            method: "web.login.wait",
            params: {
              channel: "weixin",
              accountId: "work",
              sessionKey: "weixin-session",
            },
          } as GatewayRequestHandlerOptions["req"],
          respond,
        },
      ),
    );

    expect(whatsappWait).not.toHaveBeenCalled();
    expect(weixinWait).toHaveBeenCalledWith({
      accountId: "work",
      timeoutMs: undefined,
      currentQrDataUrl: undefined,
      sessionKey: "weixin-session",
    });
  });
});
