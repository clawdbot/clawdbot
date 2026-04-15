import type { RequestClient } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";

const DISCORD_TYPING_START_TIMEOUT_MS = 5_000;

export async function sendTyping(params: { rest: RequestClient; channelId: string }) {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(`discord typing start timed out after ${DISCORD_TYPING_START_TIMEOUT_MS}ms`),
      );
    }, DISCORD_TYPING_START_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([params.rest.post(Routes.channelTyping(params.channelId)), timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
