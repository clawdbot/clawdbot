import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import { createTopLevelChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import {
  createAllowlistProviderGroupPolicyWarningCollector,
  projectConfigWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { createRuntimeOutboundDelegates } from "openclaw/plugin-sdk/outbound-runtime";
import { createComputedAccountStatusAdapter } from "openclaw/plugin-sdk/status-helpers";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { msteamsActionsAdapter } from "./actions.js";
import { msTeamsApprovalAuth } from "./approval-auth.js";
import {
  buildProbeChannelStatusSummary,
  chunkTextForOutbound,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  type ChannelPlugin,
  type OpenClawConfig,
} from "./channel-api.js";
import { MSTeamsChannelConfigSchema } from "./config-schema.js";
import { msteamsDirectoryAdapter } from "./directory.js";
import { collectMSTeamsMutableAllowlistWarnings } from "./doctor.js";
import { formatUnknownError } from "./errors.js";
import { resolveMSTeamsGroupToolPolicy } from "./policy.js";
import type { ProbeMSTeamsResult } from "./probe.js";
import {
  looksLikeMSTeamsTargetId,
  normalizeMSTeamsMessagingTarget,
  normalizeMSTeamsUserInput,
  parseMSTeamsConversationId,
  parseMSTeamsTeamChannelInput,
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist,
} from "./resolve-allowlist.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { resolveMSTeamsOutboundSessionRoute } from "./session-route.js";
import { msteamsSetupAdapter } from "./setup-core.js";
import { msteamsSetupWizard } from "./setup-surface.js";
import { resolveMSTeamsCredentials } from "./token.js";

type ResolvedMSTeamsAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

const meta = {
  id: "msteams",
  label: "Microsoft Teams",
  selectionLabel: "Microsoft Teams (Bot Framework)",
  docsPath: "/channels/msteams",
  docsLabel: "msteams",
  blurb: "Teams SDK; enterprise support.",
  aliases: ["teams"],
  order: 60,
} as const;

const TEAMS_GRAPH_PERMISSION_HINTS: Record<string, string> = {
  "ChannelMessage.Read.All": "channel history",
  "Chat.Read.All": "chat history",
  "Channel.ReadBasic.All": "channel list",
  "Team.ReadBasic.All": "team list",
  "TeamsActivity.Read.All": "teams activity",
  "Sites.Read.All": "files (SharePoint)",
  "Files.Read.All": "files (OneDrive)",
};

const collectMSTeamsSecurityWarnings = createAllowlistProviderGroupPolicyWarningCollector<{
  cfg: OpenClawConfig;
}>({
  providerConfigPresent: (cfg) => cfg.channels?.msteams !== undefined,
  resolveGroupPolicy: ({ cfg }) => cfg.channels?.msteams?.groupPolicy,
  collect: ({ groupPolicy }) =>
    groupPolicy === "open"
      ? [
          '- MS Teams groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.msteams.groupPolicy="allowlist" + channels.msteams.groupAllowFrom to restrict senders.',
        ]
      : [],
});

const loadMSTeamsChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "msTeamsChannelRuntime",
);

const resolveMSTeamsChannelConfig = (cfg: OpenClawConfig) => ({
  allowFrom: cfg.channels?.msteams?.allowFrom,
  defaultTo: cfg.channels?.msteams?.defaultTo,
});

const msteamsConfigAdapter = createTopLevelChannelConfigAdapter<
  ResolvedMSTeamsAccount,
  {
    allowFrom?: Array<string | number>;
    defaultTo?: string;
  }
>({
  sectionKey: "msteams",
  resolveAccount: (cfg) => ({
    accountId: DEFAULT_ACCOUNT_ID,
    enabled: cfg.channels?.msteams?.enabled !== false,
    configured: Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)),
  }),
  resolveAccessorAccount: ({ cfg }) => resolveMSTeamsChannelConfig(cfg),
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account) => account.defaultTo,
});

