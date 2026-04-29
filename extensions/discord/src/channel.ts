import {
  buildLegacyDmAccountAllowlistAdapter,
  createAccountScopedAllowlistNameResolver,
  createNestedAllowlistOverrideResolver,
} from "openclaw/plugin-sdk/allowlist-config-edit";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageToolDiscovery,
} from "openclaw/plugin-sdk/channel-contract";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import {
  createChannelDirectoryAdapter,
  createRuntimeDirectoryLiveAdapter,
} from "openclaw/plugin-sdk/directory-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { resolveTargetsWithOptionalToken } from "openclaw/plugin-sdk/target-resolver-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/text-runtime";
import {
  listDiscordAccountIds,
  resolveDiscordAccount,
  type ResolvedDiscordAccount,
} from "./accounts.js";
import { getDiscordApprovalCapability } from "./approval-native.js";
import { discordMessageActions as discordMessageActionsImpl } from "./channel-actions.js";
import {
  buildTokenChannelStatusSummary,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  projectCredentialSnapshotFields,
  resolveConfiguredFromCredentialStatuses,
  type ChannelPlugin,
  type OpenClawConfig,
} from "./channel-api.js";
import { resolveDiscordCurrentConversationIdentity } from "./conversation-identity.js";
import { shouldSuppressLocalDiscordExecApprovalPrompt } from "./exec-approvals.js";
import {
  resolveDiscordGroupRequireMention,
  resolveDiscordGroupToolPolicy,
} from "./group-policy.js";
import {
  setThreadBindingIdleTimeoutBySessionKey,
  setThreadBindingMaxAgeBySessionKey,
} from "./monitor/thread-bindings.session-updates.js";
import { looksLikeDiscordTargetId, normalizeDiscordMessagingTarget } from "./normalize.js";
import { discordOutbound } from "./outbound-adapter.js";
import { resolveDiscordOutboundSessionRoute } from "./outbound-session-route.js";
import type { DiscordProbe } from "./probe.js";
import { getDiscordRuntime } from "./runtime.js";
import { discordSecurityAdapter } from "./security.js";
import { normalizeExplicitDiscordSessionKey } from "./session-key-normalization.js";
import { discordSetupAdapter } from "./setup-adapter.js";
import { createDiscordPluginBase, discordConfigAdapter } from "./shared.js";
import { collectDiscordStatusIssues } from "./status-issues.js";
import { parseDiscordTarget } from "./target-parsing.js";

let discordProviderRuntimePromise:
  | Promise<typeof import("./monitor/provider.runtime.js")>
  | undefined;
let discordProbeRuntimePromise: Promise<typeof import("./probe.runtime.js")> | undefined;
let discordAuditModulePromise: Promise<typeof import("./audit.js")> | undefined;
let discordSendModulePromise: Promise<typeof import("./send.js")> | undefined;
let discordDirectoryLiveModulePromise: Promise<typeof import("./directory-live.js")> | undefined;

const loadDiscordDirectoryConfigModule = createLazyRuntimeModule(
  () => import("./directory-config.js"),
);
const loadDiscordResolveChannelsModule = createLazyRuntimeModule(
  () => import("./resolve-channels.js"),
);
const loadDiscordResolveUsersModule = createLazyRuntimeModule(() => import("./resolve-users.js"));
const loadDiscordThreadBindingsManagerModule = createLazyRuntimeModule(
  () => import("./monitor/thread-bindings.manager.js"),
);

async function loadDiscordProviderRuntime() {
  discordProviderRuntimePromise ??= import("./monitor/provider.runtime.js");
  return await discordProviderRuntimePromise;
}

async function loadDiscordProbeRuntime() {
  discordProbeRuntimePromise ??= import("./probe.runtime.js");
  return await discordProbeRuntimePromise;
}

async function loadDiscordAuditModule() {
  discordAuditModulePromise ??= import("./audit.js");
  return await discordAuditModulePromise;
}

async function loadDiscordSendModule() {
  discordSendModulePromise ??= import("./send.js");
  return await discordSendModulePromise;
}

