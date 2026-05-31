import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDiscordRestClient } from "../client.js";
import type { RequestClient } from "../internal/discord.js";
import { sendTyping } from "./typing.js";

export const DISCORD_REPLY_TYPING_MAX_DURATION_MS = 20 * 60_000;

// Discord can keep long tool-heavy replies alive, but not forever.
// The dispatch restart path refreshes this TTL after queue wait time.
export type DiscordReplyTypingFeedback = ReturnType<typeof createTypingCallbacks> & {
  updateChannelId: (channelId: string) => void;
  getChannelId: () => string;
  restartForDispatch: (channelId: string) => void;
};

export function createDiscordReplyTypingFeedback(params: {
  cfg: OpenClawConfig;
  token: string;
  accountId: string;
  channelId: string;
  rest?: RequestClient;
  log: (message: string) => void;
  maxDurationMs?: number;
}): DiscordReplyTypingFeedback {
  let channelId = params.channelId;
  const rest =
    params.rest ??
    createDiscordRestClient({
      cfg: params.cfg,
      token: params.token,
      accountId: params.accountId,
    }).rest;
  const createCallbacks = () =>
    createTypingCallbacks({
      start: () => sendTyping({ rest, channelId }),
      onStartError: (err) => {
        logTypingFailure({
          log: params.log,
          channel: "discord",
          target: channelId,
          error: err,
        });
      },
      maxDurationMs: params.maxDurationMs ?? DISCORD_REPLY_TYPING_MAX_DURATION_MS,
    });
  const updateChannelId = (nextChannelId: string) => {
    const trimmed = nextChannelId.trim();
    if (trimmed) {
      channelId = trimmed;
    }
  };
  let callbacks = createCallbacks();
  return {
    // Expose one stable owner while allowing the inner typing controller to
    // rotate between prequeue feedback and the actual dispatch lifecycle.
    onReplyStart: () => callbacks.onReplyStart(),
    onIdle: () => callbacks.onIdle?.(),
    onCleanup: () => callbacks.onCleanup?.(),
    updateChannelId,
    restartForDispatch: (nextChannelId) => {
      updateChannelId(nextChannelId);
      // Prequeue typing may have hit its TTL before the job starts.
      // Rotate the inner controller so dispatch always owns a live heartbeat.
      callbacks.onCleanup?.();
      callbacks = createCallbacks();
    },
    getChannelId: () => channelId,
  };
}
