import { randomUUID } from "node:crypto";
import * as carbonGateway from "@buape/carbon/gateway";
import type { APIGatewayBotInfo } from "discord-api-types/v10";
import * as httpsProxyAgent from "https-proxy-agent";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  captureHttpExchange,
  captureWsEvent,
  resolveEffectiveDebugProxyUrl,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import * as ws from "ws";
import { validateDiscordProxyUrl } from "../proxy-fetch.js";
import { DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT } from "./gateway-handle.js";

const DISCORD_GATEWAY_BOT_URL = "https://discord.com/api/v10/gateway/bot";
const DISCORD_API_HOST = "discord.com";
const DEFAULT_DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/";
const DEFAULT_DISCORD_GATEWAY_INFO_TIMEOUT_MS = 30_000;
const MAX_DISCORD_GATEWAY_INFO_TIMEOUT_MS = 120_000;
const DISCORD_GATEWAY_INFO_TIMEOUT_ENV = "OPENCLAW_DISCORD_GATEWAY_INFO_TIMEOUT_MS";
const DISCORD_GATEWAY_METADATA_FALLBACK_LOG_INTERVAL_MS = 60_000;
const DISCORD_GATEWAY_HANDSHAKE_TIMEOUT_MS = 30_000;

type DiscordGatewayMetadataResponse = Pick<Response, "ok" | "status" | "text">;
type DiscordGatewayFetchInit = Record<string, unknown> & {
  headers?: Record<string, string>;
};
type DiscordGatewayFetch = (
  input: string,
  init?: DiscordGatewayFetchInit,
) => Promise<DiscordGatewayMetadataResponse>;

type DiscordGatewayMetadataError = Error & { transient?: boolean };
type DiscordGatewayWebSocketCtor = new (
  url: string,
  options?: { agent?: unknown; handshakeTimeout?: number },
) => ws.WebSocket;
const registrationPromises = new WeakMap<carbonGateway.GatewayPlugin, Promise<void>>();
const gatewayMetadataFallbackLogLastAt = new WeakMap<RuntimeEnv, number>();
type CarbonGatewayRegistrationState = {
  client?: Parameters<carbonGateway.GatewayPlugin["registerClient"]>[0];
  ws?: unknown;
  isConnecting?: boolean;
};

function resolveFetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

async function materializeGuardedResponse(response: Response): Promise<Response> {
  const body = await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function assignCarbonGatewayClient(
  plugin: carbonGateway.GatewayPlugin,
  client: Parameters<carbonGateway.GatewayPlugin["registerClient"]>[0],
): void {
  (plugin as unknown as CarbonGatewayRegistrationState).client = client;
}

function hasCarbonGatewaySocketStarted(plugin: carbonGateway.GatewayPlugin): boolean {
  const state = plugin as unknown as CarbonGatewayRegistrationState;
  return state.ws != null || state.isConnecting === true;
}

type ResolveDiscordGatewayIntentsParams =
  | import("openclaw/plugin-sdk/config-types").DiscordIntentsConfig
  | {
      intentsConfig?: import("openclaw/plugin-sdk/config-types").DiscordIntentsConfig;
      voiceEnabled?: boolean;
    };

function isGatewayIntentsResolverOptions(
  value: ResolveDiscordGatewayIntentsParams | undefined,
): value is Exclude<ResolveDiscordGatewayIntentsParams, undefined> & {
  intentsConfig?: import("openclaw/plugin-sdk/config-types").DiscordIntentsConfig;
  voiceEnabled?: boolean;
} {
  return Boolean(value && ("intentsConfig" in value || "voiceEnabled" in value));
}

export function resolveDiscordGatewayIntents(params?: ResolveDiscordGatewayIntentsParams): number {
  const intentsConfig = isGatewayIntentsResolverOptions(params) ? params.intentsConfig : params;
  const voiceEnabled = isGatewayIntentsResolverOptions(params) ? params.voiceEnabled : undefined;
  const voiceStatesEnabled = intentsConfig?.voiceStates ?? voiceEnabled ?? true;
  let intents =
    carbonGateway.GatewayIntents.Guilds |
    carbonGateway.GatewayIntents.GuildMessages |
    carbonGateway.GatewayIntents.MessageContent |
    carbonGateway.GatewayIntents.DirectMessages |
    carbonGateway.GatewayIntents.GuildMessageReactions |
    carbonGateway.GatewayIntents.DirectMessageReactions;
  if (voiceStatesEnabled) {
    intents |= carbonGateway.GatewayIntents.GuildVoiceStates;
  }
  if (intentsConfig?.presence) {
    intents |= carbonGateway.GatewayIntents.GuildPresences;
  }
  if (intentsConfig?.guildMembers) {
    intents |= carbonGateway.GatewayIntents.GuildMembers;
  }
  return intents;
}

function normalizeGatewayInfoTimeoutMs(value: unknown): number | undefined {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }
  return Math.min(Math.floor(numeric), MAX_DISCORD_GATEWAY_INFO_TIMEOUT_MS);
}