async function loadDiscordDirectoryLiveModule() {
  discordDirectoryLiveModulePromise ??= import("./directory-live.js");
  return await discordDirectoryLiveModulePromise;
}

const REQUIRED_DISCORD_PERMISSIONS = ["ViewChannel", "SendMessages"] as const;
const DISCORD_ACCOUNT_STARTUP_STAGGER_MS = 10_000;
function resolveDiscordAttachedOutboundTarget(params: {
  to: string;
  threadId?: string | number | null;
}): string {
  if (params.threadId == null) {
    return params.to;
  }
  const threadId = normalizeOptionalStringifiedId(params.threadId) ?? "";
  return threadId ? `channel:${threadId}` : params.to;
}

function shouldTreatDiscordDeliveredTextAsVisible(params: {
  kind: "tool" | "block" | "final";
  text?: string;
}): boolean {
  return (
    params.kind === "block" && typeof params.text === "string" && params.text.trim().length > 0
  );
}

function resolveRuntimeDiscordMessageActions() {
  try {
    return getDiscordRuntime().channel?.discord?.messageActions ?? null;
  } catch {
    return null;
  }
}

const discordMessageActions = {
  describeMessageTool: (
    ctx: Parameters<NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>>[0],
  ): ChannelMessageToolDiscovery | null =>
    resolveRuntimeDiscordMessageActions()?.describeMessageTool?.(ctx) ??
    discordMessageActionsImpl.describeMessageTool?.(ctx) ??
    null,
  extractToolSend: (
    ctx: Parameters<NonNullable<ChannelMessageActionAdapter["extractToolSend"]>>[0],
  ) =>
    resolveRuntimeDiscordMessageActions()?.extractToolSend?.(ctx) ??
    discordMessageActionsImpl.extractToolSend?.(ctx) ??
    null,
  handleAction: async (
    ctx: Parameters<NonNullable<ChannelMessageActionAdapter["handleAction"]>>[0],
  ) => {
    const runtimeHandleAction = resolveRuntimeDiscordMessageActions()?.handleAction;
    if (runtimeHandleAction) {
      return await runtimeHandleAction(ctx);
    }
    if (!discordMessageActionsImpl.handleAction) {
      throw new Error("Discord message actions not available");
    }
    return await discordMessageActionsImpl.handleAction(ctx);
  },
};

function resolveDiscordStartupDelayMs(cfg: OpenClawConfig, accountId: string): number {
  const startupAccountIds = listDiscordAccountIds(cfg).filter((candidateId) => {
    const candidate = resolveDiscordAccount({ cfg, accountId: candidateId });
    return (
      candidate.enabled &&
      (resolveConfiguredFromCredentialStatuses(candidate) ??
        Boolean(normalizeOptionalString(candidate.token)))
    );
  });
  const startupIndex = startupAccountIds.findIndex((candidateId) => candidateId === accountId);
  return startupIndex <= 0 ? 0 : startupIndex * DISCORD_ACCOUNT_STARTUP_STAGGER_MS;
}

function formatDiscordIntents(intents?: {
  messageContent?: string;
  guildMembers?: string;
  presence?: string;
}) {
  if (!intents) {
    return "unknown";
  }
  return [
    `messageContent=${intents.messageContent ?? "unknown"}`,
    `guildMembers=${intents.guildMembers ?? "unknown"}`,
    `presence=${intents.presence ?? "unknown"}`,
  ].join(" ");
}

function buildDiscordCrossContextPresentation(params: { originLabel: string; message: string }) {
  const trimmed = params.message.trim();
  return {
    tone: "neutral" as const,
    blocks: [
      ...(trimmed
        ? ([{ type: "text" as const, text: params.message }, { type: "divider" as const }] as const)
        : []),
      { type: "context" as const, text: `From ${params.originLabel}` },
    ],
  };
}

