import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { buildFrameworkSlashContext } from "./framework-context-adapter.js";

function createCommandContext(isAuthorizedSender: boolean): PluginCommandContext {
  return {
    senderId: "SENDER_OPENID",
    channel: "qqbot",
    isAuthorizedSender,
    args: "on",
    commandBody: "/bot-streaming on",
    config: {} as OpenClawConfig,
    from: "qqbot:c2c:SENDER_OPENID",
    requestConversationBinding: async () => undefined,
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
  } as unknown as PluginCommandContext;
}

describe("buildFrameworkSlashContext", () => {
  it("preserves the framework authorization decision in the slash context", () => {
    const authorized = buildFrameworkSlashContext({
      ctx: createCommandContext(true),
      account: {
        accountId: "default",
        enabled: true,
        appId: "app",
        clientSecret: "secret",
        secretSource: "config",
        markdownSupport: true,
        config: {},
      },
      from: { msgType: "c2c", targetType: "c2c", targetId: "SENDER_OPENID" },
      commandName: "bot-streaming",
    });
    const unauthorized = buildFrameworkSlashContext({
      ctx: createCommandContext(false),
      account: {
        accountId: "default",
        enabled: true,
        appId: "app",
        clientSecret: "secret",
        secretSource: "config",
        markdownSupport: true,
        config: {},
      },
      from: { msgType: "c2c", targetType: "c2c", targetId: "SENDER_OPENID" },
      commandName: "bot-streaming",
    });

    expect(authorized.commandAuthorized).toBe(true);
    expect(unauthorized.commandAuthorized).toBe(false);
  });
});