export function resolveDiscordGatewayInfoTimeoutMs(params?: {
  configuredTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): number {
  return (
    normalizeGatewayInfoTimeoutMs(params?.configuredTimeoutMs) ??
    normalizeGatewayInfoTimeoutMs(params?.env?.[DISCORD_GATEWAY_INFO_TIMEOUT_ENV]) ??
    DEFAULT_DISCORD_GATEWAY_INFO_TIMEOUT_MS
  );
}

function summarizeGatewayResponseBody(body: string): string {
  const normalized = body.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "<empty>";
  }
  return normalized.slice(0, 240);
}

function isTransientDiscordGatewayResponse(status: number, body: string): boolean {
  if (status >= 500) {
    return true;
  }
  const normalized = normalizeLowercaseStringOrEmpty(body);
  return (
    normalized.includes("upstream connect error") ||
    normalized.includes("disconnect/reset before headers") ||
    normalized.includes("reset reason:")
  );
}

function createGatewayMetadataError(params: {
  detail: string;
  transient: boolean;
  cause?: unknown;
}): Error {
  const error = new Error(
    params.transient
      ? "Failed to get gateway information from Discord: fetch failed"
      : `Failed to get gateway information from Discord: ${params.detail}`,
    {
      cause: params.cause ?? (params.transient ? new Error(params.detail) : undefined),
    },
  ) as DiscordGatewayMetadataError;
  Object.defineProperty(error, "transient", {
    value: params.transient,
    enumerable: false,
  });
  return error;
}

function isTransientGatewayMetadataError(error: unknown): boolean {
  return Boolean((error as DiscordGatewayMetadataError | undefined)?.transient);
}

function createDefaultGatewayInfo(): APIGatewayBotInfo {
  return {
    url: DEFAULT_DISCORD_GATEWAY_URL,
    shards: 1,
    session_start_limit: {
      total: 1,
      remaining: 1,
      reset_after: 0,
      max_concurrency: 1,
    },
  };
}

async function fetchDiscordGatewayInfo(params: {
  token: string;
  fetchImpl: DiscordGatewayFetch;
  fetchInit?: DiscordGatewayFetchInit;
}): Promise<APIGatewayBotInfo> {
  let response: DiscordGatewayMetadataResponse;
  try {
    response = await params.fetchImpl(DISCORD_GATEWAY_BOT_URL, {
      ...params.fetchInit,
      headers: {
        ...params.fetchInit?.headers,
        Authorization: `Bot ${params.token}`,
      },
    });
  } catch (error) {
    throw createGatewayMetadataError({
      detail: formatErrorMessage(error),
      transient: true,
      cause: error,
    });
  }

  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    throw createGatewayMetadataError({
      detail: formatErrorMessage(error),
      transient: true,
      cause: error,
    });
  }
  const summary = summarizeGatewayResponseBody(body);
  const transient = isTransientDiscordGatewayResponse(response.status, body);

  if (!response.ok) {
    throw createGatewayMetadataError({
      detail: `Discord API /gateway/bot failed (${response.status}): ${summary}`,
      transient,
    });
  }

  try {
    const parsed = JSON.parse(body) as Partial<APIGatewayBotInfo>;
    return {
      ...parsed,
      url:
        typeof parsed.url === "string" && parsed.url.trim()
          ? parsed.url
          : DEFAULT_DISCORD_GATEWAY_URL,
    } as APIGatewayBotInfo;
  } catch (error) {
    throw createGatewayMetadataError({
      detail: `Discord API /gateway/bot returned invalid JSON: ${summary}`,
      transient,
      cause: error,
    });
  }
}

