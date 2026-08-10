import type { lookup as dnsLookup } from "node:dns";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import net from "node:net";
import tls from "node:tls";
import type {
  AiModelWebSocket,
  AiModelWebSocketConnectOptions,
  AiModelWebSocketResource,
} from "@openclaw/ai";
import { formatModelTransportDebugUrl } from "@openclaw/ai/transports";
import { WebSocket, type ClientOptions } from "ws";
import {
  shouldResolveConfiguredLocalOriginManagedProxyBypass,
  shouldUseConfiguredLocalOriginManagedProxyBypass,
} from "../infra/net/configured-local-origin-bypass.js";
import { resolveEnvNodeProxyUrlForTarget } from "../infra/net/node-proxy-agent.js";
import { resolveActiveManagedProxyTlsOptions } from "../infra/net/proxy/active-managed-proxy-tls.js";
import {
  assertHostnameAllowedWithPolicy,
  resolvePinnedHostnameWithPolicy,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
  type PinnedHostname,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";
import type { Model } from "../llm/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { swapSecretSentinelsInText } from "../secrets/sentinel.js";
import {
  ensureModelProviderLocalService,
  type ProviderLocalServiceLease,
} from "./provider-local-service.js";
import type {
  ResolvedProviderRequestProxyConfig,
  ResolvedProviderRequestTlsConfig,
} from "./provider-request-config.js";
import {
  resolveModelRequestPolicy,
  resolveProviderTransportSsrFPolicy,
  swapSecretSentinelsForEgress,
} from "./provider-transport-fetch.js";

const MODEL_WEBSOCKET_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MODEL_WEBSOCKET_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const MODEL_WEBSOCKET_MAX_BUFFERED_CHUNKS = 1024;
const MODEL_WEBSOCKET_MAX_FRAGMENTS = 1024;
const PROXY_CONNECT_MAX_HEADER_BYTES = 16 * 1024;
const log = createSubsystemLogger("provider-transport-websocket");

type ConnectedSocket = net.Socket | tls.TLSSocket;
type ResolvedWebSocketRoute =
  | {
      kind: "direct";
      pinned: PinnedHostname;
    }
  | {
      kind: "proxy";
      proxyKind: "explicit" | "env";
      targetPinned?: PinnedHostname;
      tls: ResolvedProviderRequestTlsConfig;
      url: URL;
    };

function toHttpPolicyUrl(url: URL): URL {
  const mapped = new URL(url);
  mapped.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return mapped;
}

function resolveEgressText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const swapped = swapSecretSentinelsInText(value);
  const unknown = swapped.unknown[0];
  if (unknown) {
    throw new Error(
      `Secret sentinel ${unknown} is not registered in this process; refusing to open WebSocket`,
    );
  }
  return swapped.text;
}

function resolveTlsOptions(
  config: ResolvedProviderRequestTlsConfig,
): tls.ConnectionOptions & Record<string, unknown> {
  if (!config.configured) {
    return {};
  }
  return {
    ...(config.ca ? { ca: resolveEgressText(config.ca) } : {}),
    ...(config.cert ? { cert: resolveEgressText(config.cert) } : {}),
    ...(config.key ? { key: resolveEgressText(config.key) } : {}),
    ...(config.passphrase ? { passphrase: resolveEgressText(config.passphrase) } : {}),
    ...(config.serverName ? { servername: resolveEgressText(config.serverName) } : {}),
    ...(config.rejectUnauthorized !== undefined
      ? { rejectUnauthorized: config.rejectUnauthorized }
      : {}),
  };
}

function formatConnectAuthority(url: URL, hostnameOverride?: string): string {
  const hostname = (hostnameOverride ?? url.hostname).replace(/^\[|\]$/g, "");
  const port = url.port ? Number(url.port) : url.protocol === "wss:" ? 443 : 80;
  const formattedHost = net.isIPv6(hostname) ? `[${hostname}]` : hostname;
  return `${formattedHost}:${port}`;
}

function buildProxyAuthorization(proxyUrl: URL): string | undefined {
  if (!proxyUrl.username && !proxyUrl.password) {
    return undefined;
  }
  const username = decodeURIComponent(proxyUrl.username);
  const password = decodeURIComponent(proxyUrl.password);
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new DOMException("Request was aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

async function runAbortablePreflight<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return await run();
  }
  throwIfAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = () => finish(() => reject(abortError(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    void run().then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
    );
  });
}

