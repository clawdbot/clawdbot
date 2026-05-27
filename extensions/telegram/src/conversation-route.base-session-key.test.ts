import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  testing as conversationBindingTesting,
  registerSessionBindingAdapter,
  type SessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveTelegramConversationBaseSessionKey,
  resolveTelegramConversationRoute,
} from "./conversation-route.js";

describe("resolveTelegramConversationBaseSessionKey", () => {
  const cfg: OpenClawConfig = {};

  beforeEach(() => {
    conversationBindingTesting.resetSessionBindingAdaptersForTests();
  });

  afterEach(() => {
    conversationBindingTesting.resetSessionBindingAdaptersForTests();
  });

  it("keeps default-account DMs on the route session key", () => {
    expect(
      resolveTelegramConversationBaseSessionKey({
        cfg,
        route: {
          agentId: "main",
          accountId: "default",
          matchedBy: "default",
          sessionKey: "agent:main:main",
        },
        chatId: 12345,
        isGroup: false,
        senderId: 12345,
      }),
    ).toBe("agent:main:main");
  });

  it("keeps configured default-account DMs on the route session key", () => {
    expect(
      resolveTelegramConversationBaseSessionKey({
        cfg: {
          channels: {
            telegram: {
              defaultAccount: "work",
              accounts: {
                work: {},
                personal: {},
              },
            },
          },
        },
        route: {
          agentId: "main",
          accountId: "work",
          matchedBy: "default",
          sessionKey: "agent:main:main",
        },
        chatId: 12345,
        isGroup: false,
        senderId: 12345,
      }),
    ).toBe("agent:main:main");
  });

  it("uses the per-account fallback key for named-account DMs without an explicit binding", () => {
    expect(
      resolveTelegramConversationBaseSessionKey({
        cfg,
        route: {
          agentId: "main",
          accountId: "personal",
          matchedBy: "default",
          sessionKey: "agent:main:main",
        },
        chatId: 12345,
        isGroup: false,
        senderId: 12345,
      }),
    ).toBe("agent:main:telegram:personal:direct:12345");
  });

  it("keeps explicit bound DM sessions intact", () => {
    expect(
      resolveTelegramConversationBaseSessionKey({
        cfg,
        route: {
          agentId: "codex-acp",
          accountId: "default",
          matchedBy: "binding.channel",
          sessionKey: "agent:codex-acp:session-dm",
        },
        chatId: 12345,
        isGroup: false,
        senderId: 12345,
      }),
    ).toBe("agent:codex-acp:session-dm");
  });

  it("keeps DM topic isolation on the named-account fallback key", () => {
    const baseSessionKey = resolveTelegramConversationBaseSessionKey({
      cfg,
      route: {
        agentId: "main",
        accountId: "personal",
        matchedBy: "default",
        sessionKey: "agent:main:main",
      },
      chatId: 12345,
      isGroup: false,
      senderId: 12345,
    });

    expect(
      resolveThreadSessionKeys({
        baseSessionKey,
        threadId: "12345:99",
      }).sessionKey,
    ).toBe("agent:main:telegram:personal:direct:12345:thread:12345:99");
  });

  it("keeps inbound DMs on the main route when a stale runtime binding points at a cron run", () => {
    const touch = vi.fn<NonNullable<SessionBindingAdapter["touch"]>>();
    registerSessionBindingAdapter({
      channel: "telegram",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: () => ({
        bindingId: "binding-cron-run",
        targetSessionKey: "agent:youtube:cron:monthly-report:run:closed-run-1",
        targetKind: "session",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "12345",
        },
        status: "active",
        boundAt: 1,
      }),
      touch,
    });

    const result = resolveTelegramConversationRoute({
      cfg: {
        session: {
          dmScope: "main",
        },
      },
      accountId: "default",
      chatId: 12345,
      isGroup: false,
      senderId: 12345,
    });

    expect(touch).not.toHaveBeenCalled();
    expect(result.bindingMode).toEqual({ kind: "none" });
    expect(result.route.agentId).toBe("main");
    expect(result.route.sessionKey).toBe("agent:main:main");
    expect(result.route.matchedBy).toBe("default");
  });

  it("detects plugin-owned runtime bindings without replacing the route", () => {
    const touch = vi.fn<NonNullable<SessionBindingAdapter["touch"]>>();
    registerSessionBindingAdapter({
      channel: "telegram",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: () => ({
        bindingId: "binding-plugin-owned",
        targetSessionKey: "plugin-binding:openclaw-codex-app-server:abc123",
        targetKind: "session",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "-1001234567890:topic:11",
        },
        status: "active",
        boundAt: 1,
        metadata: {
          pluginBindingOwner: "plugin",
          pluginId: "openclaw-codex-app-server",
          pluginRoot: "/tmp/openclaw-codex-app-server",
        },
      }),
      touch,
    });

    const result = resolveTelegramConversationRoute({
      cfg: {
        session: {
          dmScope: "main",
        },
      },
      accountId: "default",
      chatId: -1001234567890,
      isGroup: true,
      resolvedThreadId: 11,
      replyThreadId: 11,
      senderId: 12345,
    });

    expect(touch).toHaveBeenCalledWith("binding-plugin-owned", undefined);
    expect(result.bindingMode).toEqual({ kind: "plugin-owned-runtime" });
    expect(result.route.agentId).toBe("main");
    expect(result.route.sessionKey).toBe("agent:main:telegram:group:-1001234567890:topic:11");
    expect(result.route.matchedBy).toBe("default");
  });
});
