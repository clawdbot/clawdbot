import type { Api, Model } from "@mariozechner/pi-ai";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { resolveDebugProxySettings } from "../proxy-capture/env.js";
import {
  buildProviderRequestDispatcherPolicy,
  getModelProviderRequestTransport,
  mergeModelProviderRequestOverrides,
  resolveProviderRequestPolicyConfig,
} from "./provider-request-config.js";

const DEFAULT_MAX_SDK_RETRY_WAIT_SECONDS = 60;

function parseRetryAfterSeconds(headers: Headers): number | undefined {
  const retryAfterMs = headers.get("retry-after-ms");
  if (retryAfterMs) {
    const milliseconds = Number.parseFloat(retryAfterMs);
    if (Number.isFinite(milliseconds) && milliseconds >= 0) {
      return milliseconds / 1000;
    }
  }

  const retryAfter = headers.get("retry-after");
  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }

  const retryAt = Date.parse(retryAfter);
  if (Number.isNaN(retryAt)) {
    return undefined;
  }

  return Math.max(0, (retryAt - Date.now()) / 1000);
}

function resolveMaxSdkRetryWaitSeconds(): number | undefined {
  const raw = process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS?.trim();
  if (!raw) {
    return DEFAULT_MAX_SDK_RETRY_WAIT_SECONDS;
  }

  if (/^(?:0|false|off|none|disabled)$/i.test(raw)) {
    return undefined;
  }

  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds;
  }

  return DEFAULT_MAX_SDK_RETRY_WAIT_SECONDS;
}

function shouldBypassLongSdkRetry(response: Response): boolean {
  const maxWaitSeconds = resolveMaxSdkRetryWaitSeconds();
  if (maxWaitSeconds === undefined) {
    return false;
  }

  const status = response.status;
  const stainlessRetryable = status === 408 || status === 409 || status === 429 || status >= 500;
  if (!stainlessRetryable) {
    return false;
  }

  const retryAfterSeconds = parseRetryAfterSeconds(response.headers);
  return retryAfterSeconds !== undefined && retryAfterSeconds > maxWaitSeconds;
}

function buildManagedResponse(response: Response, release: () => Promise<void>): Response {
  if (!response.body) {
    void release();
    return response;
  }
  const source = response.body;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let released = false;
  const finalize = async () => {
    if (released) {
      return;
    }
    released = true;
    await release().catch(() => undefined);
  };
  const wrappedBody = new ReadableStream<Uint8Array>({
    start() {
      reader = source.getReader();
    },
    async pull(controller) {
      try {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) {
          controller.close();
          await finalize();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
        await finalize();
      }
    },
    async cancel(reason) {
      try {
        await reader?.cancel(reason);
      } finally {
        await finalize();
      }
    },
  });
  return new Response(wrappedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function resolveModelRequestPolicy(model: Model<Api>) {
  const debugProxy = resolveDebugProxySettings();
  let explicitDebugProxyUrl: string | undefined;
  if (debugProxy.enabled && debugProxy.proxyUrl) {
    try {
      if (new URL(model.baseUrl).protocol === "https:") {
        explicitDebugProxyUrl = debugProxy.proxyUrl;
      }
    } catch {
      // Non-URL provider base URLs cannot use the debug proxy override safely.
    }
  }
  const request = mergeModelProviderRequestOverrides(getModelProviderRequestTransport(model), {
    proxy: explicitDebugProxyUrl
      ? {
          mode: "explicit-proxy",
          url: explicitDebugProxyUrl,
        }
      : undefined,
  });
  return resolveProviderRequestPolicyConfig({
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    capability: "llm",
    transport: "stream",
    request,
    allowPrivateNetwork: request?.allowPrivateNetwork === true,
  });
}

export function buildGuardedModelFetch(model: Model<Api>): typeof fetch {
  const requestConfig = resolveModelRequestPolicy(model);
  const dispatcherPolicy = buildProviderRequestDispatcherPolicy(requestConfig);
  return async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : undefined;
    const url =
      request?.url ??
      (input instanceof URL
        ? input.toString()
        : typeof input === "string"
          ? input
          : (() => {
              throw new Error("Unsupported fetch input for transport-aware model request");
            })());
    const requestInit =
      request &&
      ({
        method: request.method,
        headers: request.headers,
        body: request.body ?? undefined,
        redirect: request.redirect,
        signal: request.signal,
        ...(request.body ? ({ duplex: "half" } as const) : {}),
      } satisfies RequestInit & { duplex?: "half" });
    const result = await fetchWithSsrFGuard({
      url,
      init: requestInit ?? init,
      capture: {
        meta: {
          provider: model.provider,
          api: model.api,
          model: model.id,
        },
      },
      dispatcherPolicy,
      // Provider transport intentionally keeps the secure default and never
      // replays unsafe request bodies across cross-origin redirects.
      allowCrossOriginUnsafeRedirectReplay: false,
      ...(requestConfig.allowPrivateNetwork ? { policy: { allowPrivateNetwork: true } } : {}),
    });
    let response = result.response;
    if (shouldBypassLongSdkRetry(response)) {
      const headers = new Headers(response.headers);
      headers.set("x-should-retry", "false");
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return buildManagedResponse(response, result.release);
  };
}
