import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createRequestGatewayMethodRegistry, handleGatewayRequest } from "../server-methods.js";
import type { GatewayRequestContext } from "./types.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("web QR login Gateway dispatch", () => {
  it("routes an alias and forwards the opaque session key through the Gateway", async () => {
    const weixinStart = vi.fn().mockResolvedValue({
      message: "scan",
      sessionKey: "opaque-session",
    });
    const weixinWait = vi.fn().mockResolvedValue({
      connected: true,
      message: "connected",
    });
    const whatsappStart = vi.fn();
    const whatsappWait = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "whatsapp",
          source: "test",
          plugin: {
            id: "whatsapp",
            meta: { aliases: [] },
            gatewayMethods: ["web.login.start", "web.login.wait"],
            gateway: {
              loginWithQrStart: whatsappStart,
              loginWithQrWait: whatsappWait,
            },
          },
        },
        {
          pluginId: "openclaw-weixin",
          source: "test",
          plugin: {
            id: "openclaw-weixin",
            meta: { aliases: ["weixin", "wechat"] },
            gatewayMethods: ["web.login.start", "web.login.wait"],
            gateway: {
              loginWithQrStart: weixinStart,
              loginWithQrWait: weixinWait,
            },
          },
        },
      ]),
    );
    const context = {
      getRuntimeConfig: () => ({}),
      getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
      stopChannel: vi.fn(),
      startChannel: vi.fn(),
      logGateway: { warn: vi.fn(), debug: vi.fn() },
    } as unknown as GatewayRequestContext;
    const client = {
      connId: "conn-test",
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        role: "operator",
        scopes: ["operator.admin"],
        client: { id: "cli", version: "test", platform: "test", mode: "cli" },
      },
    } as never;

    const dispatch = async (
      method: "web.login.start" | "web.login.wait",
      params: Record<string, unknown>,
    ) => {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: method, method, params },
        respond,
        client,
        isWebchatConnect: () => false,
        context,
      });
      return respond;
    };

    const startRespond = await dispatch("web.login.start", { channel: "wechat" });
    const waitRespond = await dispatch("web.login.wait", {
      channel: "weixin",
      sessionKey: "opaque-session",
    });

    expect(whatsappStart).not.toHaveBeenCalled();
    expect(whatsappWait).not.toHaveBeenCalled();
    expect(weixinStart).toHaveBeenCalledWith({
      accountId: undefined,
      force: false,
      timeoutMs: undefined,
      verbose: false,
    });
    expect(weixinWait).toHaveBeenCalledWith({
      accountId: undefined,
      timeoutMs: undefined,
      sessionKey: "opaque-session",
      currentQrDataUrl: undefined,
    });
    expect(startRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sessionKey: "opaque-session" }),
      undefined,
    );
    expect(waitRespond).toHaveBeenCalledWith(
      true,
      { connected: true, message: "connected" },
      undefined,
    );
  });

  it("routes explicit selectors through the registry attached to the request", async () => {
    const globalWhatsappStart = vi.fn();
    const scopedWeixinStart = vi.fn().mockResolvedValue({ connected: true });
    const globalRegistry = createTestRegistry([
      {
        pluginId: "whatsapp",
        source: "test",
        plugin: {
          id: "whatsapp",
          meta: { aliases: [] },
          gatewayMethods: ["web.login.start"],
          gateway: { loginWithQrStart: globalWhatsappStart },
        },
      },
    ]);
    const scopedRegistry = createTestRegistry([
      {
        pluginId: "openclaw-weixin",
        source: "test",
        plugin: {
          id: "openclaw-weixin",
          meta: { aliases: ["wechat"] },
          gatewayMethods: ["web.login.start"],
          gateway: { loginWithQrStart: scopedWeixinStart },
        },
      },
    ]);
    setActivePluginRegistry(globalRegistry);
    const methodRegistry = {
      ...createRequestGatewayMethodRegistry(),
      pluginRegistry: scopedRegistry,
    };
    const respond = vi.fn();
    const context = {
      getRuntimeConfig: () => ({}),
      getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
      stopChannel: vi.fn(),
      startChannel: vi.fn(),
    } as unknown as GatewayRequestContext;

    await handleGatewayRequest({
      methodRegistry,
      req: {
        type: "req",
        id: "scoped",
        method: "web.login.start",
        params: { channel: "wechat" },
      },
      respond,
      client: null,
      isWebchatConnect: () => false,
      context,
    });

    expect(globalWhatsappStart).not.toHaveBeenCalled();
    expect(scopedWeixinStart).toHaveBeenCalledWith({
      accountId: undefined,
      force: false,
      timeoutMs: undefined,
      verbose: false,
    });
    expect(respond).toHaveBeenCalledWith(true, { connected: true }, undefined);
  });
});
