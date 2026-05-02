import {
  EnvHttpProxyAgent,
  FormData as UndiciFormData,
  ProxyAgent,
  fetch as undiciFetch,
} from "undici";
import { logWarn } from "../../logger.js";
import { formatErrorMessage } from "../errors.js";
import { resolveEnvHttpProxyAgentOptions } from "./proxy-env.js";

export const PROXY_FETCH_PROXY_URL = Symbol.for("openclaw.proxyFetch.proxyUrl");
type ProxyFetchWithMetadata = typeof fetch & {
  [PROXY_FETCH_PROXY_URL]?: string;
};

function isFormDataLike(value: unknown): value is FormData {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FormData).entries === "function" &&
    (value as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag] === "FormData"
  );
}

function appendFormDataEntry(target: UndiciFormData, key: string, value: FormDataEntryValue): void {
  if (typeof value === "string") {
    target.append(key, value);
    return;
  }
  const fileName = typeof value.name === "string" && value.name.trim() ? value.name : undefined;
  if (fileName) {
    target.append(key, value, fileName);
    return;
  }
  target.append(key, value);
}

function normalizeInitForUndici(init: RequestInit | undefined): RequestInit | undefined {
  if (!init) {
    return init;
  }
  const body = init.body;
  if (!isFormDataLike(body) || body instanceof UndiciFormData) {
    return init;
  }
  const form = new UndiciFormData();
  for (const [key, value] of body.entries()) {
    appendFormDataEntry(form, key, value);
  }
  const headers = new Headers(init.headers);
  headers.delete("content-length");
  headers.delete("content-type");
  return { ...init, headers, body: form as unknown as BodyInit };
}

/**
 * Create a fetch function that routes requests through the given HTTP proxy.
 * Uses undici's ProxyAgent under the hood.
 */
export function makeProxyFetch(proxyUrl: string): typeof fetch {
  let agent: ProxyAgent | null = null;
  const resolveAgent = (): ProxyAgent => {
    if (!agent) {
      agent = new ProxyAgent(proxyUrl);
    }
    return agent;
  };
  // undici's fetch is runtime-compatible with global fetch but the types diverge
  // on stream/body internals. Single cast at the boundary keeps the rest type-safe.
  const proxyFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as string | URL, {
      ...(normalizeInitForUndici(init) as Record<string, unknown>),
      dispatcher: resolveAgent(),
    }) as unknown as Promise<Response>) as ProxyFetchWithMetadata;
  Object.defineProperty(proxyFetch, PROXY_FETCH_PROXY_URL, {
    value: proxyUrl,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return proxyFetch;
}

export function getProxyUrlFromFetch(fetchImpl?: typeof fetch): string | undefined {
  const proxyUrl = (fetchImpl as ProxyFetchWithMetadata | undefined)?.[PROXY_FETCH_PROXY_URL];
  if (typeof proxyUrl !== "string") {
    return undefined;
  }
  const trimmed = proxyUrl.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve a proxy-aware fetch from standard environment variables.
 * Respects NO_PROXY / no_proxy exclusions via undici's EnvHttpProxyAgent.
 * Returns undefined when no proxy is configured.
 * Gracefully returns undefined if the proxy URL is malformed.
 */
export function resolveProxyFetchFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): typeof fetch | undefined {
  const proxyOptions = resolveEnvHttpProxyAgentOptions(env);
  if (!proxyOptions) {
    return undefined;
  }
  try {
    const agent = new EnvHttpProxyAgent(proxyOptions);
    return ((input: RequestInfo | URL, init?: RequestInit) =>
      undiciFetch(input as string | URL, {
        ...(normalizeInitForUndici(init) as Record<string, unknown>),
        dispatcher: agent,
      }) as unknown as Promise<Response>) as typeof fetch;
  } catch (err) {
    logWarn(
      `Proxy env var set but agent creation failed — falling back to direct fetch: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}
