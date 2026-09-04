// Provider WebSocket connector applies the same auth, proxy, TLS, and SSRF policy as provider HTTP.
import http from "node:http";
import type { Agent as HttpAgent } from "node:http";
import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import WebSocket from "ws";
import { resolveProviderTransportSsrFPolicy } from "../../agents/provider-transport-fetch.js";
import { racePromiseWithAbortSignal } from "../abort-signal.js";
import { resolveEnvNodeProxyUrlForTarget } from "./node-proxy-agent.js";
import { resolveActiveManagedProxyTlsOptions } from "./proxy/active-managed-proxy-tls.js";
import {
  assertHostnameAllowedWithPolicy,
  resolvePinnedHostnameWithPolicy,
  type PinnedDispatcherPolicy,
  type SsrFPolicy,
} from "./ssrf.js";

const DEFAULT_PROVIDER_WEBSOCKET_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

type OpenProviderWebSocketParams = {
  allowPrivateNetwork: boolean;
  baseUrl: string;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  headers?: HeadersInit;
  maxPayloadBytes?: number;
  signal?: AbortSignal;
  timeoutMs: number;
  trustConfiguredBaseUrlOrigin: boolean;
  url: string;
};

function toHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }
  return url.toString();
}

function targetTlsOptions(policy: PinnedDispatcherPolicy | undefined): Record<string, unknown> {
  return policy?.mode === "direct" || policy?.mode === "env-proxy" ? { ...policy.connect } : {};
}

function proxyPolicy(
  policy: SsrFPolicy | undefined,
  allowPrivateProxy: boolean,
): SsrFPolicy | undefined {
  if (!policy && !allowPrivateProxy) {
    return undefined;
  }
  return {
    ...policy,
    hostnameAllowlist: undefined,
    ...(allowPrivateProxy ? { allowPrivateNetwork: true } : {}),
  };
}

async function createProxyAgent(params: {
  policy: SsrFPolicy | undefined;
  proxyUrl: URL;
  proxyTls?: Record<string, unknown>;
  allowPrivateProxy: boolean;
}): Promise<HttpAgent> {
  const pinnedProxy = await resolvePinnedHostnameWithPolicy(params.proxyUrl.hostname, {
    policy: proxyPolicy(params.policy, params.allowPrivateProxy),
  });
  return new HttpsProxyAgent(params.proxyUrl, {
    ...params.proxyTls,
    lookup: pinnedProxy.lookup,
  });
}

async function createProviderWebSocketAgent(params: {
  dispatcherPolicy?: PinnedDispatcherPolicy;
  policy: SsrFPolicy | undefined;
  url: URL;
}): Promise<HttpAgent> {
  const targetTls = targetTlsOptions(params.dispatcherPolicy);
  if (params.dispatcherPolicy?.mode === "explicit-proxy") {
    let proxyUrl: URL;
    try {
      proxyUrl = new URL(params.dispatcherPolicy.proxyUrl);
    } catch {
      throw new Error("Invalid explicit proxy URL");
    }
    if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
      throw new Error("Explicit proxy URL must use http or https");
    }
    // The proxy resolves the final target. Check that hostname before sending
    // credentials, and pin the separately configured proxy host in createProxyAgent.
    assertHostnameAllowedWithPolicy(params.url.hostname, params.policy);
    return await createProxyAgent({
      policy: params.policy,
      proxyUrl,
      proxyTls: params.dispatcherPolicy.proxyTls,
      allowPrivateProxy: params.dispatcherPolicy.allowPrivateProxy === true,
    });
  }

  const useEnvProxy =
    params.dispatcherPolicy?.mode === "env-proxy" || params.dispatcherPolicy === undefined;
  const envProxyUrl = useEnvProxy ? resolveEnvNodeProxyUrlForTarget(params.url) : undefined;
  if (envProxyUrl) {
    // Environment proxies are operator-owned DNS boundaries, matching guarded HTTP.
    // The target hostname still passes policy before the handshake carries credentials.
    assertHostnameAllowedWithPolicy(params.url.hostname, params.policy);
    return await createProxyAgent({
      policy: params.policy,
      proxyUrl: envProxyUrl,
      proxyTls:
        params.dispatcherPolicy?.mode === "env-proxy"
          ? params.dispatcherPolicy.proxyTls
          : resolveActiveManagedProxyTlsOptions({ proxyUrl: envProxyUrl.href }),
      allowPrivateProxy: true,
    });
  }

  const pinned = await resolvePinnedHostnameWithPolicy(params.url.hostname, {
    policy: params.policy,
  });
  const options = { keepAlive: false, ...targetTls, lookup: pinned.lookup };
  return params.url.protocol === "wss:" ? new https.Agent(options) : new http.Agent(options);
}

async function resolveAgentWithinDeadline(params: {
  create: () => Promise<HttpAgent>;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<HttpAgent> {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, params.timeoutMs));
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;
  let abandoned = signal.aborted;
  signal.addEventListener(
    "abort",
    () => {
      abandoned = true;
    },
    { once: true },
  );
  const pending = params.create();
  void pending.then(
    (agent) => abandoned && agent.destroy(),
    () => undefined,
  );
  try {
    return await racePromiseWithAbortSignal(pending, signal);
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new Error("Provider WebSocket connection timed out", { cause: error });
    }
    if (params.signal?.aborted) {
      throw new Error("Provider WebSocket connection aborted", { cause: error });
    }
    throw error;
  }
}

/** Opens a provider WebSocket through resolved request policy and pinned network targets. */
export async function openProviderWebSocket(
  params: OpenProviderWebSocketParams,
): Promise<WebSocket> {
  let url: URL;
  try {
    url = new URL(params.url);
  } catch {
    throw new Error("Invalid provider WebSocket URL");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Provider WebSocket URL must use ws or wss");
  }
  const policy = resolveProviderTransportSsrFPolicy({
    baseUrl: toHttpUrl(params.baseUrl),
    url: toHttpUrl(url.toString()),
    allowPrivateNetwork: params.allowPrivateNetwork,
    trustConfiguredBaseUrlOrigin: params.trustConfiguredBaseUrlOrigin,
  });
  const agent = await resolveAgentWithinDeadline({
    create: async () =>
      await createProviderWebSocketAgent({
        dispatcherPolicy: params.dispatcherPolicy,
        policy,
        url,
      }),
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
  let socket: WebSocket;
  try {
    socket = new WebSocket(url, {
      agent,
      headers: Object.fromEntries(new Headers(params.headers).entries()),
      handshakeTimeout: Math.max(1, params.timeoutMs),
      maxPayload: params.maxPayloadBytes ?? DEFAULT_PROVIDER_WEBSOCKET_MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
      ...targetTlsOptions(params.dispatcherPolicy),
    });
  } catch (error) {
    agent.destroy();
    throw error;
  }
  socket.once("close", () => agent.destroy());
  if (params.signal) {
    const onAbort = () => socket.terminate();
    params.signal.addEventListener("abort", onAbort, { once: true });
    socket.once("close", () => params.signal?.removeEventListener("abort", onAbort));
  }
  return socket;
}
