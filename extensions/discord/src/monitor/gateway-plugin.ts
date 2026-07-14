// Discord plugin module implements gateway plugin behavior.
import { randomUUID } from "node:crypto";
import type { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { createNodeProxyAgent } from "openclaw/plugin-sdk/fetch-runtime";
import {
  captureWsEvent,
  resolveEffectiveDebugProxyUrl,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import { danger, warn } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import * as ws from "ws";
import * as discordGateway from "../internal/gateway.js";
import { createDiscordDnsLookup } from "../network-config.js";
import { validateDiscordProxyUrl } from "../proxy-fetch.js";
import { resolveDiscordVoiceEnabled } from "../voice/config.js";
import { DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT } from "./gateway-handle.js";
import {
  fetchDiscordGatewayInfoWithTimeout,
  fetchDiscordGatewayMetadataGuarded,
  resolveDiscordGatewayInfoTimeoutMs,
  resolveGatewayInfoWithFallback,
  type DiscordGatewayFetch,
  type DiscordGatewayFetchInit,
} from "./gateway-metadata.js";

const DISCORD_GATEWAY_HANDSHAKE_TIMEOUT_MS = 30_000;
const DISCORD_GATEWAY_POLICY_VIOLATION_CLOSE_CODE = 1008;
const DISCORD_GATEWAY_WS_RECEIVER_LIMIT_CODE = "WS_ERR_TOO_MANY_BUFFERED_PARTS";
const DISCORD_GATEWAY_CLOSE_REASON_LOG_MAX_CHARS = 240;
const discordDnsLookup = createDiscordDnsLookup();

type DiscordGatewayWebSocketCtor = typeof ws.WebSocket;
type DiscordGatewayWebSocketAgent = InstanceType<typeof HttpsAgent> | HttpAgent;
const registrationPromises = new WeakMap<discordGateway.GatewayPlugin, Promise<void>>();
type DiscordGatewayClient = Parameters<discordGateway.GatewayPlugin["registerClient"]>[0];
type GatewayPluginTestingOptions = {
  registerClient?: (
    plugin: discordGateway.GatewayPlugin,
    client: DiscordGatewayClient,
  ) => Promise<void>;
  webSocketCtor?: DiscordGatewayWebSocketCtor;
};
type CreateDiscordGatewayPluginTestingOptions = GatewayPluginTestingOptions & {
  createProxyAgent?: (proxyUrl: string) => HttpAgent;
};
type DiscordGatewayRegistrationState = {
  client?: DiscordGatewayClient;
  ws?: unknown;
  isConnecting?: boolean;
};
type DiscordGatewayTransportErrorDetails = {
  name?: string;
  message: string;
  code?: string;
  closeCode?: number;
  statusCode?: number;
};

function assignGatewayClient(
  plugin: discordGateway.GatewayPlugin,
  client: DiscordGatewayClient,
): void {
  (plugin as unknown as DiscordGatewayRegistrationState).client = client;
}

function hasGatewaySocketStarted(plugin: discordGateway.GatewayPlugin): boolean {
  const state = plugin as unknown as DiscordGatewayRegistrationState;
  return state.ws != null || state.isConnecting === true;
}

function readStringProperty(value: object, key: string): string | undefined {
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" && property ? property : undefined;
}

function readNumberProperty(value: object, key: string): number | undefined {
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "number" && Number.isFinite(property) ? property : undefined;
}

function describeDiscordGatewayTransportError(error: Error): DiscordGatewayTransportErrorDetails {
  const code = readStringProperty(error, "code");
  const closeCode = readNumberProperty(error, "closeCode");
  const statusCode = readNumberProperty(error, "statusCode");
  return {
    ...(error.name ? { name: error.name } : {}),
    message: error.message,
    ...(code ? { code } : {}),
    ...(closeCode !== undefined ? { closeCode } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
  };
}

function formatDiscordGatewayCloseReason(reason: Buffer): string {
  if (!reason.length) {
    return "<empty>";
  }
  const text = reason.toString("utf8").replaceAll(/\s+/g, " ").trim();
  if (!text) {
    return `<${reason.length} bytes>`;
  }
  if (text.length <= DISCORD_GATEWAY_CLOSE_REASON_LOG_MAX_CHARS) {
    return text;
  }
  return `${truncateUtf16Safe(text, DISCORD_GATEWAY_CLOSE_REASON_LOG_MAX_CHARS)}...`;
}

function formatDiscordGatewayTransportErrorLog(params: {
  flowId: string;
  error: DiscordGatewayTransportErrorDetails;
}): string {
  const details = [
    `flow=${params.flowId}`,
    params.error.name ? `name=${params.error.name}` : undefined,
    params.error.code ? `code=${params.error.code}` : undefined,
    typeof params.error.closeCode === "number" ? `closeCode=${params.error.closeCode}` : undefined,
    typeof params.error.statusCode === "number"
      ? `statusCode=${params.error.statusCode}`
      : undefined,
    `message=${params.error.message}`,
  ].filter(Boolean);
  return `discord: gateway websocket error ${details.join(" ")}`;
}

function formatDiscordGatewayTransportCloseLog(params: {
  flowId: string;
  code: number;
  reason: Buffer;
  lastError?: DiscordGatewayTransportErrorDetails;
}): string {
  const receiverLimit =
    params.code === DISCORD_GATEWAY_POLICY_VIOLATION_CLOSE_CODE ||
    params.lastError?.code === DISCORD_GATEWAY_WS_RECEIVER_LIMIT_CODE;
  const details = [
    `flow=${params.flowId}`,
    `code=${params.code}`,
    `reasonBytes=${params.reason.length}`,
    `reason=${formatDiscordGatewayCloseReason(params.reason)}`,
    params.lastError?.code ? `lastErrorCode=${params.lastError.code}` : undefined,
    params.lastError?.message ? `lastError=${params.lastError.message}` : undefined,
    receiverLimit ? "hint=possible ws receiver buffered-parts limit" : undefined,
  ].filter(Boolean);
  return `discord: gateway websocket closed ${details.join(" ")}`;
}

function shouldLogDiscordGatewayTransportClose(params: {
  code: number;
  reason: Buffer;
  lastError?: DiscordGatewayTransportErrorDetails;
}): boolean {
  return (
    params.code === DISCORD_GATEWAY_POLICY_VIOLATION_CLOSE_CODE ||
    (params.code !== 1000 && params.code !== 1001) ||
    params.reason.length > 0 ||
    params.lastError !== undefined
  );
}

type ResolveDiscordGatewayIntentsParams = {
  intentsConfig?: import("openclaw/plugin-sdk/config-contracts").DiscordIntentsConfig;
  voiceEnabled?: boolean;
};

export function resolveDiscordGatewayIntents(params?: ResolveDiscordGatewayIntentsParams): number {
  const intentsConfig = params?.intentsConfig;
  const voiceEnabled = params?.voiceEnabled;
  const voiceStatesEnabled = intentsConfig?.voiceStates ?? voiceEnabled ?? false;
  let intents =
    discordGateway.GatewayIntents.Guilds |
    discordGateway.GatewayIntents.GuildMessages |
    discordGateway.GatewayIntents.MessageContent |
    discordGateway.GatewayIntents.DirectMessages |
    discordGateway.GatewayIntents.GuildMessageReactions |
    discordGateway.GatewayIntents.DirectMessageReactions;
  if (voiceStatesEnabled) {
    intents |= discordGateway.GatewayIntents.GuildVoiceStates;
  }
  if (intentsConfig?.presence) {
    intents |= discordGateway.GatewayIntents.GuildPresences;
  }
  if (intentsConfig?.guildMembers) {
    intents |= discordGateway.GatewayIntents.GuildMembers;
  }
  return intents;
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
  wsAgent?: DiscordGatewayWebSocketAgent;
  runtime?: RuntimeEnv;
  testing?: GatewayPluginTestingOptions;
}): discordGateway.GatewayPlugin {
  class OpenClawGatewayPlugin extends discordGateway.GatewayPlugin {
    private gatewayInfoUsedFallback = false;

    constructor() {
      super(params.options);
    }

    override registerClient(client: DiscordGatewayClient) {
      const registration = this.registerClientInternal(client);
      // Client construction starts plugin hooks without awaiting them. Mark the
      // promise handled immediately, then let startup await the original promise.
      registration.catch(() => {});
      registrationPromises.set(this, registration);
      return registration;
    }

    private async registerClientInternal(client: DiscordGatewayClient) {
      // Publish the client reference before the metadata fetch can yield, so an external
      // connect()->identify() cannot silently drop IDENTIFY (#52372).
      assignGatewayClient(this, client);

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
          .catch((error: unknown) =>
            resolveGatewayInfoWithFallback({ runtime: params.runtime, error }),
          );
        this.gatewayInfo = resolved.info;
        this.gatewayInfoUsedFallback = resolved.usedFallback;
      }
      if (params.testing?.registerClient) {
        await params.testing.registerClient(this, client);
        return;
      }
      // If the lifecycle timeout already started a socket while metadata was
      // loading, do not register again; it would close that socket and open another one.
      if (hasGatewaySocketStarted(this)) {
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
        ...discordGateway.DISCORD_GATEWAY_WS_CLIENT_OPTIONS,
        handshakeTimeout: DISCORD_GATEWAY_HANDSHAKE_TIMEOUT_MS,
        ...(params.wsAgent ? { agent: params.wsAgent } : {}),
      });
      let lastTransportError: DiscordGatewayTransportErrorDetails | undefined;
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
        const closeReason = Buffer.isBuffer(reason) ? reason : Buffer.from(String(reason ?? ""));
        captureWsEvent({
          url,
          direction: "local",
          kind: "ws-close",
          flowId: wsFlowId,
          closeCode: code,
          payload: closeReason,
          meta: { subsystem: "discord-gateway" },
        });
        if (
          shouldLogDiscordGatewayTransportClose({
            code,
            reason: closeReason,
            lastError: lastTransportError,
          })
        ) {
          params.runtime?.log?.(
            warn(
              formatDiscordGatewayTransportCloseLog({
                flowId: wsFlowId,
                code,
                reason: closeReason,
                lastError: lastTransportError,
              }),
            ),
          );
        }
      });
      socket.on?.("error", (error: Error) => {
        lastTransportError = describeDiscordGatewayTransportError(error);
        captureWsEvent({
          url,
          direction: "local",
          kind: "error",
          flowId: wsFlowId,
          errorText: error.message,
          meta: { subsystem: "discord-gateway" },
        });
        params.runtime?.log?.(
          warn(
            formatDiscordGatewayTransportErrorLog({ flowId: wsFlowId, error: lastTransportError }),
          ),
        );
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

  return new OpenClawGatewayPlugin();
}

function createDiscordGatewayMetadataFetch(
  debugCaptureEnabled: boolean,
  proxyUrl?: string,
): DiscordGatewayFetch {
  return (input, init) =>
    fetchDiscordGatewayMetadataGuarded(input, init, {
      ...(debugCaptureEnabled
        ? {}
        : {
            capture: {
              flowId: randomUUID(),
              meta: { subsystem: "discord-gateway-metadata" },
            },
          }),
      ...(proxyUrl ? { proxyUrl } : {}),
    });
}

export function waitForDiscordGatewayPluginRegistration(
  plugin: unknown,
): Promise<void> | undefined {
  if (typeof plugin !== "object" || plugin === null) {
    return undefined;
  }
  return registrationPromises.get(plugin as discordGateway.GatewayPlugin);
}

export function createDiscordGatewayPlugin(params: {
  discordConfig: DiscordAccountConfig;
  runtime: RuntimeEnv;
  testing?: CreateDiscordGatewayPluginTestingOptions;
}): discordGateway.GatewayPlugin {
  const intents = resolveDiscordGatewayIntents({
    intentsConfig: params.discordConfig?.intents,
    voiceEnabled: resolveDiscordVoiceEnabled(params.discordConfig?.voice),
  });
  const proxy = resolveEffectiveDebugProxyUrl(params.discordConfig?.proxy);
  const debugProxySettings = resolveDebugProxySettings();
  const gatewayInfoTimeoutMs = resolveDiscordGatewayInfoTimeoutMs({
    configuredTimeoutMs: params.discordConfig?.gatewayInfoTimeoutMs,
    env: process.env,
  });
  let fetchImpl = createDiscordGatewayMetadataFetch(debugProxySettings.enabled);
  let wsAgent: DiscordGatewayWebSocketAgent = new HttpsAgent({
    lookup: discordDnsLookup,
  });

  if (proxy) {
    try {
      validateDiscordProxyUrl(proxy);
      wsAgent =
        params.testing?.createProxyAgent?.(proxy) ??
        createNodeProxyAgent({ mode: "explicit", proxyUrl: proxy, protocol: "https" });
      fetchImpl = createDiscordGatewayMetadataFetch(debugProxySettings.enabled, proxy);
      params.runtime.log?.("discord: gateway proxy enabled");
    } catch (err) {
      params.runtime.error?.(danger(`discord: invalid gateway proxy: ${String(err)}`));
      fetchImpl = (input, init) =>
        fetchDiscordGatewayMetadataGuarded(input, init, { capture: false });
    }
  }

  return createGatewayPlugin({
    options: {
      reconnect: { maxAttempts: 50 },
      intents,
      // OpenClaw registers its own async interaction listener.
      autoInteractions: false,
    },
    gatewayInfoTimeoutMs,
    fetchImpl,
    runtime: params.runtime,
    testing: params.testing,
    ...(wsAgent ? { wsAgent } : {}),
  });
}
