import { FormData as UndiciFormData } from "undici";
import { RequestClient, type RequestClientOptions } from "./internal/discord.js";

export type ProxyRequestClientOptions = RequestClientOptions;

export const DISCORD_REST_TIMEOUT_MS = 15_000;

function toUndiciFormData(body: FormData): UndiciFormData {
  const converted = new UndiciFormData();
  for (const [key, value] of body.entries()) {
    if (typeof value === "string") {
      converted.append(key, value);
      continue;
    }
    const filename = (value as Blob & { name?: unknown }).name;
    if (typeof filename === "string" && filename.length > 0) {
      converted.append(key, value, filename);
      continue;
    }
    converted.append(key, value);
  }
  return converted;
}

function wrapDiscordFetch(fetchImpl: NonNullable<RequestClientOptions["fetch"]>) {
  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.body instanceof FormData) {
      // The proxy fetch path needs undici's FormData class to preserve multipart
      // boundaries. Preserve the REST client's AbortController signal so timeout
      // and abortAllRequests keep working.
      return fetchImpl(input, {
        ...init,
        body: toUndiciFormData(init.body) as unknown as BodyInit,
      });
    }
    return fetchImpl(input, init);
  };
}

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
    fetch: wrapDiscordFetch(options.fetch),
  });
}
