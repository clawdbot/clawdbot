import { inspect } from "node:util";
import { Client } from "@buape/carbon";
import { GatewayIntents, GatewayPlugin } from "@buape/carbon/gateway";
import { Routes } from "discord-api-types/v10";
import { resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import { listNativeCommandSpecsForConfig } from "../../auto-reply/commands-registry.js";
import { listSkillCommandsForAgents } from "../../auto-reply/skill-commands.js";
import type { HistoryEntry } from "../../auto-reply/reply/history.js";
import { mergeAllowlist, summarizeMapping } from "../../channels/allowlists/resolve-utils.js";
import {
  isNativeCommandsExplicitlyDisabled,
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "../../config/commands.js";
import type { MoltbotConfig, ReplyToMode } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { danger, logVerbose, shouldLogVerbose, warn } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createDiscordRetryRunner } from "../../infra/retry-policy.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { RuntimeEnv } from "../../runtime.js";
import { resolveDiscordAccount } from "../accounts.js";
import { attachDiscordGatewayLogging } from "../gateway-logging.js";
import { getDiscordGatewayEmitter, waitForDiscordGatewayStop } from "../monitor.gateway.js";
import { fetchDiscordApplicationId } from "../probe.js";
import { resolveDiscordChannelAllowlist } from "../resolve-channels.js";
import { resolveDiscordUserAllowlist } from "../resolve-users.js";
import { normalizeDiscordToken } from "../token.js";
import {
  DiscordMessageListener,
  DiscordPresenceListener,
  DiscordReactionListener,
  DiscordReactionRemoveListener,
  registerDiscordListener,
} from "./listeners.js";
import { createDiscordMessageHandler } from "./message-handler.js";
import {
  createDiscordCommandArgFallbackButton,
  createDiscordNativeCommand,
} from "./native-command.js";
import { createExecApprovalButton, DiscordExecApprovalHandler } from "./exec-approvals.js";

export type MonitorDiscordOpts = {
  token?: string;
  accountId?: string;
  config?: MoltbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  historyLimit?: number;
  replyToMode?: ReplyToMode;
};

function summarizeAllowList(list?: Array<string | number>) {
  if (!list || list.length === 0) return "any";
  const sample = list.slice(0, 4).map((entry) => String(entry));
  const suffix = list.length > sample.length ? ` (+${list.length - sample.length})` : "";
  return `${sample.join(", ")}${suffix}`;
}

function summarizeGuilds(entries?: Record<string, unknown>) {
  if (!entries || Object.keys(entries).length === 0) return "any";
  const keys = Object.keys(entries);
  const sample = keys.slice(0, 4);
  const suffix = keys.length > sample.length ? ` (+${keys.length - sample.length})` : "";
  return `${sample.join(", ")}${suffix}`;
}

async function deployDiscordCommands(params: {
  client: Client;
  runtime: RuntimeEnv;
  enabled: boolean;
}) {
  if (!params.enabled) return;
  const runWithRetry = createDiscordRetryRunner({ verbose: shouldLogVerbose() });
  try {
    await runWithRetry(() => params.client.handleDeployRequest(), "command deploy");
  } catch (err) {
    const details = formatDiscordDeployErrorDetails(err);
    params.runtime.error?.(
      danger(`discord: failed to deploy native commands: ${formatErrorMessage(err)}${details}`),
    );
  }
}

function formatDiscordDeployErrorDetails(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const status = (err as { status?: unknown }).status;
  const discordCode = (err as { discordCode?: unknown }).discordCode;
  const rawBody = (err as { rawBody?: unknown }).rawBody;
  const details: string[] = [];
  if (typeof status === "number") details.push(`status=${status}`);
  if (typeof discordCode === "number" || typeof discordCode === "string") {
    details.push(`code=${discordCode}`);
  }
  if (rawBody !== undefined) {
    let bodyText = "";
    try {
      bodyText = JSON.stringify(rawBody);
    } catch {
      bodyText =
        typeof rawBody === "string" ? rawBody : inspect(rawBody, { depth: 3, breakLength: 120 });
    }
    if (bodyText) {
      const maxLen = 800;
      const trimmed = bodyText.length > maxLen ? `${bodyText.slice(0, maxLen)}...` : bodyText;
      details.push(`body=${trimmed}`);
    }
  }
  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

function resolveDiscordGatewayIntents(
  intentsConfig?: import("../../config/types.discord.js").DiscordIntentsConfig,
): number {
  let intents =
    GatewayIntents.Guilds |
    GatewayIntents.GuildMessages |
    GatewayIntents.MessageContent |
    GatewayIntents.DirectMessages |
    GatewayIntents.GuildMessageReactions |
    GatewayIntents.DirectMessageReactions;
  if (intentsConfig?.presence) {
    intents |= GatewayIntents.GuildPresences;
  }
  if (intentsConfig?.guildMembers) {
    intents |= GatewayIntents.GuildMembers;
  }
  return intents;
}

export async function monitorDiscordProvider(opts: MonitorDiscordOpts = {}) {
  const cfg = opts.config ?? loadConfig();
  const account = resolveDiscordAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = normalizeDiscordToken(opts.token ?? undefined) ?? account.token;
  if (!token) {
    throw new Error(
      `Discord bot token missing for account "${account.accountId}" (set discord.accounts.${account.accountId}.token or DISCORD_BOT_TOKEN for default).`,
    );
  }

  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const discordCfg = account.config;
  const dmConfig = discordCfg.dm;
  let guildEntries = discordCfg.guilds;
  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicy = discordCfg.groupPolicy ?? defaultGroupPolicy ?? "open";
  if (
    discordCfg.groupPolicy === undefined &&
    discordCfg.guilds === undefined &&
    defaultGroupPolicy === undefined &&
    groupPolicy === "open"
  ) {
    runtime.log?.(
      warn(
        'discord: groupPolicy defaults to "open" when channels.discord is missing; set channels.discord.groupPolicy (or channels.defaults.groupPolicy) or add channels.discord.guilds to restrict access.',
      ),
    );
  }
  let allowFrom = dmConfig?.allowFrom;
  const mediaMaxBytes = (opts.mediaMaxMb ?? discordCfg.mediaMaxMb ?? 8) * 1024 * 1024;
  const textLimit = resolveTextChunkLimit(cfg, "discord", account.accountId, {
    fallbackLimit: 2000,
  });
  const historyLimit = Math.max(
    0,
    opts.historyLimit ?? discordCfg.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? 20,
  );
  const replyToMode = opts.replyToMode ?? discordCfg.replyToMode ?? "off";
  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicy = dmConfig?.policy ?? "pairing";
  const groupDmEnabled = dmConfig?.groupEnabled ?? false;
  const groupDmChannels = dmConfig?.groupChannels;
  const nativeEnabled = resolveNativeCommandsEnabled({
    providerId: "discord",
    providerSetting: discordCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const nativeSkillsEnabled = resolveNativeSkillsEnabled({
    providerId: "discord",
    providerSetting: discordCfg.commands?.nativeSkills,
    globalSetting: cfg.commands?.nativeSkills,
  });
  const nativeDisabledExplicit = isNativeCommandsExplicitlyDisabled({
    providerSetting: discordCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const sessionPrefix = "discord:slash";
  const ephemeralDefault = true;

  if (token) {
    if (guildEntries && Object.keys(guildEntries).length > 0) {
      try {
        const entries: Array<{ input: string; guildKey: string; channelKey?: string }> = [];
        for (const [guildKey, guildCfg] of Object.entries(guildEntries)) {
          if (guildKey === "*") continue;
          const channels = guildCfg?.channels ?? {};
          const channelKeys = Object.keys(channels).filter((key) => key !== "*");
          if (channelKeys.length === 0) {
            entries.push({ input: guildKey, guildKey });
            continue;
          }
          for (const channelKey of channelKeys) {
            entries.push({
              input: `${guildKey}/${channelKey}`,
              guildKey,
              channelKey,
            });
          }
        }
        if (entries.length > 0) {
          const resolved = await resolveDiscordChannelAllowlist({
            token,
            entries: entries.map((entry) => entry.input),
          });
          const nextGuilds = { ...guildEntries };
          const mapping: string[] = [];
          const unresolved: string[] = [];
          for (const entry of resolved) {
            const source = entries.find((item) => item.input === entry.input);
            if (!source) continue;
            const sourceGuild = guildEntries?.[source.guildKey] ?? {};
            if (!entry.resolved || !entry.guildId) {
              unresolved.push(entry.input);
              continue;
            }
            mapping.push(
              entry.channelId
                ? `${entry.input}→${entry.guildId}/${entry.channelId}`
                : `${entry.input}→${entry.guildId}`,
            );
            const existing = nextGuilds[entry.guildId] ?? {};
            const mergedChannels = { ...sourceGuild.channels, ...existing.channels };
            const mergedGuild = { ...sourceGuild, ...existing, channels: mergedChannels };
            nextGuilds[entry.guildId] = mergedGuild;
            if (source.channelKey && entry.channelId) {
              const sourceChannel = sourceGuild.channels?.[source.channelKey];
              if (sourceChannel) {
                nextGuilds[entry.guildId] = {
                  ...mergedGuild,
                  channels: {
                    ...mergedChannels,
                    [entry.channelId]: {
                      ...sourceChannel,
                      ...mergedChannels?.[entry.channelId],
                    },
                  },
                };
              }
            }
          }
          guildEntries = nextGuilds;
          summarizeMapping("discord channels", mapping, unresolved, runtime);
        }
      } catch (err) {
        runtime.log?.(
          `discord channel resolve failed; using config entries. ${formatErrorMessage(err)}`,
        );
      }
    }

    const allowEntries =
      allowFrom?.filter((entry) => String(entry).trim() && String(entry).trim() !== "*") ?? [];
    if (allowEntries.length > 0) {
      try {
        const resolvedUsers = await resolveDiscordUserAllowlist({
          token,
          entries: allowEntries.map((entry) => String(entry)),
        });
        const mapping: string[] = [];
        const unresolved: string[] = [];
        const additions: string[] = [];
        for (const entry of resolvedUsers) {
          if (entry.resolved && entry.id) {
            mapping.push(`${entry.input}→${entry.id}`);
            additions.push(entry.id);
          } else {
            unresolved.push(entry.input);
          }
        }
        allowFrom = mergeAllowlist({ existing: allowFrom, additions });
        summarizeMapping("discord users", mapping, unresolved, runtime);
      } catch (err) {
        runtime.log?.(
          `discord user resolve failed; using config entries. ${formatErrorMessage(err)}`,
        );
      }
    }

    if (guildEntries && Object.keys(guildEntries).length > 0) {
      const userEntries = new Set<string>();
      for (const guild of Object.values(guildEntries)) {
        if (!guild || typeof guild !== "object") continue;
        const users = (guild as { users?: Array<string | number> }).users;
        if (Array.isArray(users)) {
          for (const entry of users) {
            const trimmed = String(entry).trim();
            if (trimmed && trimmed !== "*") userEntries.add(trimmed);
          }
        }
        const channels = (guild as { channels?: Record<string, unknown> }).channels ?? {};
        for (const channel of Object.values(channels)) {
          if (!channel || typeof channel !== "object") continue;
          const channelUsers = (channel as { users?: Array<string | number> }).users;
          if (!Array.isArray(channelUsers)) continue;
          for (const entry of channelUsers) {
            const trimmed = String(entry).trim();
            if (trimmed && trimmed !== "*") userEntries.add(trimmed);
          }
        }
      }

      if (userEntries.size > 0) {
        try {
          const resolvedUsers = await resolveDiscordUserAllowlist({
            token,
            entries: Array.from(userEntries),
          });
          const resolvedMap = new Map(resolvedUsers.map((entry) => [entry.input, entry]));
          const mapping = resolvedUsers
            .filter((entry) => entry.resolved && entry.id)
            .map((entry) => `${entry.input}→${entry.id}`);
          const unresolved = resolvedUsers
            .filter((entry) => !entry.resolved)
            .map((entry) => entry.input);

          const nextGuilds = { ...guildEntries };
          for (const [guildKey, guildConfig] of Object.entries(guildEntries ?? {})) {
            if (!guildConfig || typeof guildConfig !== "object") continue;
            const nextGuild = { ...guildConfig } as Record<string, unknown>;
            const users = (guildConfig as { users?: Array<string | number> }).users;
            if (Array.isArray(users) && users.length > 0) {
              const additions: string[] = [];
              for (const entry of users) {
                const trimmed = String(entry).trim();
                const resolved = resolvedMap.get(trimmed);
                if (resolved?.resolved && resolved.id) additions.push(resolved.id);
              }
              nextGuild.users = mergeAllowlist({ existing: users, additions });
            }
            const channels = (guildConfig as { channels?: Record<string, unknown> }).channels ?? {};
            if (channels && typeof channels === "object") {
              const nextChannels: Record<string, unknown> = { ...channels };
              for (const [channelKey, channelConfig] of Object.entries(channels)) {
                if (!channelConfig || typeof channelConfig !== "object") continue;
                const channelUsers = (channelConfig as { users?: Array<string | number> }).users;
                if (!Array.isArray(channelUsers) || channelUsers.length === 0) continue;
                const additions: string[] = [];
                for (const entry of channelUsers) {
                  const trimmed = String(entry).trim();
                  const resolved = resolvedMap.get(trimmed);
                  if (resolved?.resolved && resolved.id) additions.push(resolved.id);
                }
                nextChannels[channelKey] = {
                  ...channelConfig,
                  users: mergeAllowlist({ existing: channelUsers, additions }),
                };
              }
              nextGuild.channels = nextChannels;
            }
            nextGuilds[guildKey] = nextGuild;
          }
          guildEntries = nextGuilds;
          summarizeMapping("discord channel users", mapping, unresolved, runtime);
        } catch (err) {
          runtime.log?.(
            `discord channel user resolve failed; using config entries. ${formatErrorMessage(err)}`,
          );
        }
      }
    }
  }

  if (shouldLogVerbose()) {
    logVerbose(
      `discord: config dm=${dmEnabled ? "on" : "off"} dmPolicy=${dmPolicy} allowFrom=${summarizeAllowList(allowFrom)} groupDm=${groupDmEnabled ? "on" : "off"} groupDmChannels=${summarizeAllowList(groupDmChannels)} groupPolicy=${groupPolicy} guilds=${summarizeGuilds(guildEntries)} historyLimit=${historyLimit} mediaMaxMb=${Math.round(mediaMaxBytes / (1024 * 1024))} native=${nativeEnabled ? "on" : "off"} nativeSkills=${nativeSkillsEnabled ? "on" : "off"} accessGroups=${useAccessGroups ? "on" : "off"}`,
    );
  }

  const applicationId = await fetchDiscordApplicationId(token, 4000);
  if (!applicationId) {
    throw new Error("Failed to resolve Discord application id");
  }

  const maxDiscordCommands = 100;
  let skillCommands =
    nativeEnabled && nativeSkillsEnabled ? listSkillCommandsForAgents({ cfg }) : [];
  let commandSpecs = nativeEnabled
    ? listNativeCommandSpecsForConfig(cfg, { skillCommands, provider: "discord" })
    : [];
  const initialCommandCount = commandSpecs.length;
  if (nativeEnabled && nativeSkillsEnabled && commandSpecs.length > maxDiscordCommands) {
    skillCommands = [];
    commandSpecs = listNativeCommandSpecsForConfig(cfg, { skillCommands: [], provider: "discord" });
    runtime.log?.(
      warn(
        `discord: ${initialCommandCount} commands exceeds limit; removing per-skill commands and keeping /skill.`,
      ),
    );
  }
  if (nativeEnabled && commandSpecs.length > maxDiscordCommands) {
    runtime.log?.(
      warn(
        `discord: ${commandSpecs.length} commands exceeds limit; some commands may fail to deploy.`,
      ),
    );
  }
  const commands = commandSpecs.map((spec) =>
    createDiscordNativeCommand({
      command: spec,
      cfg,
      discordConfig: discordCfg,
      accountId: account.accountId,
      sessionPrefix,
      ephemeralDefault,
    }),
  );

  // Initialize exec approvals handler if enabled
  const execApprovalsConfig = discordCfg.execApprovals ?? {};
  const execApprovalsHandler = execApprovalsConfig.enabled
    ? new DiscordExecApprovalHandler({
        token,
        accountId: account.accountId,
        config: execApprovalsConfig,
        cfg,
        runtime,
      })
    : null;

  const components = [
    createDiscordCommandArgFallbackButton({
      cfg,
      discordConfig: discordCfg,
      accountId: account.accountId,
      sessionPrefix,
    }),
  ];

  if (execApprovalsHandler) {
    components.push(createExecApprovalButton({ handler: execApprovalsHandler }));
  }

  const client = new Client(
    {
      baseUrl: "http://localhost",
      deploySecret: "a",
      clientId: applicationId,
      publicKey: "a",
      token,
      autoDeploy: false,
    },
    {
      commands,
      listeners: [],
      components,
    },
    [
      new GatewayPlugin({
        reconnect: {
          maxAttempts: Number.POSITIVE_INFINITY,
        },
        intents: resolveDiscordGatewayIntents(discordCfg.intents),
        autoInteractions: true,
      }),
    ],
  );

  await deployDiscordCommands({ client, runtime, enabled: nativeEnabled });

  const logger = createSubsystemLogger("discord/monitor");
  const guildHistories = new Map<string, HistoryEntry[]>();
  let botUserId: string | undefined;

  if (nativeDisabledExplicit) {
    await clearDiscordNativeCommands({
      client,
      applicationId,
      runtime,
    });
  }

  try {
    const botUser = await client.fetchUser("@me");
    botUserId = botUser?.id;
  } catch (err) {
    runtime.error?.(danger(`discord: failed to fetch bot identity: ${String(err)}`));
  }

  const messageHandler = createDiscordMessageHandler({
    cfg,
    discordConfig: discordCfg,
    accountId: account.accountId,
    token,
    runtime,
    botUserId,
    guildHistories,
    historyLimit,
    mediaMaxBytes,
    textLimit,
    replyToMode,
    dmEnabled,
    groupDmEnabled,
    groupDmChannels,
    allowFrom,
    guildEntries,
  });

  registerDiscordListener(client.listeners, new DiscordMessageListener(messageHandler, logger));
  registerDiscordListener(
    client.listeners,
    new DiscordReactionListener({
      cfg,
      accountId: account.accountId,
      runtime,
      botUserId,
      guildEntries,
      logger,
    }),
  );
  registerDiscordListener(
    client.listeners,
    new DiscordReactionRemoveListener({
      cfg,
      accountId: account.accountId,
      runtime,
      botUserId,
      guildEntries,
      logger,
    }),
  );

  if (discordCfg.intents?.presence) {
    registerDiscordListener(
      client.listeners,
      new DiscordPresenceListener({ logger, accountId: account.accountId }),
    );
    runtime.log?.("discord: GuildPresences intent enabled — presence listener registered");
  }

  runtime.log?.(`logged in to discord${botUserId ? ` as ${botUserId}` : ""}`);

  // Start exec approvals handler after client is ready
  if (execApprovalsHandler) {
    await execApprovalsHandler.start();
  }

  const gateway = client.getPlugin<GatewayPlugin>("gateway");
  const gatewayEmitter = getDiscordGatewayEmitter(gateway);
  const stopGatewayLogging = attachDiscordGatewayLogging({
    emitter: gatewayEmitter,
    runtime,
  });
  const abortSignal = opts.abortSignal;
  const onAbort = () => {
    if (!gateway) return;
    // Carbon emits an error when maxAttempts is 0; keep a one-shot listener to avoid
    // an unhandled error after we tear down listeners during abort.
    gatewayEmitter?.once("error", () => {});
    gateway.options.reconnect = { maxAttempts: 0 };
    gateway.disconnect();
  };
  if (abortSignal?.aborted) {
    onAbort();
  } else {
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  }
  // Timeout to detect zombie connections where HELLO is never received.
  const HELLO_TIMEOUT_MS = 30000;
  let helloTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const onGatewayDebug = (msg: unknown) => {
    const message = String(msg);
    if (!message.includes("WebSocket connection opened")) return;
    if (helloTimeoutId) clearTimeout(helloTimeoutId);
    helloTimeoutId = setTimeout(() => {
      if (!gateway?.isConnected) {
        runtime.log?.(
          danger(
            `connection stalled: no HELLO received within ${HELLO_TIMEOUT_MS}ms, forcing reconnect`,
          ),
        );
        gateway?.disconnect();
        gateway?.connect(false);
      }
      helloTimeoutId = undefined;
    }, HELLO_TIMEOUT_MS);
  };
  gatewayEmitter?.on("debug", onGatewayDebug);
  try {
    await waitForDiscordGatewayStop({
      gateway: gateway
        ? {
            emitter: gatewayEmitter,
            disconnect: () => gateway.disconnect(),
          }
        : undefined,
      abortSignal,
      onGatewayError: (err) => {
        runtime.error?.(danger(`discord gateway error: ${String(err)}`));
      },
      shouldStopOnError: (err) => {
        const message = String(err);
        return (
          message.includes("Max reconnect attempts") || message.includes("Fatal Gateway error")
        );
      },
    });
  } finally {
    stopGatewayLogging();
    if (helloTimeoutId) clearTimeout(helloTimeoutId);
    gatewayEmitter?.removeListener("debug", onGatewayDebug);
    abortSignal?.removeEventListener("abort", onAbort);
    if (execApprovalsHandler) {
      await execApprovalsHandler.stop();
    }
  }
}

async function clearDiscordNativeCommands(params: {
  client: Client;
  applicationId: string;
  runtime: RuntimeEnv;
}) {
  try {
    await params.client.rest.put(Routes.applicationCommands(params.applicationId), {
      body: [],
    });
    logVerbose("discord: cleared native commands (commands.native=false)");
  } catch (err) {
    params.runtime.error?.(danger(`discord: failed to clear native commands: ${String(err)}`));
  }
}
