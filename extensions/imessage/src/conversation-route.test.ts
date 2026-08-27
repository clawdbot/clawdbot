// Imessage tests cover conversation route plugin behavior.
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  testing as sessionBindingTesting,
  registerSessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  matchIMessageAcpConversation,
  normalizeIMessageAcpConversationId,
} from "./conversation-id.js";
import { resolveIMessageConversationRoute } from "./conversation-route.js";

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  agents: {
    list: [{ id: "main" }, { id: "codex" }],
  },
  bindings: [{ agentId: "main", match: { channel: "imessage", accountId: "default" } }],
} satisfies OpenClawConfig;

const configuredCfg = {
  ...baseCfg,
  bindings: [
    ...baseCfg.bindings,
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "imessage",
        accountId: "default",
        peer: { kind: "direct", id: "+15555550123" },
      },
    },
  ],
} satisfies OpenClawConfig;

describe("resolveIMessageConversationRoute", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "imessage",
          source: "test",
          plugin: {
            id: "imessage",
            bindings: {
              compileConfiguredBinding: ({ conversationId }) =>
                normalizeIMessageAcpConversationId(conversationId),
              matchInboundConversation: ({ compiledBinding, conversationId }) =>
                matchIMessageAcpConversation({
                  bindingConversationId: compiledBinding.conversationId,
                  conversationId,
                }),
            } satisfies NonNullable<ChannelPlugin["bindings"]>,
          },
        },
      ]),
    );
  });

  afterEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    resetPluginRuntimeStateForTest();
  });

  it("preserves configured ACP binding ownership for deferred target readiness", () => {
    const result = resolveIMessageConversationRoute({
      cfg: configuredCfg,
      accountId: "default",
      isGroup: false,
      peerId: "+15555550123",
      sender: "+15555550123",
    });

    expect(result.route.agentId).toBe("codex");
    expect(result.bindingResolution?.record.conversation).toEqual({
      channel: "imessage",
      accountId: "default",
      conversationId: "+15555550123",
      parentConversationId: undefined,
    });
    expect(result.bindingResolution?.record.targetSessionKey).toBe(result.route.sessionKey);
  });

  it("lets runtime iMessage conversation bindings override default routing", () => {
    const touch = vi.fn();
    registerSessionBindingAdapter({
      channel: "imessage",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "+15555550123"
          ? {
              bindingId: "default:+15555550123",
              targetSessionKey: "agent:codex:acp:bound-1",
              targetKind: "session",
              conversation: {
                channel: "imessage",
                accountId: "default",
                conversationId: "+15555550123",
              },
              status: "active",
              boundAt: Date.now(),
              metadata: { boundBy: "user-1" },
            }
          : null,
      touch,
    });

    const result = resolveIMessageConversationRoute({
      cfg: configuredCfg,
      accountId: "default",
      isGroup: false,
      peerId: "+15555550123",
      sender: "+15555550123",
    });

    expect(result.route.agentId).toBe("codex");
    expect(result.route.sessionKey).toBe("agent:codex:acp:bound-1");
    expect(result.route.matchedBy).toBe("binding.channel");
    expect(result.bindingResolution).toBeNull();
    expect(touch).toHaveBeenCalledWith("default:+15555550123", undefined);
  });
});