export const msteamsPlugin: ChannelPlugin<ResolvedMSTeamsAccount, ProbeMSTeamsResult> =
  createChatChannelPlugin({
    base: {
      id: "msteams",
      meta: {
        ...meta,
        aliases: [...meta.aliases],
      },
      setupWizard: msteamsSetupWizard,
      capabilities: {
        chatTypes: ["direct", "channel", "thread"],
        polls: true,
        threads: true,
        media: true,
      },
      streaming: {
        blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
      },
      agentPrompt: {
        messageToolHints: () => [
          "- Adaptive Cards supported. Use `action=send` with `card={type,version,body}` to send rich cards.",
          "- MSTeams targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:ID` or `user:Display Name` (requires Graph API) for DMs, `conversation:19:...@thread.tacv2` for groups/channels. Prefer IDs over display names for speed.",
        ],
      },
      groups: {
        resolveToolPolicy: resolveMSTeamsGroupToolPolicy,
      },
      reload: { configPrefixes: ["channels.msteams"] },
      configSchema: MSTeamsChannelConfigSchema,
      config: {
        ...msteamsConfigAdapter,
        isConfigured: (_account, cfg) => Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)),
        describeAccount: (account) =>
          describeAccountSnapshot({
            account,
            configured: account.configured,
          }),
      },
      approvalCapability: msTeamsApprovalAuth,
      doctor: {
        dmAllowFromMode: "topOnly",
        groupModel: "hybrid",
        groupAllowFromFallbackToAllowFrom: false,
        warnOnEmptyGroupSenderAllowlist: true,
        collectMutableAllowlistWarnings: collectMSTeamsMutableAllowlistWarnings,
      },
      setup: msteamsSetupAdapter,
      secrets: {
        secretTargetRegistryEntries,
        collectRuntimeConfigAssignments,
      },
      messaging: {
        normalizeTarget: normalizeMSTeamsMessagingTarget,
        resolveOutboundSessionRoute: (params) => resolveMSTeamsOutboundSessionRoute(params),
        targetResolver: {
          looksLikeId: (raw) => looksLikeMSTeamsTargetId(raw),
          hint: "<conversationId|user:ID|conversation:ID>",
        },
      },
      directory: msteamsDirectoryAdapter,
      resolver: {
        resolveTargets: async ({ cfg, inputs, kind, runtime }) => {
          const results = inputs.map((input) => ({
            input,
            resolved: false,
            id: undefined as string | undefined,
            name: undefined as string | undefined,
            note: undefined as string | undefined,
          }));
          type ResolveTargetResultEntry = (typeof results)[number];
          type PendingTargetEntry = { input: string; query: string; index: number };

          const stripPrefix = (value: string) => normalizeMSTeamsUserInput(value);
          const markPendingLookupFailed = (pending: PendingTargetEntry[]) => {
            pending.forEach(({ index }) => {
              const entry = results[index];
              if (entry) {
                entry.note = "lookup failed";
              }
            });
          };
          const resolvePending = async <T>(
            pending: PendingTargetEntry[],
            resolveEntries: (entries: string[]) => Promise<T[]>,
            applyResolvedEntry: (target: ResolveTargetResultEntry, entry: T) => void,
          ) => {
            if (pending.length === 0) {
              return;
            }
            try {
              const resolved = await resolveEntries(pending.map((entry) => entry.query));
              resolved.forEach((entry, idx) => {
                const target = results[pending[idx]?.index ?? -1];
                if (!target) {
                  return;
                }
                applyResolvedEntry(target, entry);
              });
            } catch (err) {
              runtime.error?.(`msteams resolve failed: ${formatUnknownError(err)}`);
              markPendingLookupFailed(pending);
            }
          };

          if (kind === "user") {
            const pending: PendingTargetEntry[] = [];
            results.forEach((entry, index) => {
              const trimmed = entry.input.trim();
              if (!trimmed) {
                entry.note = "empty input";
                return;
              }
              const cleaned = stripPrefix(trimmed);
              if (/^[0-9a-fA-F-]{16,}$/.test(cleaned) || cleaned.includes("@")) {
                entry.resolved = true;
                entry.id = cleaned;
                return;
              }
              pending.push({ input: entry.input, query: cleaned, index });
            });

            await resolvePending(
              pending,
              (entries) => resolveMSTeamsUserAllowlist({ cfg, entries }),
              (target, entry) => {
                target.resolved = entry.resolved;
                target.id = entry.id;
                target.name = entry.name;
                target.note = entry.note;
              },
            );

            return results;
          }

          const pending: PendingTargetEntry[] = [];
          results.forEach((entry, index) => {
            const trimmed = entry.input.trim();
            if (!trimmed) {
              entry.note = "empty input";
              return;
            }
            const conversationId = parseMSTeamsConversationId(trimmed);
            if (conversationId !== null) {
              entry.resolved = Boolean(conversationId);
              entry.id = conversationId || undefined;
              entry.note = conversationId ? "conversation id" : "empty conversation id";
              return;
            }
            const parsed = parseMSTeamsTeamChannelInput(trimmed);
            if (!parsed.team) {
              entry.note = "missing team";
              return;
            }
            const query = parsed.channel ? `${parsed.team}/${parsed.channel}` : parsed.team;
            pending.push({ input: entry.input, query, index });
          });

          await resolvePending(
            pending,
            (entries) => resolveMSTeamsChannelAllowlist({ cfg, entries }),
            (target, entry) => {
              if (!entry.resolved || !entry.teamId) {
                target.resolved = false;
                target.note = entry.note;
                return;
              }
              target.resolved = true;
              if (entry.channelId) {
                target.id = `${entry.teamId}/${entry.channelId}`;
                target.name =
                  entry.channelName && entry.teamName
                    ? `${entry.teamName}/${entry.channelName}`
                    : (entry.channelName ?? entry.teamName);
              } else {
                target.id = entry.teamId;
                target.name = entry.teamName;
                target.note = "team id";
              }
              if (entry.note) {
                target.note = entry.note;
              }
            },
          );

          return results;
        },
      },
      actions: msteamsActionsAdapter,
      status: createComputedAccountStatusAdapter<ResolvedMSTeamsAccount, ProbeMSTeamsResult>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, { port: null }),
        buildChannelSummary: ({ snapshot }) =>
          buildProbeChannelStatusSummary(snapshot, {
            port: snapshot.port ?? null,
          }),
        probeAccount: async ({ cfg }) =>
          await (await loadMSTeamsChannelRuntime()).probeMSTeams(cfg.channels?.msteams),
        formatCapabilitiesProbe: ({ probe }) => {
          const teamsProbe = probe as ProbeMSTeamsResult | undefined;
          const lines: Array<{ text: string; tone?: "error" }> = [];
          const appId = normalizeOptionalString(teamsProbe?.appId) ?? "";
          if (appId) {
            lines.push({ text: `App: ${appId}` });
          }
          const graph = teamsProbe?.graph;
          if (graph) {
            const roles = Array.isArray(graph.roles)
              ? graph.roles.map((role) => role.trim()).filter(Boolean)
              : [];
            const scopes = Array.isArray(graph.scopes)
              ? graph.scopes.map((scope) => scope.trim()).filter(Boolean)
              : [];
            const formatPermission = (permission: string) => {
              const hint = TEAMS_GRAPH_PERMISSION_HINTS[permission];
              return hint ? `${permission} (${hint})` : permission;
            };
            if (!graph.ok) {
              lines.push({ text: `Graph: ${graph.error ?? "failed"}`, tone: "error" });
            } else if (roles.length > 0 || scopes.length > 0) {
              if (roles.length > 0) {
                lines.push({ text: `Graph roles: ${roles.map(formatPermission).join(", ")}` });
              }
              if (scopes.length > 0) {
                lines.push({ text: `Graph scopes: ${scopes.map(formatPermission).join(", ")}` });
              }
            } else if (graph.ok) {
              lines.push({ text: "Graph: ok" });
            }
          }
          return lines;
        },
        resolveAccountSnapshot: ({ account, runtime }) => ({
          accountId: account.accountId,
          enabled: account.enabled,
          configured: account.configured,
          extra: {
            port: runtime?.port ?? null,
          },
        }),
      }),
      gateway: {
        startAccount: async (ctx) => {
          const { monitorMSTeamsProvider } = await import("./index.js");
          const port = ctx.cfg.channels?.msteams?.webhook?.port ?? 3978;
          ctx.setStatus({ accountId: ctx.accountId, port });
          ctx.log?.info(`starting provider (port ${port})`);
          return monitorMSTeamsProvider({
            cfg: ctx.cfg,
            runtime: ctx.runtime,
            abortSignal: ctx.abortSignal,
          });
        },
      },
    },
    security: {
      collectWarnings: projectConfigWarningCollector<{ cfg: OpenClawConfig }>(
        collectMSTeamsSecurityWarnings,
      ),
    },
    pairing: {
      text: {
        idLabel: "msteamsUserId",
        message: PAIRING_APPROVED_MESSAGE,
        normalizeAllowEntry: createPairingPrefixStripper(/^(msteams|user):/i),
        notify: async ({ cfg, id, message }) => {
          const { sendMessageMSTeams } = await loadMSTeamsChannelRuntime();
          await sendMessageMSTeams({
            cfg,
            to: id,
            text: message,
          });
        },
      },
    },
    threading: {
      buildToolContext: ({ context, hasRepliedRef }) => {
        const nativeChannelId = context.NativeChannelId?.trim();
        const hasChannelRoute = Boolean(nativeChannelId && nativeChannelId.includes("/"));
        return {
          currentChannelId: normalizeOptionalString(context.To),
          currentGraphChannelId: hasChannelRoute ? nativeChannelId : undefined,
          currentThreadTs: context.ReplyToId,
          hasRepliedRef,
        };
      },
    },
    outbound: {
      deliveryMode: "direct",
      chunker: chunkTextForOutbound,
      chunkerMode: "markdown",
      textChunkLimit: 4000,
      pollMaxOptions: 12,
      ...createRuntimeOutboundDelegates({
        getRuntime: loadMSTeamsChannelRuntime,
        sendText: { resolve: (runtime) => runtime.msteamsOutbound.sendText },
        sendMedia: { resolve: (runtime) => runtime.msteamsOutbound.sendMedia },
        sendPoll: { resolve: (runtime) => runtime.msteamsOutbound.sendPoll },
      }),
    },
  });
