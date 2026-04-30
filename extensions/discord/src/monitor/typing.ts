import { sendChannelTyping, type RequestClient } from "../internal/discord.js";
import { raceWithTimeout } from "./timeouts.js";

const DISCORD_TYPING_START_TIMEOUT_MS = 5_000;

export async function sendTyping(params: { rest: RequestClient; channelId: string }) {
  const result = await raceWithTimeout({
    promise: sendChannelTyping(params.rest, params.channelId).then(() => ({
      kind: "sent" as const,
    })),
    timeoutMs: DISCORD_TYPING_START_TIMEOUT_MS,
    onTimeout: () => ({ kind: "timeout" as const }),
  });
  if (result.kind === "timeout") {
    throw new Error(`discord typing start timed out after ${DISCORD_TYPING_START_TIMEOUT_MS}ms`);
  }
}
