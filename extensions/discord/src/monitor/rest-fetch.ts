import { randomUUID } from "node:crypto";
import { wrapFetchWithAbortSignal } from "openclaw/plugin-sdk/fetch-runtime";
import {
  captureHttpExchange,
  resolveEffectiveDebugProxyUrl,
} from "openclaw/plugin-sdk/proxy-capture";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { withValidatedDiscordProxy } from "../proxy-fetch.js";

export function resolveDiscordRestFetch(
  proxyUrl: string | undefined,
  runtime: RuntimeEnv,
): typeof fetch {
  const effectiveProxyUrl = resolveEffectiveDebugProxyUrl(proxyUrl);
  const fetcher = withValidatedDiscordProxy(effectiveProxyUrl, runtime, (proxy) => {
    const agent = new ProxyAgent(proxy);
    return wrapFetchWithAbortSignal(((input: RequestInfo | URL, init?: RequestInit) =>
      (
        undiciFetch(input as string | URL, {
          ...(init as Record<string, unknown>),
          dispatcher: agent,
        }) as unknown as Promise<Response>
      ).then((response) => {
        captureHttpExchange({
          url: resolveRequestUrl(input),
          method: init?.method ?? "GET",
          requestHeaders: init?.headers as Headers | Record<string, string> | undefined,
          requestBody: (init as RequestInit & { body?: BodyInit | null })?.body ?? null,
          response,
          flowId: randomUUID(),
          meta: { subsystem: "discord-rest" },
        });
        return response;
      })) as typeof fetch);
  });
  if (!fetcher) {
    return fetch;
  }
  runtime.log?.("discord: rest proxy enabled");
  return fetcher;
}
