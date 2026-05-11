import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType } from "../internal/discord.js";

const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  return {
    ...actual,
    getRuntimeConfig: () => loadConfigMock(),
  };
});

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getSessionBindingService,
  registerSessionBindingAdapter,
  type SessionBindingBindInput,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { __testing as sessionBindingTesting } from "openclaw/plugin-sdk/conversation-runtime";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  type DiscordClient,
  type DiscordConfig,
  type DiscordMessageEvent,
} from "./message-handler.preflight.test-helpers.js";

const baseCfg = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
  acp: {
    enabled: true,
    dispatch: {
      enabled: true,
    },
    backend: "acpx",
  },
  channels: {
    discord: {
      threadBindings: {
        enabled: true,
      },
    },
  },
} satisfies OpenClawConfig;

function createDmClient(channelId: string): DiscordClient {
  return {
    fetchChannel: async (id: string) => {
      if (id === channelId) {
        return {
          id: channelId,
          type: ChannelType.DM,
        };
      }
      return null;
    },
  } as unknown as DiscordClient;
}

function createInMemoryDiscordBindingAdapter() {
  const bindings: SessionBindingRecord[] = [];

  const bind = async (input: SessionBindingBindInput) => {
    const normalizedConversation = {
      ...input.conversation,
      parentConversationId:
        input.conversation.parentConversationId ??
        (input.placement === "current" ? input.conversation.conversationId : undefined),
    };
    const record = {
      bindingId: `discord:default:${normalizedConversation.conversationId}`,
      targetSessionKey: input.targetSessionKey,
      targetKind: input.targetKind,
      conversation: normalizedConversation,
      status: "active",
      boundAt: 1,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    } satisfies SessionBindingRecord;
    const existingIndex = bindings.findIndex((entry) => entry.bindingId === record.bindingId);
    if (existingIndex >= 0) {
      bindings.splice(existingIndex, 1, record);
    } else {
      bindings.push(record);
    }
    return record;
  };

  registerSessionBindingAdapter({
    channel: "discord",
    accountId: "default",
    capabilities: {
      placements: ["current", "child"],
      bindSupported: true,
      unbindSupported: true,
    },
    bind,
    listBySession: (targetSessionKey) =>
      bindings.filter((entry) => entry.targetSessionKey === targetSessionKey),
    resolveByConversation: (ref) =>
      bindings.find(
        (entry) =>
          entry.conversation.channel === ref.channel &&
          entry.conversation.accountId === ref.accountId &&
          entry.conversation.conversationId === ref.conversationId,
      ) ?? null,
    unbind: async ({ bindingId, targetSessionKey }) => {
      const removed = bindings.filter(
        (entry) =>
          (bindingId && entry.bindingId === bindingId) ||
          (targetSessionKey && entry.targetSessionKey === targetSessionKey),
      );
      for (const entry of removed) {
        const index = bindings.findIndex((candidate) => candidate.bindingId === entry.bindingId);
        if (index >= 0) {
          bindings.splice(index, 1);
        }
      }
      return removed;
    },
  });

  return { bindings };
}

describe("Discord ACP bind here end-to-end flow", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    loadConfigMock.mockReset().mockReturnValue(baseCfg);
  });

  it("routes the next Discord DM turn to an existing ACP session binding", async () => {
    const adapter = createInMemoryDiscordBindingAdapter();
    const binding = await getSessionBindingService().bind({
      targetSessionKey: "agent:codex:acp:test-session",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:user-1",
        parentConversationId: "user:user-1",
      },
      placement: "current",
      metadata: {
        boundBy: "user-1",
        agentId: "codex",
        label: "codex",
      },
    });

    expect(adapter.bindings).toHaveLength(1);
    expect(binding).toEqual({
      bindingId: "discord:default:user:user-1",
      targetSessionKey: "agent:codex:acp:test-session",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:user-1",
        parentConversationId: "user:user-1",
      },
      status: "active",
      boundAt: 1,
      metadata: {
        boundBy: "user-1",
        agentId: "codex",
        label: "codex",
      },
    });
    expect(
      getSessionBindingService().resolveByConversation({
        channel: "discord",
        accountId: "default",
        conversationId: "user:user-1",
      }),
    ).toEqual(binding);

    const message = createDiscordMessage({
      id: "m-followup-1",
      channelId: "dm-1",
      content: "follow up after bind",
      author: {
        id: "user-1",
        bot: false,
        username: "alice",
      },
    });

    const preflight = await preflightDiscordMessage({
      ...createDiscordPreflightArgs({
        cfg: baseCfg,
        discordConfig: {
          dmPolicy: "open",
        } as DiscordConfig,
        data: {
          channel_id: "dm-1",
          author: message.author,
          message,
        } as DiscordMessageEvent,
        client: createDmClient("dm-1"),
        botUserId: "bot-1",
      }),
      allowFrom: ["*"],
    });

    expect(preflight?.boundSessionKey).toBe(binding.targetSessionKey);
    expect(preflight?.boundAgentId).toBe("codex");
    expect(preflight?.route.sessionKey).toBe(binding.targetSessionKey);
    expect(preflight?.route.agentId).toBe("codex");
    expect(preflight?.threadBinding).toEqual(binding);
  });
});
