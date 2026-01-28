/**
 * Webex channel plugin implementation
 *
 * Implements the ChannelPlugin interface for Webex integration.
 */

import {
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  setAccountEnabledInConfigSection,
  type ChannelMeta,
  type ChannelPlugin,
  type MoltbotConfig,
} from "clawdbot/plugin-sdk";
import {
  describeWebexAccount,
  isWebexAccountConfigured,
  listWebexAccountIds,
  resolveDefaultWebexAccountId,
  resolveWebexAccount,
} from "./accounts.js";
import { sendWebexMessage } from "./api.js";
import { startWebexMonitor } from "./monitor.js";
import { webexOnboardingAdapter } from "./onboarding.js";
import { probeWebexAuth, probeWebexConnection } from "./probe.js";
import { getWebexRuntime } from "./runtime.js";
import {
  formatAllowFromEntry,
  getWebexTargetHints,
  isWebexId,
  normalizeAllowFromEntry,
  normalizeWebexTarget,
  resolveWebexOutboundTarget,
} from "./targets.js";
import type { ResolvedWebexAccount } from "./types.js";

/**
 * Webex channel metadata
 * Plugin-based channels must define their own meta object
 */
const meta: ChannelMeta = {
  id: "webex",
  label: "Webex",
  selectionLabel: "Webex (Bot Framework)",
  docsPath: "/channels/webex",
  blurb: "Cisco Webex bot integration via webhooks",
  order: 65,
  aliases: ["cisco-webex", "spark"],
};

/**
 * Webex channel plugin
 */
