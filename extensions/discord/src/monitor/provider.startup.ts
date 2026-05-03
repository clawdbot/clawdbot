import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  Client,
  ReadyListener,
  type BaseCommand,
  type BaseMessageInteractiveComponent,
  type Modal,
  type Plugin,
} from "../internal/discord.js";
import type { GatewayPlugin } from "../internal/gateway.js";
import { VoicePlugin } from "../internal/voice.js";
import { parseApplicationIdFromToken } from "../probe.js";
import { createDiscordRequestClient, DISCORD_REST_TIMEOUT_MS } from "../proxy-request-client.js";
import type { DiscordGuildEntryResolved } from "./allow-list.js";
import { createDiscordAutoPresenceController } from "./auto-presence.js";
import type { DiscordDmPolicy } from "./dm-command-auth.js";
import type { MutableDiscordGateway } from "./gateway-handle.js";
import {
  createDiscordGatewayPlugin,
  waitForDiscordGatewayPluginRegistration,
} from "./gateway-plugin.js";
import { createDiscordGatewaySupervisor } from "./gateway-supervisor.js";
import {
  DiscordMessageListener,
  DiscordInteractionListener,
  DiscordPresenceListener,
  DiscordReactionListener,
  DiscordReactionRemoveListener,
  DiscordThreadUpdateListener,
  registerDiscordListener,
} from "./listeners.js";
import { resolveDiscordPresenceUpdate } from "./presence.js";

type DiscordAutoPresenceController = ReturnType<typeof createDiscordAutoPresenceController>;
type DiscordListenerConfig = {
  dangerouslyAllowNameMatching?: boolean;
  intents?: { presence?: boolean };
};
type CreateClientFn = (
  options: ConstructorParameters<typeof Client>[0],
  handlers: ConstructorParameters<typeof Client>[1],
  plugins: ConstructorParameters<typeof Client>[2],
) => Client;
type DiscordEventQueueOptions = NonNullable<ConstructorParameters<typeof Client>[0]["eventQueue"]>;

function registerLatePlugin(client: Client, plugin: Plugin) {
  void plugin.registerClient?.(client);
  void plugin.registerRoutes?.(client);
  if (!client.plugins.some((entry) => entry.id === plugin.id)) {
    client.plugins.push({ id: plugin.id, plugin });
  }
}

function createDiscordStatusReadyListener(params: {
  discordConfig: Parameters<typeof resolveDiscordPresenceUpdate>[0];
  getAutoPresenceController: () => DiscordAutoPresenceController | null;
}): ReadyListener {
  return new (class DiscordStatusReadyListener extends ReadyListener {
    async handle(_data: unknown, client: Client) {
      const autoPresenceController = params.getAutoPresenceController();
      if (autoPresenceController?.enabled) {
        autoPresenceController.refresh();
        return;
      }

      const gateway = client.getPlugin<GatewayPlugin>("gateway");
      if (!gateway) {
        return;
      }

      const presence = resolveDiscordPresenceUpdate(params.discordConfig);
      if (!presence) {
        return;
      }

      gateway.updatePresence(presence);
    }
  })();
}

