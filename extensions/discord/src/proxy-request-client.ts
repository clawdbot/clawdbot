// Discord plugin module implements proxy request client behavior.
import { RequestClient, type RequestClientOptions } from "./internal/discord.js";

export const DISCORD_REST_TIMEOUT_MS = 15_000;

export function createDiscordRequestClient(
  token: string,
  options?: RequestClientOptions,
): RequestClient {
  if (!options?.fetch) {
    return new RequestClient(token, options);
  }
  return new RequestClient(token, {
    runtimeProfile: "persistent",
    maxQueueSize: 1000,
    timeout: DISCORD_REST_TIMEOUT_MS,
    ...options,
    fetch: options.fetch,
  });
}