const resolveDiscordAllowlistGroupOverrides = createNestedAllowlistOverrideResolver({
  resolveRecord: (account: ResolvedDiscordAccount) => account.config.guilds,
  outerLabel: (guildKey) => `guild ${guildKey}`,
  resolveOuterEntries: (guildCfg) => guildCfg?.users,
  resolveChildren: (guildCfg) => guildCfg?.channels,
  innerLabel: (guildKey, channelKey) => `guild ${guildKey} / channel ${channelKey}`,
  resolveInnerEntries: (channelCfg) => channelCfg?.users,
});

const resolveDiscordAllowlistNames = createAccountScopedAllowlistNameResolver({
  resolveAccount: resolveDiscordAccount,
  resolveToken: (account: ResolvedDiscordAccount) => account.token,
  resolveNames: async ({ token, entries }) =>
    (await loadDiscordResolveUsersModule()).resolveDiscordUserAllowlist({ token, entries }),
});

function normalizeDiscordAcpConversationId(conversationId: string) {
  const normalized = conversationId.trim();
  return normalized ? { conversationId: normalized } : null;
}

function matchDiscordAcpConversation(params: {
  bindingConversationId: string;
  conversationId: string;
  parentConversationId?: string;
}) {
  if (params.bindingConversationId === params.conversationId) {
    return { conversationId: params.conversationId, matchPriority: 2 };
  }
  if (
    params.parentConversationId &&
    params.parentConversationId !== params.conversationId &&
    params.bindingConversationId === params.parentConversationId
  ) {
    return {
      conversationId: params.parentConversationId,
      matchPriority: 1,
    };
  }
  return null;
}

function resolveDiscordConversationIdFromTargets(
  targets: Array<string | undefined>,
): string | undefined {
  for (const raw of targets) {
    const trimmed = raw?.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const target = parseDiscordTarget(trimmed, { defaultKind: "channel" });
      if (target?.normalized) {
        return target.normalized;
      }
    } catch {
      const mentionMatch = trimmed.match(/^<#(\d+)>$/);
      if (mentionMatch?.[1]) {
        return `channel:${mentionMatch[1]}`;
      }
      if (/^\d{6,}$/.test(trimmed)) {
        return normalizeDiscordMessagingTarget(trimmed);
      }
    }
  }
  return undefined;
}

function parseDiscordParentChannelFromSessionKey(raw: unknown): string | undefined {
  const sessionKey = normalizeLowercaseStringOrEmpty(raw);
  if (!sessionKey) {
    return undefined;
  }
  const match = sessionKey.match(/(?:^|:)channel:([^:]+)$/);
  return match?.[1] ? `channel:${match[1]}` : undefined;
}

function resolveDiscordCommandConversation(params: {
  threadId?: string;
  threadParentId?: string;
  parentSessionKey?: string;
  from?: string;
  chatType?: string;
  originatingTo?: string;
  commandTo?: string;
  fallbackTo?: string;
}) {
  const targets = [params.originatingTo, params.commandTo, params.fallbackTo];
  if (params.threadId) {
    const parentConversationId =
      normalizeDiscordMessagingTarget(normalizeOptionalString(params.threadParentId) ?? "") ||
      parseDiscordParentChannelFromSessionKey(params.parentSessionKey) ||
      resolveDiscordConversationIdFromTargets(targets);
    return {
      conversationId: params.threadId,
      ...(parentConversationId && parentConversationId !== params.threadId
        ? { parentConversationId }
        : {}),
    };
  }
  const conversationId = resolveDiscordCurrentConversationIdentity({
    from: params.from,
    chatType: params.chatType,
    originatingTo: params.originatingTo,
    commandTo: params.commandTo,
    fallbackTo: params.fallbackTo,
  });
  return conversationId ? { conversationId } : null;
}

function resolveDiscordInboundConversation(params: {
  from?: string;
  to?: string;
  conversationId?: string;
  isGroup: boolean;
}) {
  const conversationId = resolveDiscordCurrentConversationIdentity({
    from: params.from,
    chatType: params.isGroup ? "group" : "direct",
    originatingTo: params.to,
    fallbackTo: params.conversationId,
  });
  return conversationId ? { conversationId } : null;
}