async function waitForConnectedSocket(params: {
  socket: ConnectedSocket;
  event: "connect" | "secureConnect";
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ConnectedSocket> {
  const { socket, event, signal, timeoutMs } = params;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      socket.off(event, onConnected);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
      signal?.removeEventListener("abort", onAbort);
      if (timeoutMs !== undefined) {
        socket.setTimeout(0);
      }
    };
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onConnected = () => finish();
    const onError = (error: Error) => finish(error);
    const onTimeout = () => finish(new Error("WebSocket connection timed out"));
    const onAbort = () => finish(abortError(signal));

    socket.once(event, onConnected);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs !== undefined) {
      socket.setTimeout(timeoutMs);
    }
    if (signal?.aborted) {
      onAbort();
    }
  }).catch((error: unknown) => {
    socket.destroy();
    throw error;
  });
  return socket;
}

async function openPinnedProxySocket(params: {
  proxyUrl: URL;
  proxyTls: ResolvedProviderRequestTlsConfig;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ConnectedSocket> {
  const hostname = params.proxyUrl.hostname.replace(/^\[|\]$/g, "");
  const pinned = await runAbortablePreflight(
    async () =>
      await resolvePinnedHostnameWithPolicy(hostname, {
        // An operator-selected proxy may be private, but exact-host trust still
        // rejects metadata and link-local rebinding answers.
        policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(params.proxyUrl.toString()),
      }),
    params.signal,
  );
  throwIfAborted(params.signal);
  const port = params.proxyUrl.port
    ? Number(params.proxyUrl.port)
    : params.proxyUrl.protocol === "https:"
      ? 443
      : 80;
  if (params.proxyUrl.protocol === "https:") {
    const tlsOptions = resolveTlsOptions(params.proxyTls);
    throwIfAborted(params.signal);
    const socket = tls.connect({
      host: hostname,
      port,
      lookup: pinned.lookup,
      servername: typeof tlsOptions.servername === "string" ? tlsOptions.servername : hostname,
      ALPNProtocols: ["http/1.1"],
      ...tlsOptions,
    });
    return await waitForConnectedSocket({
      socket,
      event: "secureConnect",
      signal: params.signal,
      timeoutMs: params.timeoutMs,
    });
  }
  if (params.proxyUrl.protocol !== "http:") {
    throw new Error("Model WebSocket proxy URL must use http or https");
  }
  throwIfAborted(params.signal);
  const socket = net.connect({ host: hostname, port, lookup: pinned.lookup });
  return await waitForConnectedSocket({
    socket,
    event: "connect",
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
}

async function openProxyTunnel(params: {
  proxyUrl: URL;
  proxyTls: ResolvedProviderRequestTlsConfig;
  targetPinned?: PinnedHostname;
  targetUrl: URL;
  targetTls: ResolvedProviderRequestTlsConfig;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ConnectedSocket> {
  const targetAuthority = formatConnectAuthority(params.targetUrl);
  const connectAuthority = formatConnectAuthority(
    params.targetUrl,
    params.targetPinned?.addresses[0],
  );
  const authorization = buildProxyAuthorization(params.proxyUrl);
  const targetTls =
    params.targetUrl.protocol === "wss:" ? resolveTlsOptions(params.targetTls) : undefined;
  const proxySocket = await openPinnedProxySocket(params);
  let ownedSocket: ConnectedSocket = proxySocket;
  try {
    throwIfAborted(params.signal);
    const requestLines = [
      `CONNECT ${connectAuthority} HTTP/1.1`,
      `Host: ${targetAuthority}`,
      "Proxy-Connection: Keep-Alive",
      ...(authorization ? [`Proxy-Authorization: ${authorization}`] : []),
      "",
      "",
    ];
    proxySocket.write(requestLines.join("\r\n"));

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let buffered = Buffer.alloc(0);
      const cleanup = () => {
        proxySocket.off("data", onData);
        proxySocket.off("error", onError);
        proxySocket.off("timeout", onTimeout);
        params.signal?.removeEventListener("abort", onAbort);
        if (params.timeoutMs !== undefined) {
          proxySocket.setTimeout(0);
        }
      };
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const onData = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.length > PROXY_CONNECT_MAX_HEADER_BYTES) {
          finish(new Error("Proxy CONNECT response headers exceeded the size limit"));
          return;
        }
        const boundary = buffered.indexOf("\r\n\r\n");
        if (boundary === -1) {
          return;
        }
        const header = buffered.subarray(0, boundary).toString("latin1");
        const statusLine = header.split("\r\n", 1)[0] ?? "";
        const match = /^HTTP\/1\.[01]\s+(\d{3})(?:\s|$)/i.exec(statusLine);
        if (!match || match[1] !== "200") {
          finish(new Error(`Proxy CONNECT failed: ${statusLine || "invalid response"}`));
          return;
        }
        const remaining = buffered.subarray(boundary + 4);
        if (remaining.length > 0) {
          proxySocket.unshift(remaining);
        }
        finish();
      };
      const onError = (error: Error) => finish(error);
      const onTimeout = () => finish(new Error("Proxy CONNECT timed out"));
      const onAbort = () => finish(abortError(params.signal));

      proxySocket.on("data", onData);
      proxySocket.once("error", onError);
      proxySocket.once("timeout", onTimeout);
      params.signal?.addEventListener("abort", onAbort, { once: true });
      if (params.timeoutMs !== undefined) {
        proxySocket.setTimeout(params.timeoutMs);
      }
      if (params.signal?.aborted) {
        onAbort();
      }
    });

    if (params.targetUrl.protocol !== "wss:") {
      return proxySocket;
    }
    const hostname = params.targetUrl.hostname.replace(/^\[|\]$/g, "");
    throwIfAborted(params.signal);
    const targetSocket = tls.connect({
      socket: proxySocket,
      servername: typeof targetTls?.servername === "string" ? targetTls.servername : hostname,
      ALPNProtocols: ["http/1.1"],
      ...targetTls,
    });
    ownedSocket = targetSocket;
    return await waitForConnectedSocket({
      socket: targetSocket,
      event: "secureConnect",
      signal: params.signal,
      timeoutMs: params.timeoutMs,
    });
  } catch (error) {
    destroyConnectedSocket(ownedSocket);
    if (ownedSocket !== proxySocket) {
      destroyConnectedSocket(proxySocket);
    }
    throw error;
  }
}

function destroyConnectedSocket(socket: ConnectedSocket): void {
  if (socket.destroyed) {
    return;
  }
  try {
    socket.resetAndDestroy();
  } catch {
    socket.destroy();
  }
}

class ModelWebSocketHandshakeError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number) {
    super(`Unexpected server response: ${statusCode}`);
    this.name = "ModelWebSocketHandshakeError";
    this.statusCode = statusCode;
  }
}

