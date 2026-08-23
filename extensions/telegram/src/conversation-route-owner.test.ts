import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  type SessionBindingAdapter,
  testing,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectTelegramConversationRouteOwner } from "./conversation-route-owner.js";

describe("inspectTelegramConversationRouteOwner", () => {
  let adapter: SessionBindingAdapter;

  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            id: "telegram",
            meta: { aliases: [] },
            conversationBindings: {
              supportsCurrentConversationBinding: true,
              createManager: () => ({ stop: () => undefined }),
            },
          },
        },
      ]),
    );
    testing.resetSessionBindingAdaptersForTests();
    adapter = {
      channel: "telegram",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: () => null,
    };
    registerSessionBindingAdapter(adapter);
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    testing.resetSessionBindingAdaptersForTests();
  });

  it("replays topic config and runtime precedence without touching liveness", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          groups: { "-100123": { topics: { "42": { agentId: "configured" } } } },
        },
      },
    };
    const touch = vi.fn();
    registerSessionBindingAdapter({
      channel: "telegram",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (conversation) => ({
        bindingId: "binding-topic",
        targetSessionKey: "agent:runtime:bound",
        targetKind: "session",
        conversation,
        status: "active",
        boundAt: 1,
      }),
      touch,
    });

    expect(
      inspectTelegramConversationRouteOwner({
        cfg,
        accountId: "default",
        conversation: { kind: "group", peerId: "-100123:topic:42", threadId: "42" },
      }),
    ).toEqual({ kind: "agent", agentId: "runtime" });
    expect(touch).not.toHaveBeenCalled();
  });

  it("reports a temporary adapter gap only while thread bindings are enabled", () => {
    unregisterSessionBindingAdapter({ channel: "telegram", accountId: "default", adapter });
    const conversation = {
      kind: "group" as const,
      peerId: "-100123:topic:42",
      threadId: "42",
    };

    expect(
      inspectTelegramConversationRouteOwner({ cfg: {}, accountId: "default", conversation }),
    ).toEqual({ kind: "unavailable" });
    expect(
      inspectTelegramConversationRouteOwner({
        cfg: { channels: { telegram: { threadBindings: { enabled: false } } } },
        accountId: "default",
        conversation,
      }),
    ).toEqual({ kind: "agent", agentId: "main" });
  });

  it("keeps the direct sender route separate from its delivery chat", () => {
    const resolveByConversation = vi.fn((conversation) => ({
      bindingId: "binding-dm",
      targetSessionKey: "agent:runtime:bound",
      targetKind: "session" as const,
      conversation,
      status: "active" as const,
      boundAt: 1,
    }));
    registerSessionBindingAdapter({
      channel: "telegram",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation,
    });

    expect(
      inspectTelegramConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: { kind: "direct", peerId: "1001", target: "2002" },
      }),
    ).toEqual({ kind: "agent", agentId: "runtime" });
    expect(resolveByConversation).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "2002" }),
    );
  });
});