async function fetchDiscordGatewayInfoWithTimeout(params: {
  token: string;
  fetchImpl: DiscordGatewayFetch;
  fetchInit?: DiscordGatewayFetchInit;
  timeoutMs?: number;
}): Promise<APIGatewayBotInfo> {
  const timeoutMs = Math.max(1, params.timeoutMs ?? DEFAULT_DISCORD_GATEWAY_INFO_TIMEOUT_MS);
  const abortController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      abortController.abort();
      reject(
        createGatewayMetadataError({
          detail: `Discord API /gateway/bot timed out after ${timeoutMs}ms`,
          transient: true,
          cause: new Error("gateway metadata timeout"),
        }),
      );
    }, timeoutMs);
    timeoutId.unref?.();
  });

  try {
    return await Promise.race([
      fetchDiscordGatewayInfo({
        token: params.token,
        fetchImpl: params.fetchImpl,
        fetchInit: {
          ...params.fetchInit,
          signal: abortController.signal,
        },
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function resolveGatewayInfoWithFallback(params: { runtime?: RuntimeEnv; error: unknown }): {
  info: APIGatewayBotInfo;
  usedFallback: boolean;
} {
  if (!isTransientGatewayMetadataError(params.error)) {
    throw params.error;
  }
  const message = formatErrorMessage(params.error);
  const now = Date.now();
  if (params.runtime) {
    const previous = gatewayMetadataFallbackLogLastAt.get(params.runtime);
    if (
      previous === undefined ||
      now - previous >= DISCORD_GATEWAY_METADATA_FALLBACK_LOG_INTERVAL_MS
    ) {
      params.runtime.log?.(
        `discord: gateway metadata lookup failed transiently; using default gateway url (${message})`,
      );
      gatewayMetadataFallbackLogLastAt.set(params.runtime, now);
    }
  }
  return {
    info: createDefaultGatewayInfo(),
    usedFallback: true,
  };
}

function createGatewayPlugin(params: {
  options: {
    reconnect: { maxAttempts: number };
    intents: number;
    autoInteractions: boolean;
  };
  gatewayInfoTimeoutMs: number;
  fetchImpl: DiscordGatewayFetch;
  fetchInit?: DiscordGatewayFetchInit;
  wsAgent?: InstanceType<typeof httpsProxyAgent.HttpsProxyAgent<string>>;
  runtime?: RuntimeEnv;
  testing?: {
    registerClient?: (
      plugin: carbonGateway.GatewayPlugin,
      client: Parameters<carbonGateway.GatewayPlugin["registerClient"]>[0],
    ) => Promise<void>;
    webSocketCtor?: DiscordGatewayWebSocketCtor;
  };
}): carbonGateway.GatewayPlugin {
  class SafeGatewayPlugin extends carbonGateway.GatewayPlugin {
    private gatewayInfoUsedFallback = false;

    constructor() {
      super(params.options);
    }

    public override connect(resume = false): void {
      // Guard against stale heartbeat timers from the @buape/carbon
      // firstHeartbeatTimeout race (openclaw/openclaw#65009, #64011, #63387).
      // Parent connect() only calls stopHeartbeat() when isConnecting=false.
      // If isConnecting=true it returns early — leaving a stale setInterval
      // that fires with a closed reconnectCallback and crashes the process.
      if (this.heartbeatInterval !== undefined) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = undefined;
      }
      if (this.firstHeartbeatTimeout !== undefined) {
        clearTimeout(this.firstHeartbeatTimeout);
        this.firstHeartbeatTimeout = undefined;
      }
      super.connect(resume);
    }

    override registerClient(client: Parameters<carbonGateway.GatewayPlugin["registerClient"]>[0]) {
      const registration = this.registerClientInternal(client);
      // Carbon 0.16 invokes async plugin hooks from Client construction without
      // awaiting them. Mark the promise handled immediately, then let OpenClaw
      // startup await the original promise explicitly.
      registration.catch(() => {});
      registrationPromises.set(this, registration);
      return registration;
    }

    private async registerClientInternal(
      client: Parameters<carbonGateway.GatewayPlugin["registerClient"]>[0],
    ) {
      // Carbon's Client constructor does not await plugin registerClient().
      // Match Carbon's own GatewayPlugin ordering by publishing the client
      // reference before our metadata fetch can yield, so an external
      // connect()->identify() cannot silently drop IDENTIFY (#52372).
      assignCarbonGatewayClient(this, client);

      if (!this.gatewayInfo || this.gatewayInfoUsedFallback) {
        const resolved = await fetchDiscordGatewayInfoWithTimeout({
          token: client.options.token,
          fetchImpl: params.fetchImpl,
          fetchInit: params.fetchInit,
          timeoutMs: params.gatewayInfoTimeoutMs,
        })
          .then((info) => ({
            info,
            usedFallback: false,
          }))
          .catch((error) => resolveGatewayInfoWithFallback({ runtime: params.runtime, error }));
        this.gatewayInfo = resolved.info;
        this.gatewayInfoUsedFallback = resolved.usedFallback;
      }
      if (params.testing?.registerClient) {
        await params.testing.registerClient(this, client);
        return;
      }
      // If the lifecycle timeout already started a socket while metadata was
      // loading, do not call Carbon's registerClient() again; it would close
      // that socket and open another one. Carbon stores these as runtime fields
      // even though they are protected/private in the .d.ts.
      if (hasCarbonGatewaySocketStarted(this)) {
        return;
      }
      return super.registerClient(client);
    }

    override createWebSocket(url: string) {
      if (!url) {
        throw new Error("Gateway URL is required");
      }
      const wsFlowId = randomUUID();
      // Avoid Node's undici-backed global WebSocket here. We have seen late
      // close-path crashes during Discord gateway teardown; the ws transport is
      // already our proxy path and behaves predictably for lifecycle cleanup.
      const WebSocketCtor = params.testing?.webSocketCtor ?? ws.default;
      const socket = new WebSocketCtor(url, {
        handshakeTimeout: DISCORD_GATEWAY_HANDSHAKE_TIMEOUT_MS,
        ...(params.wsAgent ? { agent: params.wsAgent } : {}),
      });
      const emitTransportActivity = () => {
        if ((this as unknown as { ws?: unknown }).ws !== socket) {
          return;
        }
        this.emitter.emit(DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT, { at: Date.now() });
      };
      captureWsEvent({
        url,
        direction: "local",
        kind: "ws-open",
        flowId: wsFlowId,
        meta: { subsystem: "discord-gateway" },
      });
      socket.on?.("message", (data: unknown) => {
        emitTransportActivity();
        captureWsEvent({
          url,
          direction: "inbound",
          kind: "ws-frame",
          flowId: wsFlowId,
          payload: Buffer.isBuffer(data) ? data : Buffer.from(String(data)),
          meta: { subsystem: "discord-gateway" },
        });
      });
      socket.on?.("close", (code: number, reason: Buffer) => {
        captureWsEvent({
          url,
          direction: "local",
          kind: "ws-close",
          flowId: wsFlowId,
          closeCode: code,
          payload: reason,
          meta: { subsystem: "discord-gateway" },
        });
      });
      socket.on?.("error", (error: Error) => {
        captureWsEvent({
          url,
          direction: "local",
          kind: "error",
          flowId: wsFlowId,
          errorText: error.message,
          meta: { subsystem: "discord-gateway" },
        });
      });
      if ("binaryType" in socket) {
        try {
          socket.binaryType = "arraybuffer";
        } catch {
          // Ignore runtimes that expose a readonly binaryType.
        }
      }
      return socket;
    }
  }

  return new SafeGatewayPlugin();
}

async function fetchDiscordGatewayMetadataDirect(
  input: string,
  init?: DiscordGatewayFetchInit,
  capture?: false | { flowId: string; meta: Record<string, unknown> },
): Promise<Response> {
  const guarded = await fetchWithSsrFGuard({
    url: resolveFetchInputUrl(input),
    init: init as RequestInit,
    policy: { allowedHostnames: [DISCORD_API_HOST] },
    capture: false,
    auditContext: "discord.gateway.metadata",
  });
  let response: Response;
  try {
    response = await materializeGuardedResponse(guarded.response);
  } finally {
    await guarded.release();
  }
  if (capture) {
    captureHttpExchange({
      url: input,
      method: (init?.method as string | undefined) ?? "GET",
      requestHeaders: init?.headers as Headers | Record<string, string> | undefined,
      requestBody: (init as RequestInit & { body?: BodyInit | null })?.body ?? null,
      response,
      flowId: capture.flowId,
      meta: capture.meta,
    });
  }
  return response;
}

export function waitForDiscordGatewayPluginRegistration(
  plugin: unknown,
): Promise<void> | undefined {
  if (typeof plugin !== "object" || plugin === null) {
    return undefined;
  }
  return registrationPromises.get(plugin as carbonGateway.GatewayPlugin);
}

export function createDiscordGatewayPlugin(params: {
  discordConfig: DiscordAccountConfig;
  runtime: RuntimeEnv;
  __testing?: {
    HttpsProxyAgentCtor?: typeof httpsProxyAgent.HttpsProxyAgent;
    webSocketCtor?: DiscordGatewayWebSocketCtor;
    registerClient?: (
      plugin: carbonGateway.GatewayPlugin,
      client: Parameters<carbonGateway.GatewayPlugin["registerClient"]>[0],
    ) => Promise<void>;
  };
}): carbonGateway.GatewayPlugin {
  const intents = resolveDiscordGatewayIntents({
    intentsConfig: params.discordConfig?.intents,
    voiceEnabled: params.discordConfig?.voice?.enabled !== false,
  });
  const proxy = resolveEffectiveDebugProxyUrl(params.discordConfig?.proxy);
  const debugProxySettings = resolveDebugProxySettings();
  const gatewayInfoTimeoutMs = resolveDiscordGatewayInfoTimeoutMs({
    configuredTimeoutMs: params.discordConfig?.gatewayInfoTimeoutMs,
    env: process.env,
  });
  const options = {
    reconnect: { maxAttempts: 50 },
    intents,
    // OpenClaw registers its own async interaction listener. Carbon's default
    // InteractionEventListener awaits the full handler on the critical event lane.
    autoInteractions: false,
  };

  if (!proxy) {
    return createGatewayPlugin({
      options,
      gatewayInfoTimeoutMs,
      fetchImpl: async (input, init) => {
        return await fetchDiscordGatewayMetadataDirect(
          input,
          init,
          debugProxySettings.enabled
            ? false
            : {
                flowId: randomUUID(),
                meta: { subsystem: "discord-gateway-metadata" },
              },
        );
      },
      runtime: params.runtime,
      testing: params.__testing
        ? {
            registerClient: params.__testing.registerClient,
            webSocketCtor: params.__testing.webSocketCtor,
          }
        : undefined,
    });
  }

  try {
    validateDiscordProxyUrl(proxy);
    const HttpsProxyAgentCtor =
      params.__testing?.HttpsProxyAgentCtor ?? httpsProxyAgent.HttpsProxyAgent;
    const wsAgent = new HttpsProxyAgentCtor<string>(proxy);

    params.runtime.log?.("discord: gateway proxy enabled");

    return createGatewayPlugin({
      options,
      gatewayInfoTimeoutMs,
      fetchImpl: async (input, init) => {
        return await fetchDiscordGatewayMetadataDirect(
          input,
          init,
          debugProxySettings.enabled
            ? false
            : {
                flowId: randomUUID(),
                meta: { subsystem: "discord-gateway-metadata" },
              },
        );
      },
      wsAgent,
      runtime: params.runtime,
      testing: params.__testing
        ? {
            registerClient: params.__testing.registerClient,
            webSocketCtor: params.__testing.webSocketCtor,
          }
        : undefined,
    });
  } catch (err) {
    params.runtime.error?.(danger(`discord: invalid gateway proxy: ${String(err)}`));
    return createGatewayPlugin({
      options,
      gatewayInfoTimeoutMs,
      fetchImpl: (input, init) => fetchDiscordGatewayMetadataDirect(input, init, false),
      runtime: params.runtime,
      testing: params.__testing
        ? {
            registerClient: params.__testing.registerClient,
            webSocketCtor: params.__testing.webSocketCtor,
          }
        : undefined,
    });
  }
}
