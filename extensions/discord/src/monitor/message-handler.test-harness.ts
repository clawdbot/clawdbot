import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

export async function createBaseDiscordMessageContext(
  overrides: Record<string, unknown> = {},
): Promise<DiscordMessagePreflightContext> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-"));
  const storePath = path.join(dir, "sessions.json");
  return {
    cfg: { messages: { ackReaction: "👀" }, session: { store: storePath } },
    discordConfig: {},
    accountId: "default",
    token: "token",
    runtime: { log: () => {}, error: () => {} },
    guildHistories: new Map(),
    historyLimit: 0,
    mediaMaxBytes: 1024,
    textLimit: 4000,
    sender: { label: "user" },
    replyToMode: "off",
    ackReactionScope: "group-mentions",
    groupPolicy: "open",
    data: { guild: { id: "g1", name: "Guild" } },
    client: { rest: {} },
    message: {
      id: "m1",
      channelId: "c1",
      timestamp: new Date().toISOString(),
      attachments: [],
    },
    messageChannelId: "c1",
    author: {
      id: "U1",
      username: "alice",
      discriminator: "0",
      globalName: "Alice",
    },
    channelInfo: { name: "general" },
    channelName: "general",
    isGuildMessage: true,
    isDirectMessage: false,
    isGroupDm: false,
    commandAuthorized: true,
    baseText: "hi",
    messageText: "hi",
    wasMentioned: false,
    shouldRequireMention: true,
    canDetectMention: true,
    effectiveWasMentioned: true,
    shouldBypassMention: false,
    threadChannel: null,
    threadParentId: undefined,
    threadParentName: undefined,
    threadParentType: undefined,
    threadName: undefined,
    displayChannelSlug: "general",
    guildInfo: null,
    guildSlug: "guild",
    channelConfig: null,
    baseSessionKey: "agent:main:discord:guild:g1",
    route: {
      agentId: "main",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:main:discord:guild:g1",
      mainSessionKey: "agent:main:main",
    },
    threadBindings: createNoopThreadBindingManager("default"),
    ...overrides,
  } as unknown as DiscordMessagePreflightContext;
}

export function createDiscordDirectMessageContextOverrides(): Record<string, unknown> {
  return {
    data: { guild: null },
    channelInfo: null,
    channelName: undefined,
    isGuildMessage: false,
    isDirectMessage: true,
    isGroupDm: false,
    shouldRequireMention: false,
    canDetectMention: false,
    effectiveWasMentioned: false,
    displayChannelSlug: "",
    guildInfo: null,
    guildSlug: "",
    baseSessionKey: "agent:main:discord:direct:u1",
    route: {
      agentId: "main",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:main:discord:direct:u1",
      mainSessionKey: "agent:main:main",
    },
  };
}
