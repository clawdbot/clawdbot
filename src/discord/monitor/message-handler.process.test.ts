import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const reactMessageDiscord = vi.fn(async () => {});
const removeReactionDiscord = vi.fn(async () => {});

vi.mock("../send.js", () => ({
  reactMessageDiscord: (...args: unknown[]) => reactMessageDiscord(...args),
  removeReactionDiscord: (...args: unknown[]) => removeReactionDiscord(...args),
}));

vi.mock("../../auto-reply/reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: vi.fn(async () => ({
    queuedFinal: false,
    counts: { final: 0, tool: 0, block: 0 },
  })),
}));

vi.mock("../../auto-reply/reply/reply-dispatcher.js", () => ({
  createReplyDispatcherWithTyping: vi.fn(() => ({
    dispatcher: {},
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  })),
}));

import { processDiscordMessage } from "./message-handler.process.js";

async function createBaseContext(overrides: Record<string, unknown> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-discord-"));
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
    ...overrides,
  };
}

beforeEach(() => {
  reactMessageDiscord.mockClear();
  removeReactionDiscord.mockClear();
});

describe("processDiscordMessage ack reactions", () => {
  it("skips ack reactions for group-mentions when mentions are not required", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
    });

    await processDiscordMessage(ctx as any);

    expect(reactMessageDiscord).not.toHaveBeenCalled();
  });

  it("sends ack reactions for mention-gated guild messages when mentioned", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: true,
      effectiveWasMentioned: true,
    });

    await processDiscordMessage(ctx as any);

    expect(reactMessageDiscord).toHaveBeenCalledWith("c1", "m1", "👀", { rest: {} });
  });
});