export async function createDiscordMonitorClient(params: {
  accountId: string;
  applicationId: string;
  token: string;
  proxyFetch?: typeof fetch;
  commands: BaseCommand[];
  components: BaseMessageInteractiveComponent[];
  modals: Modal[];
  voiceEnabled: boolean;
  discordConfig: Parameters<typeof resolveDiscordPresenceUpdate>[0] & {
    eventQueue?: Pick<
      DiscordEventQueueOptions,
      "listenerTimeout" | "maxQueueSize" | "maxConcurrency"
    >;
  };
  runtime: RuntimeEnv;
  createClient: CreateClientFn;
  createGatewayPlugin: typeof createDiscordGatewayPlugin;
  createGatewaySupervisor: typeof createDiscordGatewaySupervisor;
  createAutoPresenceController: typeof createDiscordAutoPresenceController;
  isDisallowedIntentsError: (err: unknown) => boolean;
}) {
  let autoPresenceController: DiscordAutoPresenceController | null = null;
  const clientPlugins: Plugin[] = [
    params.createGatewayPlugin({
      discordConfig: params.discordConfig,
      runtime: params.runtime,
    }),
  ];
  if (params.voiceEnabled) {
    clientPlugins.push(new VoicePlugin());
  }
  const voicePlugin = clientPlugins.find((plugin) => plugin.id === "voice");
  const constructorPlugins = voicePlugin
    ? clientPlugins.filter((plugin) => plugin !== voicePlugin)
    : clientPlugins;

  const eventQueueOpts = {
    listenerTimeout: 120_000,
    slowListenerThreshold: 30_000,
    ...params.discordConfig.eventQueue,
  } satisfies DiscordEventQueueOptions;
  const readyListener = createDiscordStatusReadyListener({
    discordConfig: params.discordConfig,
    getAutoPresenceController: () => autoPresenceController,
  });
  const client = params.createClient(
    {
      baseUrl: "http://localhost",
      deploySecret: "a",
      clientId: params.applicationId,
      publicKey: "a",
      token: params.token,
      autoDeploy: false,
      commandDeployHashStorePath: path.join(
        resolveStateDir(process.env),
        "discord",
        "command-deploy-cache.json",
      ),
      requestOptions: {
        timeout: DISCORD_REST_TIMEOUT_MS,
        runtimeProfile: "persistent",
        maxQueueSize: 1000,
      },
      eventQueue: eventQueueOpts,
    },
    {
      commands: params.commands,
      listeners: [readyListener],
      components: params.components,
      modals: params.modals,
    },
    constructorPlugins,
  );
  if (voicePlugin) {
    registerLatePlugin(client, voicePlugin);
  }
  if (params.proxyFetch) {
    client.rest = createDiscordRequestClient(params.token, {
      fetch: params.proxyFetch,
      timeout: DISCORD_REST_TIMEOUT_MS,
      runtimeProfile: "persistent",
      maxQueueSize: 1000,
    });
  }
  const gateway = client.getPlugin<GatewayPlugin>("gateway") as MutableDiscordGateway | undefined;
  await waitForDiscordGatewayPluginRegistration(gateway);
  const gatewaySupervisor = params.createGatewaySupervisor({
    gateway,
    isDisallowedIntentsError: params.isDisallowedIntentsError,
    runtime: params.runtime,
  });

  if (gateway) {
    autoPresenceController = params.createAutoPresenceController({
      accountId: params.accountId,
      discordConfig: params.discordConfig,
      gateway,
      log: (message) => params.runtime.log?.(message),
    });
    autoPresenceController.start();
  }

  return {
    client,
    gateway,
    gatewaySupervisor,
    autoPresenceController,
    eventQueueOpts,
  };
}

export async function fetchDiscordBotIdentity(params: {
  client: Pick<Client, "fetchUser">;
  token?: string;
  runtime: RuntimeEnv;
  logStartupPhase: (phase: string, details?: string) => void;
}) {
  params.logStartupPhase("fetch-bot-identity:start");
  const parsedBotUserId = parseApplicationIdFromToken(params.token ?? "");
  if (parsedBotUserId) {
    params.logStartupPhase(
      "fetch-bot-identity:done",
      `botUserId=${parsedBotUserId} botUserName=<missing> source=token`,
    );
    return { botUserId: parsedBotUserId, botUserName: undefined };
  }

  let botUser: Awaited<ReturnType<typeof params.client.fetchUser>>;
  try {
    botUser = await params.client.fetchUser("@me");
  } catch (err) {
    params.runtime.error?.(danger(`discord: failed to fetch bot identity: ${String(err)}`));
    params.logStartupPhase("fetch-bot-identity:error", String(err));
    throw new Error("Failed to resolve Discord bot identity", { cause: err });
  }

  const botUserRecord = botUser as
    | { id?: unknown; username?: unknown; globalName?: unknown }
    | null
    | undefined;
  const botUserId = normalizeOptionalString(botUserRecord?.id);
  const botUserName =
    normalizeOptionalString(botUserRecord?.username) ??
    normalizeOptionalString(botUserRecord?.globalName);
  if (!botUserId) {
    const details = 'fetchUser("@me") returned no usable id';
    params.runtime.error?.(danger(`discord: failed to fetch bot identity: ${details}`));
    params.logStartupPhase("fetch-bot-identity:error", details);
    throw new Error("Failed to resolve Discord bot identity");
  }

  params.logStartupPhase(
    "fetch-bot-identity:done",
    `botUserId=${botUserId} botUserName=${botUserName ?? "<missing>"}`,
  );
  return { botUserId, botUserName };
}

