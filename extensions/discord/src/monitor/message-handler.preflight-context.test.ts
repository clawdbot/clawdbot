import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { expect, it, onTestFinished, vi } from "vitest";
import { ChannelType } from "../internal/discord.js";
import { buildDiscordMessageProcessContext } from "./message-handler.context.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  type DiscordClient,
  type DiscordMessageEvent,
} from "./message-handler.preflight.test-helpers.js";

it.each([true, false])(
  "preserves the injected context builder through DM preflight (bound=%s)",
  async (bound) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "discord-preflight-owner-"));
    onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
    const author = { id: "123456789012345678", username: "alice", bot: false };
    const channelId = "234567890123456789";
    const message = createDiscordMessage({
      id: "345678901234567890",
      channelId,
      content: "hello",
      author,
    });
    const data = { channel_id: channelId, author, message } as DiscordMessageEvent;
    const client = {
      fetchChannel: async () => ({ id: channelId, type: ChannelType.DM }),
    } as unknown as DiscordClient;
    const discordConfig = { dmPolicy: "allowlist" as const, allowFrom: [author.id] };
    const cfg = {
      session: { store: path.join(directory, "sessions.json"), dmScope: "per-peer" as const },
      channels: { discord: discordConfig },
    };
    const runtime = { buildContext: buildChannelInboundEventContext };
    const buildContext = vi.spyOn(runtime, "buildContext");
    const preflight = await preflightDiscordMessage({
      ...createDiscordPreflightArgs({ cfg, discordConfig, data, client }),
      allowFrom: discordConfig.allowFrom,
      ...(bound ? { buildContext: runtime.buildContext } : {}),
    });
    expect(preflight).not.toBeNull();
    expect(preflight?.buildContext).toBe(bound ? buildContext : undefined);
    if (!preflight) {
      throw new Error("Expected admitted Discord DM");
    }
    const result = await buildDiscordMessageProcessContext({
      ctx: preflight,
      text: "hello",
      mediaList: [],
    });
    expect(result?.ctxPayload.SessionKey).toBe(preflight.route.sessionKey);
    if (bound) {
      expect(buildContext).toHaveBeenCalledOnce();
      expect(result?.ctxPayload).toBe(await buildContext.mock.results[0]?.value);
    } else {
      expect(buildContext).not.toHaveBeenCalled();
    }
  },
);
