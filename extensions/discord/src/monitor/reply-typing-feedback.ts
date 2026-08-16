// Discord plugin module implements reply typing feedback behavior.
import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDiscordRestClient } from "../client.js";
import type { RequestClient } from "../internal/discord.js";
import { sendTyping } from "./typing.js";

// Discord can keep long tool-heavy replies alive, but not forever.
const DISCORD_REPLY_TYPING_MAX_DURATION_MS = 20 * 60_000;

export function createDiscordReplyTypingFeedback(params: {
  cfg: OpenClawConfig;
  token: string;
  accountId: string;
  channelId: string;
  rest?: RequestClient;
  log: (message: string) => void;
  maxDurationMs?: number;
  keepaliveIntervalMs?: number;
}) {
  const rest =
    params.rest ??
    createDiscordRestClient({
      cfg: params.cfg,
      token: params.token,
      accountId: params.accountId,
    }).rest;
  return createTypingCallbacks({
    start: () => sendTyping({ rest, channelId: params.channelId }),
    onStartError: (err) => {
      logTypingFailure({
        log: params.log,
        channel: "discord",
        target: params.channelId,
        error: err,
      });
    },
    keepaliveIntervalMs: params.keepaliveIntervalMs,
    maxDurationMs: params.maxDurationMs ?? DISCORD_REPLY_TYPING_MAX_DURATION_MS,
  });
}
