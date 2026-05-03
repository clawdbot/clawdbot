import { RequestClient, type RequestClientOptions } from "./internal/discord.js";

type ProxyRequestClientOptions = RequestClientOptions;

export const DISCORD_REST_TIMEOUT_MS = 15_000;

export function createDiscordRequestClient(
  token: string,
  options?: ProxyRequestClientOptions,
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
