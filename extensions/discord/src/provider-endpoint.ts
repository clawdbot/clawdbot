// Discord plugin module owns private alternate-provider endpoint routing.
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import {
  fetchWithSsrFGuard,
  isBlockedHostnameOrIp,
  isLoopbackHost,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  DISCORD_PROVIDER_ENDPOINT_ENV_KEYS,
  type DiscordProviderEndpointDescriptor,
} from "./provider-endpoint.constants.js";

const DISCORD_PROVIDER_ENDPOINT_ENV_MAX_BYTES = 8 * 1024;
const DISCORD_PROVIDER_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const DISCORD_PROVIDER_ENDPOINT_REQUIRED_ENV = Object.values(DISCORD_PROVIDER_ENDPOINT_ENV_KEYS);

type DiscordProviderEndpointRuntime = Readonly<{
  descriptor: DiscordProviderEndpointDescriptor;
  fetch: typeof fetch;
}>;

type DiscordProviderEndpointInitialization =
  | Readonly<{ status: "uninitialized" }>
  | Readonly<{ status: "initialized"; runtime: DiscordProviderEndpointRuntime | undefined }>
  | Readonly<{ status: "failed"; error: Error }>;

let providerEndpointInitialization: DiscordProviderEndpointInitialization = {
  status: "uninitialized",
};

function parseHttpAnchor(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error(`${label} must use HTTPS or loopback HTTP`);
  }
  if (url.username || url.password || url.hash) {
    throw new Error(`${label} must not contain credentials or a fragment`);
  }
  return url;
}

function normalizeRestApiBaseUrl(value: string): URL {
  const url = parseHttpAnchor(value, "Discord provider REST API base URL");
  if (url.search) {
    throw new Error("Discord provider REST API base URL must not contain a query");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url;
}

function normalizeGatewayOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Discord provider Gateway origin must be a valid URL");
  }
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && isLoopbackHost(url.hostname))) {
    throw new Error("Discord provider Gateway origin must use WSS or loopback WS");
  }
  // IP literals bypass the HTTPS agent's DNS lookup, so reject blocked targets here;
  // known local and metadata hostnames should fail before any token-bearing socket starts.
  if (url.protocol === "wss:" && isBlockedHostnameOrIp(url.hostname)) {
    throw new Error(
      "Discord provider Gateway origin must not target a private/internal/special-use hostname or IP address",
    );
  }
  if (url.username || url.password || url.hash) {
    throw new Error("Discord provider Gateway origin must not contain credentials or a fragment");
  }
  if (url.pathname !== "/" || url.search) {
    throw new Error("Discord provider Gateway origin must not contain a path or query");
  }
  return url.origin;
}

function normalizeDescriptor(
  descriptor: DiscordProviderEndpointDescriptor,
): DiscordProviderEndpointDescriptor {
  const restApiBaseUrl = normalizeRestApiBaseUrl(descriptor.restApiBaseUrl);
  const gatewayBotUrl = parseHttpAnchor(
    descriptor.gatewayBotUrl,
    "Discord provider Gateway metadata URL",
  );
  return Object.freeze({
    restApiBaseUrl: restApiBaseUrl.toString().replace(/\/$/u, ""),
    gatewayBotUrl: gatewayBotUrl.toString(),
    gatewayOrigin: normalizeGatewayOrigin(descriptor.gatewayOrigin),
  });
}

function parseProviderEndpointEnv(
  env: NodeJS.ProcessEnv,
): DiscordProviderEndpointDescriptor | undefined {
  const rawDescriptor = {
    restApiBaseUrl: env[DISCORD_PROVIDER_ENDPOINT_ENV_KEYS.restApiBaseUrl],
    gatewayBotUrl: env[DISCORD_PROVIDER_ENDPOINT_ENV_KEYS.gatewayBotUrl],
    gatewayOrigin: env[DISCORD_PROVIDER_ENDPOINT_ENV_KEYS.gatewayOrigin],
  };
  const rawBytes = Object.values(rawDescriptor).reduce(
    (total, value) => total + Buffer.byteLength(value ?? "", "utf8"),
    0,
  );
  if (rawBytes > DISCORD_PROVIDER_ENDPOINT_ENV_MAX_BYTES) {
    throw new Error(
      `Discord provider endpoint environment exceeds ${DISCORD_PROVIDER_ENDPOINT_ENV_MAX_BYTES} aggregate bytes`,
    );
  }
  const descriptor = {
    restApiBaseUrl: rawDescriptor.restApiBaseUrl?.trim() ?? "",
    gatewayBotUrl: rawDescriptor.gatewayBotUrl?.trim() ?? "",
    gatewayOrigin: rawDescriptor.gatewayOrigin?.trim() ?? "",
  };
  const configuredValues = Object.values(descriptor).filter(Boolean).length;
  if (configuredValues === 0) {
    return undefined;
  }
  if (configuredValues !== DISCORD_PROVIDER_ENDPOINT_REQUIRED_ENV.length) {
    throw new Error(
      `Discord provider endpoint requires ${DISCORD_PROVIDER_ENDPOINT_REQUIRED_ENV.join(", ")} to be set together`,
    );
  }
  return normalizeDescriptor(descriptor);
}

function isWithinRestApiBase(target: URL, restApiBaseUrl: URL): boolean {
  if (target.origin !== restApiBaseUrl.origin) {
    return false;
  }
  const basePath = restApiBaseUrl.pathname.replace(/\/+$/u, "");
  return (
    basePath === "" || target.pathname === basePath || target.pathname.startsWith(`${basePath}/`)
  );
}

