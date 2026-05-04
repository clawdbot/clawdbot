import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import {
  listNativeCommandSpecsForConfig,
  listSkillCommandsForAgents,
} from "openclaw/plugin-sdk/command-auth";
import type { OpenClawConfig, ReplyToMode } from "openclaw/plugin-sdk/config-types";
import { createConnectedChannelStatusPatch } from "openclaw/plugin-sdk/gateway-runtime";
import {
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "openclaw/plugin-sdk/native-command-config-runtime";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { isVerbose, logVerbose, shouldLogVerbose, warn } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { createNonExitingRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  resolveDiscordAccount,
  resolveDiscordAccountAllowFrom,
  resolveDiscordAccountDmPolicy,
} from "../accounts.js";
import { Client } from "../internal/discord.js";
import { GatewayCloseCodes } from "../internal/gateway.js";
import { fetchDiscordApplicationId, parseApplicationIdFromToken } from "../probe.js";
import { resolveDiscordProxyFetchForAccount } from "../proxy-fetch.js";
import { normalizeDiscordToken } from "../token.js";
import { resolveDiscordVoiceEnabled } from "../voice/config.js";
import { createDiscordAutoPresenceController } from "./auto-presence.js";
import { resolveDiscordSlashCommandConfig } from "./commands.js";
import type { MutableDiscordGateway } from "./gateway-handle.js";
import { createDiscordGatewayPlugin } from "./gateway-plugin.js";
import { createDiscordGatewaySupervisor } from "./gateway-supervisor.js";
import { registerDiscordListener } from "./listeners.js";
import { createDiscordNativeCommand } from "./native-command.js";
import { probeDiscordAcpBindingHealth } from "./provider.acp.js";
import { resolveDiscordAllowlistConfig } from "./provider.allowlist.js";
import { cleanupDiscordProviderStartup } from "./provider.cleanup.js";
import {
  resolveDiscordProviderCommandSpecs,
  type GetPluginCommandSpecs,
} from "./provider.commands.js";
import { logDiscordResolvedConfig } from "./provider.config-log.js";
import {
  formatDiscordDeployErrorDetails,
  formatDiscordDeployErrorMessage,
} from "./provider.deploy-errors.js";
import { runDiscordCommandDeployInBackground } from "./provider.deploy.js";
import { createDiscordProviderInteractionSurface } from "./provider.interactions.js";
import { runDiscordGatewayLifecycle } from "./provider.lifecycle.js";
import { logDiscordStartupPhase as logDiscordStartupPhaseBase } from "./provider.startup-log.js";
import {
  createDiscordMonitorClient,
  fetchDiscordBotIdentity,
  registerDiscordMonitorListeners,
} from "./provider.startup.js";
import { resolveDiscordRestFetch } from "./rest-fetch.js";
import { formatDiscordStartupStatusMessage } from "./startup-status.js";
import type { DiscordMonitorStatusSink } from "./status.js";

export type MonitorDiscordOpts = {
  token?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  channelRuntime?: ChannelRuntimeSurface;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  historyLimit?: number;
  replyToMode?: ReplyToMode;
  setStatus?: DiscordMonitorStatusSink;
};

const DEFAULT_DISCORD_MEDIA_MAX_MB = 100;

type DiscordVoiceManager = import("../voice/manager.js").DiscordVoiceManager;

type DiscordVoiceRuntimeModule = typeof import("../voice/manager.runtime.js");
type DiscordProviderSessionRuntimeModule = typeof import("./provider-session.runtime.js");

let discordVoiceRuntimePromise: Promise<DiscordVoiceRuntimeModule> | undefined;
let discordProviderSessionRuntimePromise: Promise<DiscordProviderSessionRuntimeModule> | undefined;

let fetchDiscordApplicationIdForTesting: typeof fetchDiscordApplicationId | undefined;
let createDiscordNativeCommandForTesting: typeof createDiscordNativeCommand | undefined;
let runDiscordGatewayLifecycleForTesting: typeof runDiscordGatewayLifecycle | undefined;
let createDiscordGatewayPluginForTesting: typeof createDiscordGatewayPlugin | undefined;
let createDiscordGatewaySupervisorForTesting: typeof createDiscordGatewaySupervisor | undefined;
let loadDiscordVoiceRuntimeForTesting: (() => Promise<DiscordVoiceRuntimeModule>) | undefined;
let loadDiscordProviderSessionRuntimeForTesting:
  | (() => Promise<DiscordProviderSessionRuntimeModule>)
  | undefined;
let createClientForTesting:
  | ((
      options: ConstructorParameters<typeof Client>[0],
      handlers: ConstructorParameters<typeof Client>[1],
      plugins: ConstructorParameters<typeof Client>[2],
    ) => Client)
  | undefined;
let getPluginCommandSpecsForTesting: GetPluginCommandSpecs | undefined;
let resolveDiscordAccountForTesting: typeof resolveDiscordAccount | undefined;
let resolveNativeCommandsEnabledForTesting: typeof resolveNativeCommandsEnabled | undefined;
let resolveNativeSkillsEnabledForTesting: typeof resolveNativeSkillsEnabled | undefined;
let listNativeCommandSpecsForConfigForTesting: typeof listNativeCommandSpecsForConfig | undefined;
let listSkillCommandsForAgentsForTesting: typeof listSkillCommandsForAgents | undefined;
let isVerboseForTesting: typeof isVerbose | undefined;
let shouldLogVerboseForTesting: typeof shouldLogVerbose | undefined;

function logDiscordStartupPhase(
  params: Omit<Parameters<typeof logDiscordStartupPhaseBase>[0], "isVerbose">,
) {
  logDiscordStartupPhaseBase({
    ...params,
    isVerbose: isVerboseForTesting ?? isVerbose,
  });
}

async function loadDiscordVoiceRuntime(): Promise<DiscordVoiceRuntimeModule> {
  if (loadDiscordVoiceRuntimeForTesting) {
    return await loadDiscordVoiceRuntimeForTesting();
  }
  const promise = discordVoiceRuntimePromise ?? import("../voice/manager.runtime.js");
  discordVoiceRuntimePromise = promise;
  try {
    return await promise;
  } catch (error) {
    if (discordVoiceRuntimePromise === promise) {
      discordVoiceRuntimePromise = undefined;
    }
    throw error;
  }
}

async function loadDiscordProviderSessionRuntime(): Promise<DiscordProviderSessionRuntimeModule> {
  if (loadDiscordProviderSessionRuntimeForTesting) {
    return await loadDiscordProviderSessionRuntimeForTesting();
  }
  const promise = discordProviderSessionRuntimePromise ?? import("./provider-session.runtime.js");
  discordProviderSessionRuntimePromise = promise;
  try {
    return await promise;
  } catch (error) {
    if (discordProviderSessionRuntimePromise === promise) {
      discordProviderSessionRuntimePromise = undefined;
    }
    throw error;
  }
}

function normalizeBooleanForTesting(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function resolveThreadBindingsEnabledForTesting(params: {
  channelEnabledRaw: unknown;
  sessionEnabledRaw: unknown;
}): boolean {
  return (
    normalizeBooleanForTesting(params.channelEnabledRaw) ??
    normalizeBooleanForTesting(params.sessionEnabledRaw) ??
    true
  );
}

const DISCORD_DISALLOWED_INTENTS_CODE = GatewayCloseCodes.DisallowedIntents;

function isDiscordDisallowedIntentsError(err: unknown): boolean {
  if (!err) {
    return false;
  }
  const message = formatErrorMessage(err);
  return message.includes(String(DISCORD_DISALLOWED_INTENTS_CODE));
}

export async function monitorDiscordProvider(opts: MonitorDiscordOpts = {}) {
  const startupStartedAt = Date.now();
  const cfg = opts.config ?? getRuntimeConfig();
  const account = (resolveDiscordAccountForTesting ?? resolveDiscordAccount)({
    cfg,
    accountId: opts.accountId,
  });
  const token =
    normalizeDiscordToken(opts.token ?? undefined, "channels.discord.token") ?? account.token;
  if (!token) {
    throw new Error(
      `Discord bot token missing for account "${account.accountId}" (set discord.accounts.${account.accountId}.token or DISCORD_BOT_TOKEN for default).`,
    );
  }

  const runtime: RuntimeEnv = opts.runtime ?? createNonExitingRuntime();

  const rawDiscordCfg = account.config;
  const discordRootThreadBindings = cfg.channels?.discord?.threadBindings;
  const discordAccountThreadBindings =
    cfg.channels?.discord?.accounts?.[account.accountId]?.threadBindings;
  const discordRestFetch = resolveDiscordRestFetch(rawDiscordCfg.proxy, runtime);
  const discordProxyFetch = resolveDiscordProxyFetchForAccount(account, cfg, runtime);
  const dmConfig = rawDiscordCfg.dm;
  const configuredDmAllowFrom = resolveDiscordAccountAllowFrom({
    cfg,
    accountId: account.accountId,
  });
  let guildEntries = rawDiscordCfg.guilds;
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const providerConfigPresent = cfg.channels?.discord !== undefined;
  const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent,
    groupPolicy: rawDiscordCfg.groupPolicy,
    defaultGroupPolicy,
  });
  const discordCfg =
    rawDiscordCfg.groupPolicy === groupPolicy ? rawDiscordCfg : { ...rawDiscordCfg, groupPolicy };
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "discord",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.guild,
    log: (message) => runtime.log?.(warn(message)),
  });
  let allowFrom = configuredDmAllowFrom ?? [];
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? discordCfg.mediaMaxMb ?? DEFAULT_DISCORD_MEDIA_MAX_MB) * 1024 * 1024;
  const textLimit = resolveTextChunkLimit(cfg, "discord", account.accountId, {
    fallbackLimit: 2000,
  });
  const historyLimit = Math.max(
    0,
    opts.historyLimit ?? discordCfg.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? 20,
  );
  const replyToMode = opts.replyToMode ?? discordCfg.replyToMode ?? "off";
  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicy =
    resolveDiscordAccountDmPolicy({
      cfg,
      accountId: account.accountId,
    }) ?? "pairing";
  const discordProviderSessionRuntime = await loadDiscordProviderSessionRuntime();
  const threadBindingIdleTimeoutMs =
    discordProviderSessionRuntime.resolveThreadBindingIdleTimeoutMs({
      channelIdleHoursRaw:
        discordAccountThreadBindings?.idleHours ?? discordRootThreadBindings?.idleHours,
      sessionIdleHoursRaw: cfg.session?.threadBindings?.idleHours,
    });
  const threadBindingMaxAgeMs = discordProviderSessionRuntime.resolveThreadBindingMaxAgeMs({
    channelMaxAgeHoursRaw:
      discordAccountThreadBindings?.maxAgeHours ?? discordRootThreadBindings?.maxAgeHours,
    sessionMaxAgeHoursRaw: cfg.session?.threadBindings?.maxAgeHours,
  });
  const threadBindingsEnabled = discordProviderSessionRuntime.resolveThreadBindingsEnabled({
    channelEnabledRaw: discordAccountThreadBindings?.enabled ?? discordRootThreadBindings?.enabled,
    sessionEnabledRaw: cfg.session?.threadBindings?.enabled,
  });
  const groupDmEnabled = dmConfig?.groupEnabled ?? false;
  const groupDmChannels = dmConfig?.groupChannels;
  const nativeEnabled = (resolveNativeCommandsEnabledForTesting ?? resolveNativeCommandsEnabled)({
    providerId: "discord",
    providerSetting: discordCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const nativeSkillsEnabled = (resolveNativeSkillsEnabledForTesting ?? resolveNativeSkillsEnabled)({
    providerId: "discord",
    providerSetting: discordCfg.commands?.nativeSkills,
    globalSetting: cfg.commands?.nativeSkills,
  });
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const slashCommand = resolveDiscordSlashCommandConfig(discordCfg.slashCommand);
  const sessionPrefix = "discord:slash";
  const ephemeralDefault = slashCommand.ephemeral;
  const voiceEnabled = resolveDiscordVoiceEnabled(discordCfg.voice);

  const allowlistResolved = await resolveDiscordAllowlistConfig({
    token,
    guildEntries,
    allowFrom,
    fetcher: discordRestFetch,
    runtime,
  });
  guildEntries = allowlistResolved.guildEntries;
  allowFrom = allowlistResolved.allowFrom ?? [];

  if ((shouldLogVerboseForTesting ?? shouldLogVerbose)()) {
    logDiscordResolvedConfig({
      dmEnabled,
      dmPolicy,
      allowFrom,
      groupDmEnabled,
      groupDmChannels,
      groupPolicy,
      guildEntries,
      historyLimit,
      mediaMaxBytes,
      nativeEnabled,
      nativeSkillsEnabled,
      useAccessGroups,
      threadBindingsEnabled,
      threadBindingIdleTimeoutMs,
      threadBindingMaxAgeMs,
    });
  }

  logDiscordStartupPhase({
    runtime,
    accountId: account.accountId,
    phase: "fetch-application-id:start",
    startAt: startupStartedAt,
  });
  const configuredApplicationId =
    typeof discordCfg.applicationId === "string" && discordCfg.applicationId.trim()
      ? discordCfg.applicationId.trim()
      : undefined;
  const parsedApplicationId = configuredApplicationId ?? parseApplicationIdFromToken(token);
  const applicationId =
    parsedApplicationId ??
    (await (fetchDiscordApplicationIdForTesting ?? fetchDiscordApplicationId)(
      token,
      4000,
      discordRestFetch,
    ));
  if (!applicationId) {
    throw new Error("Failed to resolve Discord application id");
  }
  logDiscordStartupPhase({
    runtime,
    accountId: account.accountId,
    phase: "fetch-application-id:done",
    startAt: startupStartedAt,
    details: `applicationId=${applicationId}`,
  });

  const { commandSpecs } = await resolveDiscordProviderCommandSpecs({
    cfg,
    runtime,
    nativeEnabled,
    nativeSkillsEnabled,
    listSkillCommandsForAgents: listSkillCommandsForAgentsForTesting ?? listSkillCommandsForAgents,
    listNativeCommandSpecsForConfig:
      listNativeCommandSpecsForConfigForTesting ?? listNativeCommandSpecsForConfig,
    getPluginCommandSpecs: getPluginCommandSpecsForTesting,
  });
  const voiceManagerRef: { current: DiscordVoiceManager | null } = { current: null };
  const threadBindings = threadBindingsEnabled
    ? discordProviderSessionRuntime.createThreadBindingManager({
        accountId: account.accountId,
        token,
        cfg,
        idleTimeoutMs: threadBindingIdleTimeoutMs,
        maxAgeMs: threadBindingMaxAgeMs,
      })
    : discordProviderSessionRuntime.createNoopThreadBindingManager(account.accountId);
  if (threadBindingsEnabled) {
    const uncertainProbeKeys = new Set<string>();
    const reconciliation = await discordProviderSessionRuntime.reconcileAcpThreadBindingsOnStartup({
      cfg,
      accountId: account.accountId,
      sendFarewell: false,
      healthProbe: async ({ sessionKey, session }) => {
        const probe = await probeDiscordAcpBindingHealth({
          cfg,
          sessionKey,
          storedState: session.acp?.state,
          lastActivityAt: session.acp?.lastActivityAt,
          providerSessionRuntime: discordProviderSessionRuntime,
        });
        if (probe.status === "uncertain") {
          uncertainProbeKeys.add(`${sessionKey}${probe.reason ? ` (${probe.reason})` : ""}`);
        }
        return probe;
      },
    });
    if (reconciliation.removed > 0) {
      logVerbose(
        `discord: removed ${reconciliation.removed}/${reconciliation.checked} stale ACP thread bindings on startup for account ${account.accountId}: ${reconciliation.staleSessionKeys.join(", ")}`,
      );
    }
    if (uncertainProbeKeys.size > 0) {
      logVerbose(
        `discord: ACP thread-binding health probe uncertain for account ${account.accountId}: ${[...uncertainProbeKeys].join(", ")}`,
      );
    }
  }
  let lifecycleStarted = false;
  let gatewaySupervisor: ReturnType<typeof createDiscordGatewaySupervisor> | undefined;
  let deactivateMessageHandler: (() => void) | undefined;
  let autoPresenceController: Awaited<
    ReturnType<typeof createDiscordMonitorClient>
  >["autoPresenceController"] = null;
  let lifecycleGateway: MutableDiscordGateway | undefined;
  let earlyGatewayEmitter = gatewaySupervisor?.emitter;
  let onEarlyGatewayDebug: ((msg: unknown) => void) | undefined;
  try {
    const { commands, components, modals } = createDiscordProviderInteractionSurface({
      cfg,
      discordConfig: discordCfg,
      accountId: account.accountId,
      token,
      commandSpecs,
      nativeEnabled,
      voiceEnabled,
      groupPolicy,
      useAccessGroups,
      sessionPrefix,
      ephemeralDefault,
      threadBindings,
      voiceManagerRef,
      guildEntries,
      allowFrom,
      dmPolicy,
      runtime,
      channelRuntime: opts.channelRuntime,
      abortSignal: opts.abortSignal,
      createNativeCommand: createDiscordNativeCommandForTesting ?? createDiscordNativeCommand,
    });

    const {
      client,
      gateway,
      gatewaySupervisor: createdGatewaySupervisor,
      autoPresenceController: createdAutoPresenceController,
    } = await createDiscordMonitorClient({
      accountId: account.accountId,
      applicationId,
      token,
      proxyFetch: discordProxyFetch,
      commands,
      components,
      modals,
      voiceEnabled,
      discordConfig: discordCfg,
      runtime,
      createClient: createClientForTesting ?? ((...args) => new Client(...args)),
      createGatewayPlugin: createDiscordGatewayPluginForTesting ?? createDiscordGatewayPlugin,
      createGatewaySupervisor:
        createDiscordGatewaySupervisorForTesting ?? createDiscordGatewaySupervisor,
      createAutoPresenceController: createDiscordAutoPresenceController,
      isDisallowedIntentsError: isDiscordDisallowedIntentsError,
    });
    lifecycleGateway = gateway;
    gatewaySupervisor = createdGatewaySupervisor;
    autoPresenceController = createdAutoPresenceController;

    earlyGatewayEmitter = gatewaySupervisor.emitter;
    onEarlyGatewayDebug = (msg: unknown) => {
      if (!(isVerboseForTesting ?? isVerbose)()) {
        return;
      }
      runtime.log?.(
        `discord startup [${account.accountId}] gateway-debug ${Math.max(0, Date.now() - startupStartedAt)}ms ${String(msg)}`,
      );
    };
    earlyGatewayEmitter?.on("debug", onEarlyGatewayDebug);

    logDiscordStartupPhase({
      runtime,
      accountId: account.accountId,
      phase: "deploy-commands:schedule",
      startAt: startupStartedAt,
      gateway: lifecycleGateway,
      details: `native=${nativeEnabled ? "on" : "off"} reconcile=on commandCount=${commands.length}`,
    });
    runDiscordCommandDeployInBackground({
      client,
      runtime,
      enabled: nativeEnabled,
      accountId: account.accountId,
      startupStartedAt,
      shouldLogVerbose: shouldLogVerboseForTesting ?? shouldLogVerbose,
      isVerbose: isVerboseForTesting ?? isVerbose,
    });

    const logger = createSubsystemLogger("discord/monitor");
    const guildHistories = new Map<
      string,
      import("openclaw/plugin-sdk/reply-history").HistoryEntry[]
    >();
    let { botUserId, botUserName } = await fetchDiscordBotIdentity({
      client,
      token,
      runtime,
      logStartupPhase: (phase, details) =>
        logDiscordStartupPhase({
          runtime,
          accountId: account.accountId,
          phase,
          startAt: startupStartedAt,
          gateway: lifecycleGateway,
          details,
        }),
    });
    let voiceManager: DiscordVoiceManager | null = null;

    if (voiceEnabled) {
      const { DiscordVoiceManager, DiscordVoiceReadyListener, DiscordVoiceResumedListener } =
        await loadDiscordVoiceRuntime();
      voiceManager = new DiscordVoiceManager({
        client,
        cfg,
        discordConfig: discordCfg,
        accountId: account.accountId,
        runtime,
        botUserId,
      });
      voiceManagerRef.current = voiceManager;
      registerDiscordListener(client.listeners, new DiscordVoiceReadyListener(voiceManager));
      registerDiscordListener(client.listeners, new DiscordVoiceResumedListener(voiceManager));
    }

    const messageHandler = discordProviderSessionRuntime.createDiscordMessageHandler({
      cfg,
      discordConfig: discordCfg,
      accountId: account.accountId,
      token,
      runtime,
      setStatus: opts.setStatus,
      abortSignal: opts.abortSignal,
      botUserId,
      guildHistories,
      historyLimit,
      mediaMaxBytes,
      textLimit,
      replyToMode,
      dmEnabled,
      dmPolicy,
      groupDmEnabled,
      groupDmChannels,
      allowFrom,
      guildEntries,
      threadBindings,
      discordRestFetch,
    });
    deactivateMessageHandler = messageHandler.deactivate;
    const trackInboundEvent = opts.setStatus
      ? () => {
          const at = Date.now();
          // Gateway heartbeat ACKs are transport-level; Discord app events stay app-level only.
          opts.setStatus?.({ lastEventAt: at, lastInboundAt: at });
        }
      : undefined;
    registerDiscordMonitorListeners({
      cfg,
      client,
      accountId: account.accountId,
      discordConfig: discordCfg,
      runtime,
      botUserId,
      dmEnabled,
      groupDmEnabled,
      groupDmChannels,
      dmPolicy,
      allowFrom,
      groupPolicy,
      guildEntries,
      logger,
      messageHandler,
      trackInboundEvent,
    });

    logDiscordStartupPhase({
      runtime,
      accountId: account.accountId,
      phase: "client-start",
      startAt: startupStartedAt,
      gateway: lifecycleGateway,
    });

    const botIdentity =
      botUserId && botUserName ? `${botUserId} (${botUserName})` : (botUserId ?? botUserName ?? "");
    runtime.log?.(
      formatDiscordStartupStatusMessage({
        gatewayReady: lifecycleGateway?.isConnected === true,
        botIdentity: botIdentity || undefined,
      }),
    );
    if (lifecycleGateway?.isConnected) {
      opts.setStatus?.(createConnectedChannelStatusPatch());
    }

    lifecycleStarted = true;
    earlyGatewayEmitter?.removeListener("debug", onEarlyGatewayDebug);
    onEarlyGatewayDebug = undefined;
    await (runDiscordGatewayLifecycleForTesting ?? runDiscordGatewayLifecycle)({
      accountId: account.accountId,
      gateway: lifecycleGateway,
      runtime,
      abortSignal: opts.abortSignal,
      statusSink: opts.setStatus,
      isDisallowedIntentsError: isDiscordDisallowedIntentsError,
      voiceManager,
      voiceManagerRef,
      threadBindings,
      gatewaySupervisor,
      gatewayReadyTimeoutMs: account.config.gatewayReadyTimeoutMs,
      gatewayRuntimeReadyTimeoutMs: account.config.gatewayRuntimeReadyTimeoutMs,
    });
  } finally {
    cleanupDiscordProviderStartup({
      deactivateMessageHandler,
      autoPresenceController,
      setStatus: opts.setStatus,
      onEarlyGatewayDebug,
      earlyGatewayEmitter,
      lifecycleStarted,
      lifecycleGateway,
      gatewaySupervisor,
      threadBindings,
      runtime,
    });
  }
}

export const __testing = {
  createDiscordGatewayPlugin,
  resolveDiscordRuntimeGroupPolicy: resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveDiscordRestFetch,
  resolveThreadBindingsEnabled: resolveThreadBindingsEnabledForTesting,
  formatDiscordDeployErrorDetails,
  formatDiscordDeployErrorMessage,
  setFetchDiscordApplicationId(mock?: typeof fetchDiscordApplicationId) {
    fetchDiscordApplicationIdForTesting = mock;
  },
  setCreateDiscordNativeCommand(mock?: typeof createDiscordNativeCommand) {
    createDiscordNativeCommandForTesting = mock;
  },
  setRunDiscordGatewayLifecycle(mock?: typeof runDiscordGatewayLifecycle) {
    runDiscordGatewayLifecycleForTesting = mock;
  },
  setCreateDiscordGatewayPlugin(mock?: typeof createDiscordGatewayPlugin) {
    createDiscordGatewayPluginForTesting = mock;
  },
  setCreateDiscordGatewaySupervisor(mock?: typeof createDiscordGatewaySupervisor) {
    createDiscordGatewaySupervisorForTesting = mock;
  },
  setLoadDiscordVoiceRuntime(mock?: () => Promise<DiscordVoiceRuntimeModule>) {
    loadDiscordVoiceRuntimeForTesting = mock;
  },
  setLoadDiscordProviderSessionRuntime(mock?: () => Promise<DiscordProviderSessionRuntimeModule>) {
    loadDiscordProviderSessionRuntimeForTesting = mock;
  },
  setCreateClient(
    mock?: (
      options: ConstructorParameters<typeof Client>[0],
      handlers: ConstructorParameters<typeof Client>[1],
      plugins: ConstructorParameters<typeof Client>[2],
    ) => Client,
  ) {
    createClientForTesting = mock;
  },
  setGetPluginCommandSpecs(mock?: GetPluginCommandSpecs) {
    getPluginCommandSpecsForTesting = mock;
  },
  setResolveDiscordAccount(mock?: typeof resolveDiscordAccount) {
    resolveDiscordAccountForTesting = mock;
  },
  setResolveNativeCommandsEnabled(mock?: typeof resolveNativeCommandsEnabled) {
    resolveNativeCommandsEnabledForTesting = mock;
  },
  setResolveNativeSkillsEnabled(mock?: typeof resolveNativeSkillsEnabled) {
    resolveNativeSkillsEnabledForTesting = mock;
  },
  setListNativeCommandSpecsForConfig(mock?: typeof listNativeCommandSpecsForConfig) {
    listNativeCommandSpecsForConfigForTesting = mock;
  },
  setListSkillCommandsForAgents(mock?: typeof listSkillCommandsForAgents) {
    listSkillCommandsForAgentsForTesting = mock;
  },
  setIsVerbose(mock?: typeof isVerbose) {
    isVerboseForTesting = mock;
  },
  setShouldLogVerbose(mock?: typeof shouldLogVerbose) {
    shouldLogVerboseForTesting = mock;
  },
};

export const resolveDiscordRuntimeGroupPolicy = resolveOpenProviderRuntimeGroupPolicy;
