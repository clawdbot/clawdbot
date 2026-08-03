import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock, getAccessTokenMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  getAccessTokenMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return { ...actual, fetchWithSsrFGuard: fetchWithSsrFGuardMock };
});

vi.mock("../../engine/messaging/sender.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../engine/messaging/sender.js")>();
  return { ...actual, getAccessToken: getAccessTokenMock };
});

import { ensurePlatformAdapter } from "../bootstrap.js";
import { registerChannelTool } from "./channel.js";

const cfg = {
  channels: {
    qqbot: {
      appId: "app-a",
      clientSecret: "secret-a",
      accounts: {
        bot2: {
          appId: "app-b",
          clientSecret: "secret-b",
        },
      },
    },
  },
} as OpenClawConfig;

function registerToolFactory(
  config: OpenClawConfig = cfg,
): (context: OpenClawPluginToolContext) => AnyAgentTool | null {
  let factory: ((context: OpenClawPluginToolContext) => AnyAgentTool | null) | undefined;
  const api = {
    config,
    registerTool(
      tool: AnyAgentTool | ((context: OpenClawPluginToolContext) => AnyAgentTool | null),
    ) {
      if (typeof tool === "function") {
        factory = tool;
      }
    },
  } as unknown as OpenClawPluginApi;
  registerChannelTool(api);
  if (!factory) {
    throw new Error("Expected QQBot channel API tool factory");
  }
  return factory;
}

describe("bridge/tools/channel", () => {
  beforeEach(() => {
    ensurePlatformAdapter();
    getAccessTokenMock.mockImplementation(
      async (appId: string, secret: string) => `token-for-${appId}-${secret}`,
    );
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(JSON.stringify([{ id: "guild-1" }]), { status: 200 }),
      release: vi.fn(async () => {}),
    });
  });

  afterEach(() => {
    getAccessTokenMock.mockReset();
    fetchWithSsrFGuardMock.mockReset();
  });

  it("uses the active QQBot account for token acquisition and API authorization", async () => {
    const tool = registerToolFactory()({ messageChannel: "qqbot", agentAccountId: "bot2" });
    expect(tool).not.toBeNull();

    await tool?.execute("call-b", { method: "GET", path: "/users/@me/guilds" });

    expect(getAccessTokenMock).toHaveBeenCalledWith("app-b", "secret-b");
    expect(getAccessTokenMock).not.toHaveBeenCalledWith("app-a", "secret-a");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        init: expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "QQBot token-for-app-b-secret-b",
          }),
        }),
      }),
    );
  });

  it("uses the configured default account without an active account", async () => {
    const configuredDefault = {
      ...cfg,
      channels: {
        qqbot: {
          ...cfg.channels?.qqbot,
          defaultAccount: "bot2",
        },
      },
    } as OpenClawConfig;
    const tool = registerToolFactory(configuredDefault)({});
    expect(tool).not.toBeNull();

    await tool?.execute("call-default", { method: "GET", path: "/users/@me/guilds" });

    expect(getAccessTokenMock).toHaveBeenCalledWith("app-b", "secret-b");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        init: expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "QQBot token-for-app-b-secret-b",
          }),
        }),
      }),
    );
  });

  it("does not expose the tool when the active account has no credentials", () => {
    expect(
      registerToolFactory()({ messageChannel: "qqbot", agentAccountId: "missing" }),
    ).toBeNull();
    expect(getAccessTokenMock).not.toHaveBeenCalled();
  });

  it("does not expose the tool when the active account is disabled", () => {
    const disabledAccount = {
      ...cfg,
      channels: {
        qqbot: {
          ...cfg.channels?.qqbot,
          accounts: {
            bot2: {
              ...cfg.channels?.qqbot?.accounts?.bot2,
              enabled: false,
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      registerToolFactory(disabledAccount)({
        messageChannel: "qqbot",
        agentAccountId: "bot2",
      }),
    ).toBeNull();
    expect(getAccessTokenMock).not.toHaveBeenCalled();
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("does not treat another channel's account ID as a QQBot account", async () => {
    const tool = registerToolFactory()({ messageChannel: "discord", agentAccountId: "bot2" });
    expect(tool).not.toBeNull();

    await tool?.execute("call-discord", { method: "GET", path: "/users/@me/guilds" });

    expect(getAccessTokenMock).toHaveBeenCalledWith("app-a", "secret-a");
    expect(getAccessTokenMock).not.toHaveBeenCalledWith("app-b", "secret-b");
  });
});