export const webexPlugin: ChannelPlugin<ResolvedWebexAccount> = {
  id: "webex",

  meta: { ...meta },

  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    reactions: false, // Webex API has limited reaction support
    media: true,
    threads: true, // Via parentId
    nativeCommands: false,
    blockStreaming: true,
  },

  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },

  reload: { configPrefixes: ["channels.webex"] },

  onboarding: webexOnboardingAdapter,

  pairing: {
    idLabel: "webexUserId",
    normalizeAllowEntry: normalizeAllowFromEntry,
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveWebexAccount({ cfg: cfg as MoltbotConfig });
      if (!account.botToken) return;

      const target = await resolveWebexOutboundTarget({ account, target: id });
      await sendWebexMessage(account, {
        ...target,
        markdown: "Your pairing request has been approved. You can now send messages.",
      });
    },
  },

  config: {
    listAccountIds: (cfg) => listWebexAccountIds(cfg as MoltbotConfig),
    resolveAccount: (cfg, accountId) =>
      resolveWebexAccount({ cfg: cfg as MoltbotConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultWebexAccountId(cfg as MoltbotConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as MoltbotConfig,
        sectionKey: "webex",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as MoltbotConfig,
        sectionKey: "webex",
        accountId,
        clearBaseFields: [
          "botToken",
          "webhookSecret",
          "webhookPath",
          "webhookUrl",
          "botId",
          "botEmail",
          "name",
        ],
      }),
    isConfigured: (account) => isWebexAccountConfigured(account),
    describeAccount: (account) => describeWebexAccount(account),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveWebexAccount({
        cfg: cfg as MoltbotConfig,
        accountId,
      }).config.dm?.allowFrom ?? []
      ).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry))
        .filter(Boolean)
        .map(formatAllowFromEntry),
  },

  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(
        (cfg as MoltbotConfig).channels?.["webex"]?.accounts?.[resolvedAccountId],
      );
      const allowFromPath = useAccountPath
        ? `channels.webex.accounts.${resolvedAccountId}.dm.`
        : "channels.webex.dm.";
      return {
        policy: account.config.dm?.policy ?? "pairing",
        allowFrom: account.config.dm?.allowFrom ?? [],
        allowFromPath,
        approveHint: formatPairingApproveHint("webex"),
        normalizeEntry: formatAllowFromEntry,
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const warnings: string[] = [];
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy === "open") {
        warnings.push(
          `- Webex rooms: groupPolicy="open" allows any room to trigger (mention-gated). Set channels.webex.groupPolicy="allowlist" and configure channels.webex.rooms.`,
        );
      }
      if (account.config.dm?.policy === "open") {
        warnings.push(
          `- Webex DMs are open to anyone. Set channels.webex.dm.policy="pairing" or "allowlist".`,
        );
      }
      return warnings;
    },
  },

  threading: {
    resolveReplyToMode: ({ cfg }) =>
      (cfg as MoltbotConfig).channels?.["webex"]?.replyToMode ?? "off",
  },

  messaging: {
    normalizeTarget: normalizeWebexTarget,
    targetResolver: {
      looksLikeId: (raw, normalized) => {
        const value = normalized ?? raw.trim();
        return isWebexId(value);
      },
      hint: getWebexTargetHints(),
    },
  },

  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveWebexAccount({
        cfg: cfg as MoltbotConfig,
        accountId,
      });
      const q = query?.trim().toLowerCase() || "";
      const allowFrom = account.config.dm?.allowFrom ?? [];
      const peers = Array.from(
        new Set(
          allowFrom
            .map((entry) => String(entry).trim())
            .filter((entry) => Boolean(entry) && entry !== "*")
            .map((entry) => normalizeWebexTarget(entry) ?? entry),
        ),
      )
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }) as const);
      return peers;
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveWebexAccount({
        cfg: cfg as MoltbotConfig,
        accountId,
      });
      const rooms = account.config.rooms ?? {};
      const q = query?.trim().toLowerCase() || "";
      const entries = Object.keys(rooms)
        .filter((key) => key && key !== "*" && rooms[key]?.allow)
        .filter((key) => (q ? key.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group", id }) as const);
      return entries;
    },
  },

  resolver: {
    resolveTargets: async ({ inputs, kind }) => {
      const resolved = inputs.map((input) => {
        const normalized = normalizeWebexTarget(input);
        if (!normalized) {
          return { input, resolved: false, note: "empty target" };
        }
        if (isWebexId(normalized)) {
          return { input, resolved: true, id: normalized };
        }
        // Accept emails for users
        if (kind === "user" && normalized.includes("@")) {
          return { input, resolved: true, id: normalized };
        }
        return {
          input,
          resolved: false,
          note: "use Webex ID or email",
        };
      });
      return resolved;
    },
  },

  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) =>
      getWebexRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 7000, // Webex markdown limit
    resolveTarget: ({ to, allowFrom, mode }) => {
      const trimmed = to?.trim() ?? "";
      const allowListRaw = (allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean);
      const allowList = allowListRaw
        .filter((entry) => entry !== "*")
        .map((entry) => normalizeWebexTarget(entry))
        .filter((entry): entry is string => Boolean(entry));

      if (trimmed) {
        const normalized = normalizeWebexTarget(trimmed);
        if (!normalized) {
          if ((mode === "implicit" || mode === "heartbeat") && allowList.length > 0) {
            return { ok: true, to: allowList[0] };
          }
          return {
            ok: false,
            error: `Webex requires ${getWebexTargetHints()} or channels.webex.dm.allowFrom[0]`,
          };
        }
        return { ok: true, to: normalized };
      }

      if (allowList.length > 0) {
        return { ok: true, to: allowList[0] };
      }
      return {
        ok: false,
        error: `Webex requires ${getWebexTargetHints()} or channels.webex.dm.allowFrom[0]`,
      };
    },
    sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
      const account = resolveWebexAccount({
        cfg: cfg as MoltbotConfig,
        accountId,
      });
      const target = await resolveWebexOutboundTarget({ account, target: to });
      const parentId = (threadId ?? replyToId ?? undefined) as string | undefined;
      const result = await sendWebexMessage(account, {
        ...target,
        markdown: text,
        parentId,
      });
      return {
        channel: "webex",
        messageId: result?.id ?? "",
        chatId: target.roomId ?? target.toPersonId ?? target.toPersonEmail ?? "",
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId, threadId }) => {
      const account = resolveWebexAccount({
        cfg: cfg as MoltbotConfig,
        accountId,
      });
      const target = await resolveWebexOutboundTarget({ account, target: to });
      const parentId = (threadId ?? replyToId ?? undefined) as string | undefined;

      // Send file (Webex accepts URLs directly)
      const result = await sendWebexMessage(account, {
        ...target,
        markdown: text,
        files: mediaUrl ? [mediaUrl] : undefined,
        parentId,
      });

      return {
        channel: "webex",
        messageId: result?.id ?? "",
        chatId: target.roomId ?? target.toPersonId ?? target.toPersonEmail ?? "",
      };
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((entry) => {
        const accountId = String(entry.accountId ?? DEFAULT_ACCOUNT_ID);
        const enabled = entry.enabled !== false;
        const configured = entry.configured === true;
        if (!enabled || !configured) return [];
        const issues = [];
        if (!entry.webhookSecret) {
          issues.push({
            channel: "webex",
            accountId,
            kind: "config",
            message: "Webex webhook secret is missing (required for security).",
            fix: "Set channels.webex.webhookSecret.",
          });
        }
        return issues;
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      credentialSource: snapshot.credentialSource ?? "none",
      webhookPath: snapshot.webhookPath ?? null,
      webhookUrl: snapshot.webhookUrl ?? null,
      botId: snapshot.botId ?? null,
      botEmail: snapshot.botEmail ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account }) => probeWebexAuth(account),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.credentialSource !== "none",
      credentialSource: account.credentialSource,
      webhookPath: account.config.webhookPath,
      webhookUrl: account.config.webhookUrl,
      webhookSecret: account.config.webhookSecret ? "[set]" : undefined,
      botId: account.botId,
      botEmail: account.botEmail,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      dmPolicy: account.config.dm?.policy ?? "pairing",
      probe,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.log?.info(`[webex][${account.accountId}] starting Webex webhook monitor`);

      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
        webhookPath: account.config.webhookPath ?? "/webex",
      });

      // Probe connection first
      const probe = await probeWebexConnection(account);
      if (!probe.ok) {
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastError: probe.error,
        });
        throw new Error(`Webex probe failed: ${probe.error}`);
      }

      // Store bot info from probe
      if (probe.bot) {
        if (!account.botId && probe.bot.id) {
          account.botId = probe.bot.id;
        }
        if (!account.botEmail && probe.bot.email) {
          account.botEmail = probe.bot.email;
        }
      }

      const unregister = await startWebexMonitor({
        account,
        config: ctx.cfg as MoltbotConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        webhookPath: account.config.webhookPath,
        webhookUrl: account.config.webhookUrl,
        statusSink: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
      });

      return () => {
        unregister?.();
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
      };
    },
  },
};