function toConversationLifecycleBinding(binding: {
  boundAt: number;
  lastActivityAt?: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
}) {
  return {
    boundAt: binding.boundAt,
    lastActivityAt:
      typeof binding.lastActivityAt === "number" ? binding.lastActivityAt : binding.boundAt,
    idleTimeoutMs: typeof binding.idleTimeoutMs === "number" ? binding.idleTimeoutMs : undefined,
    maxAgeMs: typeof binding.maxAgeMs === "number" ? binding.maxAgeMs : undefined,
  };
}

function parseDiscordExplicitTarget(raw: string) {
  try {
    const target = parseDiscordTarget(raw, { defaultKind: "channel" });
    if (!target) {
      return null;
    }
    return {
      to: target.normalized,
      chatType: target.kind === "user" ? ("direct" as const) : ("channel" as const),
    };
  } catch {
    return null;
  }
}

export const discordPlugin: ChannelPlugin<ResolvedDiscordAccount, DiscordProbe> =
  createChatChannelPlugin<ResolvedDiscordAccount, DiscordProbe>({
    base: {
      ...createDiscordPluginBase({
        setup: discordSetupAdapter,
      }),
      allowlist: {
        ...buildLegacyDmAccountAllowlistAdapter({
          channelId: "discord",
          resolveAccount: resolveDiscordAccount,
          normalize: ({ cfg, accountId, values }) =>
            discordConfigAdapter.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
          resolveDmAllowFrom: (account) => account.config.allowFrom ?? account.config.dm?.allowFrom,
          resolveGroupPolicy: (account) => account.config.groupPolicy,
          resolveGroupOverrides: resolveDiscordAllowlistGroupOverrides,
        }),
        resolveNames: resolveDiscordAllowlistNames,
      },
      groups: {
        resolveRequireMention: resolveDiscordGroupRequireMention,
        resolveToolPolicy: resolveDiscordGroupToolPolicy,
      },
      mentions: {
        stripPatterns: () => ["<@!?\\d+>"],
      },
      agentPrompt: {
        messageToolHints: () => [
          "- Discord components: set `components` when sending messages to include buttons, selects, or v2 containers.",
          "- Forms: add `components.modal` (title, fields). OpenClaw adds a trigger button and routes submissions as new messages.",
        ],
      },
      messaging: {
        normalizeTarget: normalizeDiscordMessagingTarget,
        resolveInboundConversation: ({ from, to, conversationId, isGroup }) =>
          resolveDiscordInboundConversation({ from, to, conversationId, isGroup }),
        normalizeExplicitSessionKey: ({ sessionKey, ctx }) =>
          normalizeExplicitDiscordSessionKey(sessionKey, ctx),
        resolveSessionTarget: ({ id }) => normalizeDiscordMessagingTarget(`channel:${id}`),
        parseExplicitTarget: ({ raw }) => parseDiscordExplicitTarget(raw),
        inferTargetChatType: ({ to }) => parseDiscordExplicitTarget(to)?.chatType,
        buildCrossContextPresentation: buildDiscordCrossContextPresentation,
        resolveOutboundSessionRoute: (params) => resolveDiscordOutboundSessionRoute(params),
        targetResolver: {
          looksLikeId: looksLikeDiscordTargetId,
          hint: "<channelId|user:ID|channel:ID>",
        },
      },
      approvalCapability: getDiscordApprovalCapability(),
      directory: createChannelDirectoryAdapter({
        listPeers: async (params) =>
          (await loadDiscordDirectoryConfigModule()).listDiscordDirectoryPeersFromConfig(params),
        listGroups: async (params) =>
          (await loadDiscordDirectoryConfigModule()).listDiscordDirectoryGroupsFromConfig(params),
        ...createRuntimeDirectoryLiveAdapter({
          getRuntime: loadDiscordDirectoryLiveModule,
          listPeersLive: (runtime) => runtime.listDiscordDirectoryPeersLive,
          listGroupsLive: (runtime) => runtime.listDiscordDirectoryGroupsLive,
        }),
      }),
      resolver: {
        resolveTargets: async ({ cfg, accountId, inputs, kind }) => {
          const account = resolveDiscordAccount({ cfg, accountId });
          if (kind === "group") {
            return resolveTargetsWithOptionalToken({
              token: account.token,
              inputs,
              missingTokenNote: "missing Discord token",
              resolveWithToken: async ({ token, inputs }) =>
                (await loadDiscordResolveChannelsModule()).resolveDiscordChannelAllowlist({
                  token,
                  entries: inputs,
                }),
              mapResolved: (entry) => ({
                input: entry.input,
                resolved: entry.resolved,
                id: entry.channelId ?? entry.guildId,
                name:
                  entry.channelName ??
                  entry.guildName ??
                  (entry.guildId && !entry.channelId ? entry.guildId : undefined),
                note: entry.note,
              }),
            });
          }
          return resolveTargetsWithOptionalToken({
            token: account.token,
            inputs,
            missingTokenNote: "missing Discord token",
            resolveWithToken: async ({ token, inputs }) =>
              (await loadDiscordResolveUsersModule()).resolveDiscordUserAllowlist({
                token,
                entries: inputs,
              }),
            mapResolved: (entry) => ({
              input: entry.input,
              resolved: entry.resolved,
              id: entry.id,
              name: entry.name,
              note: entry.note,
            }),
          });
        },
      },
      actions: discordMessageActions,
      bindings: {
        compileConfiguredBinding: ({ conversationId }) =>
          normalizeDiscordAcpConversationId(conversationId),
        matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) =>
          matchDiscordAcpConversation({
            bindingConversationId: compiledBinding.conversationId,
            conversationId,
            parentConversationId,
          }),
        resolveCommandConversation: ({
          threadId,
          threadParentId,
          parentSessionKey,
          from,
          chatType,
          originatingTo,
          commandTo,
          fallbackTo,
        }) =>
          resolveDiscordCommandConversation({
            threadId,
            threadParentId,
            parentSessionKey,
            from,
            chatType,
            originatingTo,
            commandTo,
            fallbackTo,
          }),
      },
      conversationBindings: {
        supportsCurrentConversationBinding: true,
        defaultTopLevelPlacement: "child",
        createManager: async ({ cfg, accountId }) =>
          (await loadDiscordThreadBindingsManagerModule()).createThreadBindingManager({
            cfg,
            accountId: accountId ?? undefined,
            persist: false,
            enableSweeper: false,
          }),
        setIdleTimeoutBySessionKey: ({ targetSessionKey, accountId, idleTimeoutMs }) =>
          setThreadBindingIdleTimeoutBySessionKey({
            targetSessionKey,
            accountId: accountId ?? undefined,
            idleTimeoutMs,
          }).map(toConversationLifecycleBinding),
        setMaxAgeBySessionKey: ({ targetSessionKey, accountId, maxAgeMs }) =>
          setThreadBindingMaxAgeBySessionKey({
            targetSessionKey,
            accountId: accountId ?? undefined,
            maxAgeMs,
          }).map(toConversationLifecycleBinding),
      },
      heartbeat: {
        sendTyping: async ({ cfg, to, accountId, threadId }) => {
          const resolvedTo = resolveDiscordAttachedOutboundTarget({ to, threadId });
          const target = parseDiscordTarget(resolvedTo, { defaultKind: "channel" });
          if (!target || target.kind !== "channel") {
            return;
          }
          await (
            await loadDiscordSendModule()
          ).sendTypingDiscord(target.id, {
            cfg,
            accountId: accountId ?? undefined,
          });
        },
      },
      status: createComputedAccountStatusAdapter<ResolvedDiscordAccount, DiscordProbe>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, {
          connected: false,
          reconnectAttempts: 0,
          lastConnectedAt: null,
          lastDisconnect: null,
          lastEventAt: null,
        }),
        collectStatusIssues: collectDiscordStatusIssues,
        buildChannelSummary: ({ snapshot }) =>
          buildTokenChannelStatusSummary(snapshot, { includeMode: false }),
        probeAccount: async ({ account, timeoutMs }) =>
          (await loadDiscordProbeRuntime()).probeDiscord(account.token, timeoutMs, {
            includeApplication: true,
          }),
        formatCapabilitiesProbe: ({ probe }) => {
          const discordProbe = probe as DiscordProbe | undefined;
          const lines = [];
          if (discordProbe?.bot?.username) {
            const botId = discordProbe.bot.id ? ` (${discordProbe.bot.id})` : "";
            lines.push({ text: `Bot: @${discordProbe.bot.username}${botId}` });
          }
          if (discordProbe?.application?.intents) {
            lines.push({
              text: `Intents: ${formatDiscordIntents(discordProbe.application.intents)}`,
            });
          }
          return lines;
        },
        buildCapabilitiesDiagnostics: async ({ account, target }) => {
          if (!target?.trim()) {
            return undefined;
          }
          const parsedTarget = parseDiscordTarget(target.trim(), { defaultKind: "channel" });
          const details: Record<string, unknown> = {
            target: {
              raw: target,
              normalized: parsedTarget?.normalized,
              kind: parsedTarget?.kind,
              channelId: parsedTarget?.kind === "channel" ? parsedTarget.id : undefined,
            },
          };
          if (!parsedTarget || parsedTarget.kind !== "channel") {
            return {
              details,
              lines: [
                {
                  text: "Permissions: Target looks like a DM user; pass channel:<id> to audit channel permissions.",
                  tone: "error",
                },
              ],
            };
          }
          const token = account.token?.trim();
          if (!token) {
            return {
              details,
              lines: [
                {
                  text: "Permissions: Discord bot token missing for permission audit.",
                  tone: "error",
                },
              ],
            };
          }
          const statusCfg: OpenClawConfig = {
            channels: {
              discord: {
                accounts: {
                  [account.accountId]: {
                    ...account.config,
                    token,
                  },
                },
              },
            },
          };
          try {
            const perms = await (
              await loadDiscordSendModule()
            ).fetchChannelPermissionsDiscord(parsedTarget.id, {
              cfg: statusCfg,
              token,
              accountId: account.accountId ?? undefined,
            });
            const missingRequired = REQUIRED_DISCORD_PERMISSIONS.filter(
              (permission) => !perms.permissions.includes(permission),
            );
            details.permissions = {
              channelId: perms.channelId,
              guildId: perms.guildId,
              isDm: perms.isDm,
              channelType: perms.channelType,
              permissions: perms.permissions,
              missingRequired,
              raw: perms.raw,
            };
            return {
              details,
              lines: [
                {
                  text: `Permissions (${perms.channelId}): ${perms.permissions.length ? perms.permissions.join(", ") : "none"}`,
                },
                missingRequired.length > 0
                  ? { text: `Missing required: ${missingRequired.join(", ")}`, tone: "warn" }
                  : { text: "Missing required: none", tone: "success" },
              ],
            };
          } catch (err) {
            const message = formatErrorMessage(err);
            details.permissions = { channelId: parsedTarget.id, error: message };
            return {
              details,
              lines: [{ text: `Permissions: ${message}`, tone: "error" }],
            };
          }
        },
        auditAccount: async ({ account, timeoutMs, cfg }) => {
          const { auditDiscordChannelPermissions, collectDiscordAuditChannelIds } =
            await loadDiscordAuditModule();
          const { channelIds, unresolvedChannels } = collectDiscordAuditChannelIds({
            cfg,
            accountId: account.accountId,
          });
          if (!channelIds.length && unresolvedChannels === 0) {
            return undefined;
          }
          const botToken = account.token?.trim();
          if (!botToken) {
            return {
              ok: unresolvedChannels === 0,
              checkedChannels: 0,
              unresolvedChannels,
              channels: [],
              elapsedMs: 0,
            };
          }
          const audit = await auditDiscordChannelPermissions({
            cfg,
            token: botToken,
            accountId: account.accountId,
            channelIds,
            timeoutMs,
          });
          return { ...audit, unresolvedChannels };
        },
        resolveAccountSnapshot: ({ account, runtime, probe, audit }) => {
          const configured =
            resolveConfiguredFromCredentialStatuses(account) ?? Boolean(account.token?.trim());
          const app = runtime?.application ?? (probe as { application?: unknown })?.application;
          const bot = runtime?.bot ?? (probe as { bot?: unknown })?.bot;
          return {
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured,
            extra: {
              ...projectCredentialSnapshotFields(account),
              connected: runtime?.connected ?? false,
              reconnectAttempts: runtime?.reconnectAttempts,
              lastConnectedAt: runtime?.lastConnectedAt ?? null,
              lastDisconnect: runtime?.lastDisconnect ?? null,
              lastEventAt: runtime?.lastEventAt ?? null,
              application: app ?? undefined,
              bot: bot ?? undefined,
              audit,
            },
          };
        },
      }),
      gateway: {
        startAccount: async (ctx) => {
          const account = ctx.account;
          const startupDelayMs = resolveDiscordStartupDelayMs(ctx.cfg, account.accountId);
          if (startupDelayMs > 0) {
            ctx.log?.info(
              `[${account.accountId}] delaying provider startup ${Math.round(startupDelayMs / 1000)}s to reduce Discord startup rate limits`,
            );
            try {
              await sleepWithAbort(startupDelayMs, ctx.abortSignal);
            } catch {
              return;
            }
          }
          const token = account.token.trim();
          let discordBotLabel = "";
          try {
            const probe = await (
              await loadDiscordProbeRuntime()
            ).probeDiscord(token, 2500, {
              includeApplication: true,
            });
            const username = probe.ok ? probe.bot?.username?.trim() : null;
            if (username) {
              discordBotLabel = ` (@${username})`;
            }
            ctx.setStatus({
              accountId: account.accountId,
              bot: probe.bot,
              application: probe.application,
            });
            const messageContent = probe.application?.intents?.messageContent;
            if (messageContent === "disabled") {
              ctx.log?.warn(
                `[${account.accountId}] Discord Message Content Intent is disabled; bot may not respond to channel messages. Enable it in Discord Dev Portal (Bot → Privileged Gateway Intents) or require mentions.`,
              );
            } else if (messageContent === "limited") {
              ctx.log?.info(
                `[${account.accountId}] Discord Message Content Intent is limited; bots under 100 servers can use it without verification.`,
              );
            }
          } catch (err) {
            if (getDiscordRuntime().logging.shouldLogVerbose()) {
              ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
            }
          }
          ctx.log?.info(`[${account.accountId}] starting provider${discordBotLabel}`);
          return (await loadDiscordProviderRuntime()).monitorDiscordProvider({
            token,
            accountId: account.accountId,
            config: ctx.cfg,
            runtime: ctx.runtime,
            channelRuntime: ctx.channelRuntime,
            abortSignal: ctx.abortSignal,
            mediaMaxMb: account.config.mediaMaxMb,
            historyLimit: account.config.historyLimit,
            setStatus: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
          });
        },
      },
    },
    pairing: {
      text: {
        idLabel: "discordUserId",
        message: PAIRING_APPROVED_MESSAGE,
        normalizeAllowEntry: createPairingPrefixStripper(/^(discord|user):/i),
        notify: async ({ cfg, id, message, accountId }) => {
          await (
            await loadDiscordSendModule()
          ).sendMessageDiscord(`user:${id}`, message, {
            cfg,
            ...(accountId ? { accountId } : {}),
          });
        },
      },
    },
    security: discordSecurityAdapter,
    threading: {
      scopedAccountReplyToMode: {
        resolveAccount: (cfg, accountId) => resolveDiscordAccount({ cfg, accountId }),
        resolveReplyToMode: (account) => account.config.replyToMode,
        fallback: "off",
      },
    },
    outbound: {
      ...discordOutbound,
      preferFinalAssistantVisibleText: true,
      shouldTreatDeliveredTextAsVisible: shouldTreatDiscordDeliveredTextAsVisible,
      shouldSuppressLocalPayloadPrompt: ({ cfg, accountId, payload, hint }) =>
        shouldSuppressLocalDiscordExecApprovalPrompt({
          cfg,
          accountId,
          payload,
          hint,
        }),
    },
  });