function mergeManagedProxyTls(
  proxyUrl: URL,
  configuredTls: ResolvedProviderRequestTlsConfig,
): ResolvedProviderRequestTlsConfig {
  const managedTls = resolveActiveManagedProxyTlsOptions({ proxyUrl: proxyUrl.href });
  if (!managedTls?.ca || (configuredTls.configured && configuredTls.ca)) {
    return configuredTls;
  }
  return {
    ...(configuredTls.configured ? configuredTls : {}),
    configured: true,
    ca: managedTls.ca,
  };
}

async function resolveWebSocketRoute(
  targetUrl: URL,
  policyUrl: URL,
  modelBaseUrl: string,
  proxy: ResolvedProviderRequestProxyConfig,
  policy: SsrFPolicy | undefined,
  signal?: AbortSignal,
): Promise<ResolvedWebSocketRoute> {
  if (proxy.configured && proxy.mode === "explicit-proxy") {
    const swapped = swapSecretSentinelsForEgress({ url: proxy.proxyUrl }).url;
    const targetPinned = await runAbortablePreflight(
      async () => await resolvePinnedHostnameWithPolicy(targetUrl.hostname, { policy }),
      signal,
    );
    return {
      kind: "proxy",
      proxyKind: "explicit",
      targetPinned,
      url: new URL(swapped),
      tls: mergeManagedProxyTls(new URL(swapped), proxy.tls),
    };
  }
  const envProxy = resolveEnvNodeProxyUrlForTarget(targetUrl);
  if (!envProxy) {
    return {
      kind: "direct",
      pinned: await runAbortablePreflight(
        async () => await resolvePinnedHostnameWithPolicy(targetUrl.hostname, { policy }),
        signal,
      ),
    };
  }
  const managedProxyBypass = {
    kind: "configured-local-origin" as const,
    baseUrl: modelBaseUrl,
  };
  if (
    process.env["OPENCLAW_PROXY_ACTIVE"] === "1" &&
    shouldResolveConfiguredLocalOriginManagedProxyBypass({
      url: policyUrl,
      managedProxyBypass,
    })
  ) {
    const pinned = await runAbortablePreflight(
      async () => await resolvePinnedHostnameWithPolicy(targetUrl.hostname, { policy }),
      signal,
    );
    if (
      shouldUseConfiguredLocalOriginManagedProxyBypass({
        url: policyUrl,
        managedProxyBypass,
        resolvedAddresses: pinned.addresses,
      })
    ) {
      return { kind: "direct", pinned };
    }
  }
  assertHostnameAllowedWithPolicy(targetUrl.hostname, policy);
  const configuredTls =
    proxy.configured && proxy.mode === "env-proxy" ? proxy.tls : { configured: false as const };
  return {
    kind: "proxy",
    proxyKind: "env",
    url: envProxy,
    tls: mergeManagedProxyTls(envProxy, configuredTls),
  };
}

function normalizeHandshakeHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string | readonly string[] | undefined> {
  return { ...headers };
}

function wrapModelSocket(socket: WebSocket): AiModelWebSocket {
  return {
    get readyState() {
      return socket.readyState;
    },
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    addEventListener: (type, listener) => socket.addEventListener(type, listener),
    removeEventListener: (type, listener) => socket.removeEventListener(type, listener),
    send: (data, callback) => {
      if (
        socket.bufferedAmount + Buffer.byteLength(data, "utf8") >
        MODEL_WEBSOCKET_MAX_BUFFERED_BYTES
      ) {
        throw new Error("Model WebSocket buffered payload limit exceeded");
      }
      socket.send(data, callback);
    },
    close: (code, reason) => socket.close(code, reason),
    terminate: () => socket.terminate(),
  };
}

export async function connectGuardedModelWebSocket(
  model: Model,
  options: AiModelWebSocketConnectOptions,
): Promise<AiModelWebSocketResource> {
  let rawTargetUrl: URL;
  try {
    rawTargetUrl = new URL(options.url);
  } catch {
    throw new Error("Model WebSocket URL is invalid");
  }
  if (rawTargetUrl.protocol !== "ws:" && rawTargetUrl.protocol !== "wss:") {
    throw new Error("Model WebSocket URL must use ws or wss");
  }
  if (rawTargetUrl.hash) {
    throw new Error("Model WebSocket URL must not contain a fragment");
  }

  const requestConfig = resolveModelRequestPolicy(model, "websocket");
  if (
    rawTargetUrl.protocol !== "wss:" &&
    requestConfig.policy.endpointClass !== "custom" &&
    requestConfig.policy.endpointClass !== "local"
  ) {
    throw new Error("Public model WebSocket endpoints must use wss");
  }

  const swapped = swapSecretSentinelsForEgress({
    url: options.url,
    headers: options.headers,
  });
  const targetUrl = new URL(swapped.url);
  const headers = Object.fromEntries(swapped.headers?.entries() ?? Object.entries(options.headers));
  const policyUrl = toHttpPolicyUrl(targetUrl);
  const policy = resolveProviderTransportSsrFPolicy({
    baseUrl: model.baseUrl,
    url: policyUrl.toString(),
    allowPrivateNetwork: requestConfig.allowPrivateNetwork,
    trustConfiguredBaseUrlOrigin:
      !requestConfig.privateNetworkExplicitlyDenied &&
      (requestConfig.policy.endpointClass === "custom" ||
        requestConfig.policy.endpointClass === "local"),
  });

  let localServiceLease: ProviderLocalServiceLease | undefined;
  let preparedSocket: ConnectedSocket | undefined;
  let socket: WebSocket | undefined;
  let disposed = false;
  const releaseOwnedResources = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    localServiceLease?.release();
    localServiceLease = undefined;
    preparedSocket?.destroy();
    preparedSocket = undefined;
  };
  const dispose = () => {
    if (!disposed) {
      try {
        if (socket?.readyState === WebSocket.CONNECTING) {
          // `ws` emits an async error when a connecting handshake is terminated.
          // Keep that cleanup signal owned after request-scoped listeners detach.
          socket.once("error", () => {});
          socket.terminate();
        } else if (socket && socket.readyState !== WebSocket.CLOSED) {
          socket.close(1000, "disposed");
        }
      } catch {}
    }
    releaseOwnedResources();
  };
  try {
    localServiceLease = await ensureModelProviderLocalService(model, headers, options.signal);
    const route = await resolveWebSocketRoute(
      targetUrl,
      policyUrl,
      model.baseUrl,
      requestConfig.proxy,
      policy,
      options.signal,
    );
    throwIfAborted(options.signal);
    let lookup: typeof dnsLookup | undefined;
    if (route.kind === "proxy") {
      preparedSocket = await openProxyTunnel({
        proxyUrl: route.url,
        proxyTls: route.tls,
        targetPinned: route.targetPinned,
        targetUrl,
        targetTls: requestConfig.tls,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
    } else {
      lookup = route.pinned.lookup;
    }
    throwIfAborted(options.signal);

    log.debug(
      `[model-websocket] connect provider=${model.provider} api=${model.api} model=${model.id} ` +
        `url=${formatModelTransportDebugUrl(options.url)} proxy=${
          route.kind === "proxy" ? route.proxyKind : "none"
        }`,
    );

    const targetTls = resolveTlsOptions(requestConfig.tls);
    throwIfAborted(options.signal);
    const socketOptions = {
      headers,
      followRedirects: false,
      handshakeTimeout: options.timeoutMs,
      maxPayload: MODEL_WEBSOCKET_MAX_PAYLOAD_BYTES,
      maxBufferedChunks: MODEL_WEBSOCKET_MAX_BUFFERED_CHUNKS,
      maxFragments: MODEL_WEBSOCKET_MAX_FRAGMENTS,
      perMessageDeflate: true,
      ...(lookup ? { lookup } : {}),
      ...(preparedSocket ? { createConnection: () => preparedSocket as ConnectedSocket } : {}),
      ...targetTls,
    };
    socket = new WebSocket(targetUrl, socketOptions as ClientOptions);

    let handshakeHeaders: Record<string, string | readonly string[] | undefined> = {};
    const resource = await new Promise<AiModelWebSocketResource>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        socket?.off("upgrade", onUpgrade);
        socket?.off("unexpected-response", onUnexpectedResponse);
        socket?.off("open", onOpen);
        socket?.off("error", onError);
        socket?.off("close", onClose);
        options.signal?.removeEventListener("abort", onHandshakeAbort);
      };
      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        dispose();
        reject(error);
      };
      const onUpgrade = (response: { headers: IncomingHttpHeaders }) => {
        handshakeHeaders = normalizeHandshakeHeaders(response.headers);
      };
      const onUnexpectedResponse = (_request: unknown, response: IncomingMessage) => {
        response.resume();
        fail(new ModelWebSocketHandshakeError(response.statusCode ?? 500));
      };
      const onOpen = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        socket?.once("close", releaseOwnedResources);
        socket?.once("error", releaseOwnedResources);
        resolve({
          socket: wrapModelSocket(socket as WebSocket),
          handshakeHeaders,
          dispose,
        });
      };
      const onError = (error: Error) => fail(error);
      const onClose = (code: number, reason: Buffer) =>
        fail(new Error(`WebSocket closed ${code} ${reason.toString()}`.trim()));
      const onHandshakeAbort = () => fail(abortError(options.signal));

      socket?.on("upgrade", onUpgrade);
      socket?.once("unexpected-response", onUnexpectedResponse);
      socket?.once("open", onOpen);
      socket?.once("error", onError);
      socket?.once("close", onClose);
      options.signal?.addEventListener("abort", onHandshakeAbort, { once: true });
      if (options.signal?.aborted) {
        onHandshakeAbort();
      }
    });
    return resource;
  } catch (error) {
    dispose();
    throw error;
  }
}