function assertProviderHttpTarget(
  target: URL,
  descriptor: DiscordProviderEndpointDescriptor,
): void {
  const restApiBaseUrl = new URL(descriptor.restApiBaseUrl);
  const gatewayBotUrl = new URL(descriptor.gatewayBotUrl);
  if (
    !isWithinRestApiBase(target, restApiBaseUrl) &&
    target.toString() !== gatewayBotUrl.toString()
  ) {
    throw new Error("Discord provider request is outside the configured endpoint boundaries");
  }
}

function requestInitFromRequest(request: Request): RequestInit {
  const rawDuplex: unknown = Reflect.get(request, "duplex");
  const duplex = rawDuplex === "half" ? rawDuplex : undefined;
  return {
    method: request.method,
    headers: request.headers,
    ...(request.body
      ? {
          body: request.body,
          ...(duplex ? { duplex } : {}),
        }
      : {}),
    signal: request.signal,
  };
}

function createProviderFetch(descriptor: DiscordProviderEndpointDescriptor): typeof fetch {
  const allowedOrigins = Array.from(
    new Set([new URL(descriptor.restApiBaseUrl).origin, new URL(descriptor.gatewayBotUrl).origin]),
  );
  return async (input, init) => {
    // Rebuild once so Request inputs and RequestInit overrides retain Fetch semantics.
    const request = new Request(input, init);
    const target = new URL(request.url);
    assertProviderHttpTarget(target, descriptor);
    const guarded = await fetchWithSsrFGuard({
      url: target.toString(),
      init: requestInitFromRequest(request),
      signal: request.signal,
      requireHttps: target.protocol === "https:",
      policy: { allowedOrigins },
      maxRedirects: 0,
      capture: false,
      auditContext: "discord.provider-endpoint",
    });
    try {
      const body = await readResponseWithLimit(
        guarded.response,
        DISCORD_PROVIDER_RESPONSE_MAX_BYTES,
        {
          onOverflow: ({ size, maxBytes }) =>
            new Error(
              `Discord provider response body too large: ${size} bytes (limit: ${maxBytes} bytes)`,
            ),
        },
      );
      return new Response(body.byteLength > 0 ? new Uint8Array(body) : null, {
        status: guarded.response.status,
        statusText: guarded.response.statusText,
        headers: guarded.response.headers,
      });
    } finally {
      await guarded.release();
    }
  };
}

/** Snapshot the private endpoint once, before any Discord account can start. */
export function initializeDiscordProviderEndpointFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DiscordProviderEndpointRuntime | undefined {
  if (providerEndpointInitialization.status === "initialized") {
    return providerEndpointInitialization.runtime;
  }
  if (providerEndpointInitialization.status === "failed") {
    throw providerEndpointInitialization.error;
  }

  try {
    const descriptor = parseProviderEndpointEnv(env);
    const runtime = descriptor
      ? Object.freeze({ descriptor, fetch: createProviderFetch(descriptor) })
      : undefined;
    providerEndpointInitialization = { status: "initialized", runtime };
    return runtime;
  } catch (error) {
    const resolvedError = error instanceof Error ? error : new Error(String(error));
    // Cache invalid input too: late environment mutation must not change routing after startup.
    providerEndpointInitialization = { status: "failed", error: resolvedError };
    throw resolvedError;
  }
}

export function getDiscordProviderEndpointRuntime(): DiscordProviderEndpointRuntime | undefined {
  return providerEndpointInitialization.status === "initialized"
    ? providerEndpointInitialization.runtime
    : undefined;
}

export function resolveDiscordProviderAttachmentUploadGuard(uploadUrl: string):
  | Readonly<{
      maxRedirects: 0;
      policy: SsrFPolicy;
      requireHttps: boolean;
    }>
  | undefined {
  const runtime = getDiscordProviderEndpointRuntime();
  if (!runtime) {
    return undefined;
  }
  const target = parseHttpAnchor(uploadUrl, "Discord provider attachment upload URL");
  const restOrigin = new URL(runtime.descriptor.restApiBaseUrl).origin;
  if (target.origin !== restOrigin) {
    throw new Error("Discord provider attachment upload URL is outside the configured REST origin");
  }
  return {
    maxRedirects: 0,
    policy: { allowedOrigins: [restOrigin] },
    requireHttps: target.protocol === "https:",
  };
}

export function resolveDiscordProviderMediaDownloadGuard(mediaUrl: string):
  | Readonly<{
      maxRedirects: 0;
      policy: SsrFPolicy;
    }>
  | undefined {
  const runtime = getDiscordProviderEndpointRuntime();
  if (!runtime) {
    return undefined;
  }
  const target = parseHttpAnchor(mediaUrl, "Discord provider media URL");
  const restOrigin = new URL(runtime.descriptor.restApiBaseUrl).origin;
  if (target.origin !== restOrigin) {
    throw new Error("Discord provider media URL is outside the configured REST origin");
  }
  return {
    maxRedirects: 0,
    policy: {
      allowedOrigins: [restOrigin],
      hostnameAllowlist: [target.hostname],
    },
  };
}

export function assertDiscordProviderGatewayUrl(url: string, gatewayOrigin?: string): void {
  if (!gatewayOrigin) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Discord provider Gateway returned an invalid WebSocket URL");
  }
  if (parsed.origin !== gatewayOrigin || parsed.username || parsed.password || parsed.hash) {
    throw new Error("Discord provider Gateway URL is outside the configured WebSocket origin");
  }
}
