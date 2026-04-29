import { RequestClient, type RequestClientOptions } from "@buape/carbon";
import { FormData as UndiciFormData } from "undici";

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
    const signal = AbortSignal.timeout(DISCORD_REST_TIMEOUT_MS);
    if (init?.body instanceof FormData) {
      // Carbon builds global FormData; undici-backed proxy fetch needs undici's
      // FormData class to preserve multipart boundaries.
      return fetchImpl(input, {
        ...init,
        signal,
        body: toUndiciFormData(init.body) as unknown as BodyInit,
      });
    }
    return fetchImpl(input, { ...init, signal });
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
    ...options,
    fetch: wrapDiscordFetch(options.fetch),
  });
}
