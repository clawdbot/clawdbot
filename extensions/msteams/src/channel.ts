import type { ChannelMessageActionName, ChannelPlugin, MoltbotConfig } from "clawdbot/plugin-sdk";
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  MSTeamsConfigSchema,
  PAIRING_APPROVED_MESSAGE,
} from "clawdbot/plugin-sdk";

import { msteamsOnboardingAdapter } from "./onboarding.js";
import { msteamsOutbound } from "./outbound.js";
import { probeMSTeams } from "./probe.js";
import { resolveMSTeamsGroupToolPolicy } from "./policy.js";
import {
  normalizeMSTeamsMessagingTarget,
  normalizeMSTeamsUserInput,
  parseMSTeamsConversationId,
  parseMSTeamsTeamChannelInput,
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist,
} from "./resolve-allowlist.js";
import { sendAdaptiveCardMSTeams, sendMessageMSTeams } from "./send.js";
import { resolveMSTeamsCredentials } from "./token.js";
import {
  listMSTeamsDirectoryGroupsLive,
  listMSTeamsDirectoryPeersLive,
} from "./directory-live.js";

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
  blurb: "Bot Framework; enterprise support.",
  aliases: ["teams"],
  order: 60,
} as const;

export const msteamsPlugin: ChannelPlugin<ResolvedMSTeamsAccount> = {
  id: "msteams",
  meta: {
    ...meta,
  },
  onboarding: msteamsOnboardingAdapter,
  pairing: {
    idLabel: "msteamsUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(msteams|user):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      await sendMessageMSTeams({
        cfg,
        to: id,
        text: PAIRING_APPROVED_MESSAGE,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    polls: true,
    threads: true,
    media: true,
  },
  agentPrompt: {
    messageToolHints: () => [
      "- Adaptive Cards supported. Use `action=send` with `card={type,version,body}` to send rich cards.",
      "- MSTeams targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:ID` or `user:Display Name` (requires Graph API) for DMs, `conversation:19:...@thread.tacv2` for groups/channels. Prefer IDs over display names for speed.",
    ],
  },
  threading: {
    buildToolContext: ({ context, hasRepliedRef }) => ({
      currentChannelId: context.To?.trim() || undefined,
      currentThreadTs: context.ReplyToId,
      hasRepliedRef,
    }),
  },
  groups: {
    resolveToolPolicy: resolveMSTeamsGroupToolPolicy,
  },
  reload: { configPrefixes: ["channels.msteams"] },
  configSchema: buildChannelConfigSchema(MSTeamsConfigSchema),
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg) => ({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: cfg.channels?.msteams?.enabled !== false,
      configured: Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)),
    }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, enabled }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        msteams: {
          ...cfg.channels?.msteams,
          enabled,
        },
      },
    }),
    deleteAccount: ({ cfg }) => {
      const next = { ...cfg } as MoltbotConfig;
      const nextChannels = { ...cfg.channels };
      delete nextChannels.msteams;
      if (Object.keys(nextChannels).length > 0) {
        next.channels = nextChannels;
      } else {
        delete next.channels;
      }
      return next;
    },
    isConfigured: (_account, cfg) => Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)),
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg }) => cfg.channels?.msteams?.allowFrom ?? [],
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    collectWarnings: ({ cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = cfg.channels?.msteams?.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") return [];
      return [
        `- MS Teams groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.msteams.groupPolicy="allowlist" + channels.msteams.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: ({ cfg }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        msteams: {
          ...cfg.channels?.msteams,
          enabled: true,
        },
      },
    }),
  },
  messaging: {
    normalizeTarget: normalizeMSTeamsMessagingTarget,
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) return false;
        if (/^conversation:/i.test(trimmed)) return true;
        if (/^user:/i.test(trimmed)) {
          // Only treat as ID if the value after user: looks like a UUID
          const id = trimmed.slice("user:".length).trim();
          return /^[0-9a-fA-F-]{16,}$/.test(id);
        }
        return trimmed.includes("@thread");
      },
      hint: "<conversationId|user:ID|conversation:ID>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, query, limit }) => {
      const q = query?.trim().toLowerCase() || "";
      const ids = new Set<string>();
      for (const entry of cfg.channels?.msteams?.allowFrom ?? []) {
        const trimmed = String(entry).trim();
        if (trimmed && trimmed !== "*") ids.add(trimmed);
      }
      for (const userId of Object.keys(cfg.channels?.msteams?.dms ?? {})) {
        const trimmed = userId.trim();
        if (trimmed) ids.add(trimmed);
      }
      return Array.from(ids)
        .map((raw) => raw.trim())
        .filter(Boolean)
        .map((raw) => normalizeMSTeamsMessagingTarget(raw) ?? raw)
        .map((raw) => {
          const lowered = raw.toLowerCase();
          if (lowered.startsWith("user:")) return raw;
          if (lowered.startsWith("conversation:")) return raw;
          return `user:${raw}`;
        })
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }) as const);
    },
    listGroups: async ({ cfg, query, limit }) => {
      const q = query?.trim().toLowerCase() || "";
      const ids = new Set<string>();
      for (const team of Object.values(cfg.channels?.msteams?.teams ?? {})) {
        for (const channelId of Object.keys(team.channels ?? {})) {
          const trimmed = channelId.trim();
          if (trimmed && trimmed !== "*") ids.add(trimmed);
        }
      }
      return Array.from(ids)
        .map((raw) => raw.trim())
        .filter(Boolean)
        .map((raw) => raw.replace(/^conversation:/i, "").trim())
        .map((id) => `conversation:${id}`)
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group", id }) as const);
    },
    listPeersLive: async ({ cfg, query, limit }) =>
      listMSTeamsDirectoryPeersLive({ cfg, query, limit }),
    listGroupsLive: async ({ cfg, query, limit }) =>
      listMSTeamsDirectoryGroupsLive({ cfg, query, limit }),
  },
  resolver: {
    resolveTargets: async ({ cfg, inputs, kind, runtime }) => {
      const results = inputs.map((input) => ({
        input,
        resolved: false,
        id: undefined as string | undefined,
        name: undefined as string | undefined,
        note: undefined as string | undefined,
      }));

      const stripPrefix = (value: string) =>
        normalizeMSTeamsUserInput(value);

      if (kind === "user") {
        const pending: Array<{ input: string; query: string; index: number }> = [];
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

        if (pending.length > 0) {
          try {
            const resolved = await resolveMSTeamsUserAllowlist({
              cfg,
              entries: pending.map((entry) => entry.query),
            });
            resolved.forEach((entry, idx) => {
              const target = results[pending[idx]?.index ?? -1];
              if (!target) return;
              target.resolved = entry.resolved;
              target.id = entry.id;
              target.name = entry.name;
              target.note = entry.note;
            });
          } catch (err) {
            runtime.error?.(`msteams resolve failed: ${String(err)}`);
            pending.forEach(({ index }) => {
              const entry = results[index];
              if (entry) entry.note = "lookup failed";
            });
          }
        }

        return results;
      }

      const pending: Array<{ input: string; query: string; index: number }> = [];
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

      if (pending.length > 0) {
        try {
          const resolved = await resolveMSTeamsChannelAllowlist({
            cfg,
            entries: pending.map((entry) => entry.query),
          });
          resolved.forEach((entry, idx) => {
            const target = results[pending[idx]?.index ?? -1];
            if (!target) return;
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
                  : entry.channelName ?? entry.teamName;
            } else {
              target.id = entry.teamId;
              target.name = entry.teamName;
              target.note = "team id";
            }
            if (entry.note) target.note = entry.note;
          });
        } catch (err) {
          runtime.error?.(`msteams resolve failed: ${String(err)}`);
          pending.forEach(({ index }) => {
            const entry = results[index];
            if (entry) entry.note = "lookup failed";
          });
        }
      }

      return results;
    },
  },
  actions: {
    listActions: ({ cfg }) => {
      const enabled =
        cfg.channels?.msteams?.enabled !== false &&
        Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams));
      if (!enabled) return [];
      return ["poll"] satisfies ChannelMessageActionName[];
    },
    supportsCards: ({ cfg }) => {
      return (
        cfg.channels?.msteams?.enabled !== false &&
        Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams))
      );
    },
    handleAction: async (ctx) => {
      // Handle send action with card parameter
      if (ctx.action === "send" && ctx.params.card) {
        const card = ctx.params.card as Record<string, unknown>;
        const to =
          typeof ctx.params.to === "string"
            ? ctx.params.to.trim()
            : typeof ctx.params.target === "string"
              ? ctx.params.target.trim()
              : "";
        if (!to) {
          return {
            isError: true,
            content: [{ type: "text", text: "Card send requires a target (to)." }],
          };
        }
        const result = await sendAdaptiveCardMSTeams({
          cfg: ctx.cfg,
          to,
          card,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                channel: "msteams",
                messageId: result.messageId,
                conversationId: result.conversationId,
              }),
            },
          ],
        };
      }
      // Return null to fall through to default handler
      return null as never;
    },
  },
  outbound: msteamsOutbound,
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      port: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      port: snapshot.port ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ cfg }) => await probeMSTeams(cfg.channels?.msteams),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      port: runtime?.port ?? null,
      probe,
    }),
  },
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
};
