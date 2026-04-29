import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { vi } from "vitest";
import type { createDiscordMessageHandler } from "./message-handler.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

export const DEFAULT_DISCORD_BOT_USER_ID = "bot-123";

export function createDiscordHandlerParams(overrides?: {
  botUserId?: string;
  setStatus?: (patch: Record<string, unknown>) => void;
  abortSignal?: AbortSignal;
}): Parameters<typeof createDiscordMessageHandler>[0] {
  const cfg: OpenClawConfig = {
    channels: {
      discord: {
        enabled: true,
        token: "test-token",
        groupPolicy: "allowlist",
      },
    },
    messages: {
      inbound: {
        debounceMs: 0,
      },
    },
  };
  return {
    cfg,
    discordConfig: cfg.channels?.discord,
    accountId: "default",
    token: "test-token",
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    },
    botUserId: overrides?.botUserId ?? DEFAULT_DISCORD_BOT_USER_ID,
    guildHistories: new Map(),
    historyLimit: 0,
    mediaMaxBytes: 10_000,
    textLimit: 2_000,
    replyToMode: "off" as const,
    dmEnabled: true,
    groupDmEnabled: false,
    threadBindings: createNoopThreadBindingManager("default"),
    setStatus: overrides?.setStatus,
    abortSignal: overrides?.abortSignal,
  };
}

export function createDiscordPreflightContext(channelId = "ch-1") {
  return {
    data: {
      channel_id: channelId,
      message: {
        id: `msg-${channelId}`,
        channel_id: channelId,
        attachments: [],
      },
    },
    message: {
      id: `msg-${channelId}`,
      channel_id: channelId,
      attachments: [],
    },
    route: {
      sessionKey: `agent:main:discord:channel:${channelId}`,
    },
    baseSessionKey: `agent:main:discord:channel:${channelId}`,
    messageChannelId: channelId,
  };
}