export function registerDiscordMonitorListeners(params: {
  cfg: OpenClawConfig;
  client: Pick<Client, "listeners">;
  accountId: string;
  discordConfig: DiscordListenerConfig;
  runtime: RuntimeEnv;
  botUserId?: string;
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupDmChannels?: string[];
  dmPolicy: DiscordDmPolicy;
  allowFrom?: string[];
  groupPolicy: "open" | "allowlist" | "disabled";
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
  logger: NonNullable<ConstructorParameters<typeof DiscordMessageListener>[1]>;
  messageHandler: ConstructorParameters<typeof DiscordMessageListener>[0];
  trackInboundEvent?: () => void;
}) {
  registerDiscordListener(
    params.client.listeners,
    new DiscordInteractionListener(params.logger, params.trackInboundEvent),
  );
  registerDiscordListener(
    params.client.listeners,
    new DiscordMessageListener(params.messageHandler, params.logger, params.trackInboundEvent),
  );

  if (shouldRegisterDiscordReactionListeners(params)) {
    const reactionListenerOptions: ConstructorParameters<typeof DiscordReactionListener>[0] = {
      cfg: params.cfg,
      accountId: params.accountId,
      runtime: params.runtime,
      botUserId: params.botUserId,
      dmEnabled: params.dmEnabled,
      groupDmEnabled: params.groupDmEnabled,
      groupDmChannels: params.groupDmChannels ?? [],
      dmPolicy: params.dmPolicy,
      allowFrom: params.allowFrom ?? [],
      groupPolicy: params.groupPolicy,
      allowNameMatching: isDangerousNameMatchingEnabled(params.discordConfig),
      guildEntries: params.guildEntries,
      logger: params.logger,
      onEvent: params.trackInboundEvent,
    };
    registerDiscordListener(
      params.client.listeners,
      new DiscordReactionListener(reactionListenerOptions),
    );
    registerDiscordListener(
      params.client.listeners,
      new DiscordReactionRemoveListener(reactionListenerOptions),
    );
  }
  registerDiscordListener(
    params.client.listeners,
    new DiscordThreadUpdateListener(params.cfg, params.accountId, params.logger),
  );

  if (params.discordConfig.intents?.presence) {
    registerDiscordListener(
      params.client.listeners,
      new DiscordPresenceListener({ logger: params.logger, accountId: params.accountId }),
    );
    params.runtime.log?.("discord: GuildPresences intent enabled — presence listener registered");
  }
}

function shouldRegisterDiscordReactionListeners(params: {
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupPolicy: "open" | "allowlist" | "disabled";
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
}): boolean {
  if (params.dmEnabled || params.groupDmEnabled) {
    return true;
  }
  if (params.groupPolicy === "disabled") {
    return false;
  }
  const guildEntries = Object.values(params.guildEntries ?? {});
  if (guildEntries.length === 0) {
    return true;
  }
  return guildEntries.some((entry) => entry.reactionNotifications !== "off");
}
