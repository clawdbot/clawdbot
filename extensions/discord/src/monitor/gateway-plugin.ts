import { randomUUID } from "node:crypto";
import * as httpsProxyAgent from "https-proxy-agent";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-types";
import {
  captureWsEvent,
  resolveEffectiveDebugProxyUrl,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import * as ws from "ws";
import * as discordGateway from "../internal/gateway.js";
import { validateDiscordProxyUrl } from "../proxy-fetch.js";
import { resolveDiscordVoiceEnabled } from "../voice/config.js";
import { DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT } from "./gateway-handle.js";
import {
  fetchDiscordGatewayInfoWithTimeout,
  fetchDiscordGatewayMetadataDirect,
  resolveDiscordGatewayInfoTimeoutMs,
  resolveGatewayInfoWithFallback,
  type DiscordGatewayFetch,
  type DiscordGatewayFetchInit,
} from "./gateway-metadata.js";

export {
  parseDiscordGatewayInfoBody,
  resolveDiscordGatewayInfoTimeoutMs,
} from "./gateway-metadata.js";

const DISCORD_GATEWAY_HANDSHAKE_TIMEOUT_MS = 30_000;

type DiscordGatewayWebSocketCtor = new (
  url: string,
  options?: { agent?: unknown; handshakeTimeout?: number },
) => ws.WebSocket;
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
  HttpsProxyAgentCtor?: typeof httpsProxyAgent.HttpsProxyAgent;
};
type DiscordGatewayRegistrationState = {
  client?: DiscordGatewayClient;
  ws?: unknown;
  isConnecting?: boolean;
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

type ResolveDiscordGatewayIntentsParams = {
  intentsConfig?: import("openclaw/plugin-sdk/config-types").DiscordIntentsConfig;
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
  wsAgent?: InstanceType<typeof httpsProxyAgent.HttpsProxyAgent<string>>;
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
          .catch((error) => resolveGatewayInfoWithFallback({ runtime: params.runtime, error }));
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

  return new OpenClawGatewayPlugin();
}

function createDiscordGatewayMetadataFetch(debugCaptureEnabled: boolean): DiscordGatewayFetch {
  return (input, init) =>
    fetchDiscordGatewayMetadataDirect(
      input,
      init,
      debugCaptureEnabled
        ? false
        : {
            flowId: randomUUID(),
            meta: { subsystem: "discord-gateway-metadata" },
          },
    );
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
  __testing?: CreateDiscordGatewayPluginTestingOptions;
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
  let wsAgent: InstanceType<typeof httpsProxyAgent.HttpsProxyAgent<string>> | undefined;

  if (proxy) {
    try {
      validateDiscordProxyUrl(proxy);
      const HttpsProxyAgentCtor =
        params.__testing?.HttpsProxyAgentCtor ?? httpsProxyAgent.HttpsProxyAgent;
      wsAgent = new HttpsProxyAgentCtor<string>(proxy);
      params.runtime.log?.("discord: gateway proxy enabled");
    } catch (err) {
      params.runtime.error?.(danger(`discord: invalid gateway proxy: ${String(err)}`));
      fetchImpl = (input, init) => fetchDiscordGatewayMetadataDirect(input, init, false);
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
    testing: params.__testing,
    ...(wsAgent ? { wsAgent } : {}),
  });
}
