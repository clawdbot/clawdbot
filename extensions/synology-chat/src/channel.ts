/**
 * Synology Chat Channel Plugin for OpenClaw.
 *
 * Implements the ChannelPlugin interface following the LINE pattern.
 */

import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import {
  createHybridChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-lifecycle";
import {
  composeWarningCollectors,
  createConditionalWarningCollector,
  projectAccountConfigWarningCollector,
  projectAccountWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import { createEmptyChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { listAccountIds, resolveAccount } from "./accounts.js";
import { synologyChatApprovalAuth } from "./approval-auth.js";
import { sendMessage, sendFileUrl } from "./client.js";
import { SynologyChatChannelConfigSchema } from "./config-schema.js";
import {
  collectSynologyGatewayRoutingWarnings,
  registerSynologyWebhookRoute,
  validateSynologyGatewayAccountStartup,
} from "./gateway-runtime.js";
import { collectSynologyChatSecurityAuditFindings } from "./security-audit.js";
import { synologyChatSetupAdapter, synologyChatSetupWizard } from "./setup-surface.js";
import type { ResolvedSynologyChatAccount } from "./types.js";

const CHANNEL_ID = "synology-chat";

function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const resolveSynologyChatDmPolicy = createScopedDmSecurityResolver<ResolvedSynologyChatAccount>({
  channelKey: CHANNEL_ID,
  resolvePolicy: (account) => account.dmPolicy,
  resolveAllowFrom: (account) => account.allowedUserIds,
  policyPathSuffix: "dmPolicy",
  defaultPolicy: "allowlist",
  approveHint: "openclaw pairing approve synology-chat <code>",
  normalizeEntry: (raw) => normalizeLowercaseStringOrEmpty(raw),
});

type SynologyChannelGatewayContext = {
  cfg: OpenClawConfig;
  accountId: string;
  abortSignal: AbortSignal;
  log?: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
};
type SynologyChannelOutboundContext = {
  cfg: OpenClawConfig;
  to: string;
  text?: string;
  mediaUrl?: string;
  accountId?: string | null;
};
type SynologyChannelSendTextContext = SynologyChannelOutboundContext & { text: string };
type _SynologyChannelSendMediaContext = SynologyChannelOutboundContext & { mediaUrl: string };
type SynologySecurityWarningContext = {
  cfg: OpenClawConfig;
  account: ResolvedSynologyChatAccount;
};

const synologyChatConfigAdapter = createHybridChannelConfigAdapter<ResolvedSynologyChatAccount>({
  sectionKey: CHANNEL_ID,
  listAccountIds,
  resolveAccount,
  defaultAccountId: () => DEFAULT_ACCOUNT_ID,
  clearBaseFields: [
    "token",
    "incomingUrl",
    "nasHost",
    "webhookPath",
    "dangerouslyAllowNameMatching",
    "dangerouslyAllowInheritedWebhookPath",
    "dmPolicy",
    "allowedUserIds",
    "rateLimitPerMinute",
    "botName",
    "allowInsecureSsl",
  ],
  resolveAllowFrom: (account) => account.allowedUserIds,
  formatAllowFrom: (allowFrom) =>
    allowFrom.map((entry) => normalizeLowercaseStringOrEmpty(String(entry))).filter(Boolean),
});

const collectSynologyChatSecurityWarnings =
  createConditionalWarningCollector<ResolvedSynologyChatAccount>(
    (account) =>
      !account.token &&
      "- Synology Chat: token is not configured. The webhook will reject all requests.",
    (account) =>
      !account.incomingUrl &&
      "- Synology Chat: incomingUrl is not configured. The bot cannot send replies.",
    (account) =>
      account.allowInsecureSsl &&
      "- Synology Chat: SSL verification is disabled (allowInsecureSsl=true). Only use this for local NAS with self-signed certificates.",
    (account) =>
      account.dangerouslyAllowNameMatching &&
      "- Synology Chat: dangerouslyAllowNameMatching=true re-enables mutable username/nickname recipient matching for replies. Prefer stable numeric user IDs.",
    (account) =>
      account.dangerouslyAllowInheritedWebhookPath &&
      account.webhookPathSource === "inherited-base" &&
      "- Synology Chat: dangerouslyAllowInheritedWebhookPath=true opts a named account into a shared inherited webhook path. Prefer an explicit per-account webhookPath.",
    (account) =>
      account.dmPolicy === "open" &&
      account.allowedUserIds.length === 0 &&
      '- Synology Chat: dmPolicy="open" with empty allowedUserIds blocks all senders. Add allowedUserIds=["*"] for public DMs or set explicit user IDs.',
    (account) =>
      account.dmPolicy === "open" &&
      account.allowedUserIds.includes("*") &&
      '- Synology Chat: dmPolicy="open" allows any user to message the bot. Consider "allowlist" for production use.',
    (account) =>
      account.dmPolicy === "allowlist" &&
      account.allowedUserIds.length === 0 &&
      '- Synology Chat: dmPolicy="allowlist" with empty allowedUserIds blocks all senders. Add users or set dmPolicy="open" with allowedUserIds=["*"].',
  );

type SynologyChatOutboundResult = {
  channel: typeof CHANNEL_ID;
  messageId: string;
  chatId: string;
};

type SynologyChatPlugin = Omit<
  ChannelPlugin<ResolvedSynologyChatAccount>,
  "pairing" | "security" | "messaging" | "directory" | "outbound" | "gateway" | "agentPrompt"
> & {
  pairing: {
    idLabel: string;
    normalizeAllowEntry?: (entry: string) => string;
    notifyApproval: (params: { cfg: OpenClawConfig; id: string }) => Promise<void>;
  };
  security: {
    resolveDmPolicy: (params: { cfg: OpenClawConfig; account: ResolvedSynologyChatAccount }) => {
      policy: string | null | undefined;
      allowFrom?: Array<string | number>;
      normalizeEntry?: (raw: string) => string;
    } | null;
    collectWarnings: (params: {
      cfg: OpenClawConfig;
      account: ResolvedSynologyChatAccount;
    }) => string[];
  };
  messaging: {
    normalizeTarget: (target: string) => string | undefined;
    targetResolver: {
      looksLikeId: (id: string) => boolean;
      hint: string;
    };
  };
  directory: {
    self?: NonNullable<ChannelPlugin<ResolvedSynologyChatAccount>["directory"]>["self"];
    listPeers?: NonNullable<ChannelPlugin<ResolvedSynologyChatAccount>["directory"]>["listPeers"];
    listGroups?: NonNullable<ChannelPlugin<ResolvedSynologyChatAccount>["directory"]>["listGroups"];
  };
  outbound: {
    deliveryMode: "gateway";
    textChunkLimit: number;
    sendText: (ctx: SynologyChannelSendTextContext) => Promise<SynologyChatOutboundResult>;
    sendMedia: (ctx: SynologyChannelOutboundContext) => Promise<SynologyChatOutboundResult>;
  };
  gateway: {
    startAccount: (ctx: SynologyChannelGatewayContext) => Promise<unknown>;
    stopAccount: (ctx: SynologyChannelGatewayContext) => Promise<void>;
  };
  agentPrompt: {
    messageToolHints: () => string[];
  };
};

const collectSynologyChatRoutingWarnings = projectAccountConfigWarningCollector<
  ResolvedSynologyChatAccount,
  OpenClawConfig,
  SynologySecurityWarningContext
>(
  (cfg) => cfg,
  ({ account, cfg }) => collectSynologyGatewayRoutingWarnings({ account, cfg }),
);

function resolveOutboundAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedSynologyChatAccount {
  return resolveAccount(cfg ?? {}, accountId);
}

function requireIncomingUrl(account: ResolvedSynologyChatAccount): string {
  if (!account.incomingUrl) {
    throw new Error("Synology Chat incoming URL not configured");
  }
  return account.incomingUrl;
}

export function createSynologyChatPlugin(): SynologyChatPlugin {
  return createChatChannelPlugin({
    base: {
      id: CHANNEL_ID,
      meta: {
        id: CHANNEL_ID,
        label: "Synology Chat",
        selectionLabel: "Synology Chat (Webhook)",
        detailLabel: "Synology Chat (Webhook)",
        docsPath: "/channels/synology-chat",
        blurb: "Connect your Synology NAS Chat to OpenClaw",
        order: 90,
      },
      capabilities: {
        chatTypes: ["direct" as const],
        media: true,
        threads: false,
        reactions: false,
        edit: false,
        unsend: false,
        reply: false,
        effects: false,
        blockStreaming: false,
      },
      reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
      configSchema: SynologyChatChannelConfigSchema,
      setup: synologyChatSetupAdapter,
      setupWizard: synologyChatSetupWizard,
      config: {
        ...synologyChatConfigAdapter,
      },
      approvalCapability: synologyChatApprovalAuth,
      messaging: {
        normalizeTarget: (target: string) => {
          const trimmed = target.trim();
          if (!trimmed) {
            return undefined;
          }
          // Strip common prefixes
          return trimmed.replace(/^synology[-_]?chat:/i, "").trim();
        },
        targetResolver: {
          looksLikeId: (id: string) => {
            const trimmed = id?.trim();
            if (!trimmed) {
              return false;
            }
            // Synology Chat user IDs are numeric
            return /^\d+$/.test(trimmed) || /^synology[-_]?chat:/i.test(trimmed);
          },
          hint: "<userId>",
        },
      },
      directory: createEmptyChannelDirectoryAdapter(),
      gateway: {
        startAccount: async (ctx: SynologyChannelGatewayContext) => {
          const { cfg, accountId, log, abortSignal } = ctx;
          const account = resolveAccount(cfg, accountId);
          if (!validateSynologyGatewayAccountStartup({ cfg, account, accountId, log }).ok) {
            return waitUntilAbort(abortSignal);
          }

          log?.info?.(
            `Starting Synology Chat channel (account: ${accountId}, path: ${account.webhookPath})`,
          );
          const unregister = registerSynologyWebhookRoute({ account, accountId, log });

          log?.info?.(`Registered HTTP route: ${account.webhookPath} for Synology Chat`);

          // Keep alive until abort signal fires.
          // The gateway expects a Promise that stays pending while the channel is running.
          // Resolving immediately triggers a restart loop.
          return waitUntilAbort(abortSignal, () => {
            log?.info?.(`Stopping Synology Chat channel (account: ${accountId})`);
            unregister();
          });
        },

        stopAccount: async (ctx: SynologyChannelGatewayContext) => {
          ctx.log?.info?.(`Synology Chat account ${ctx.accountId} stopped`);
        },
      },
      agentPrompt: {
        messageToolHints: () => [
          "",
          "### Synology Chat Formatting",
          "Synology Chat supports limited formatting. Use these patterns:",
          "",
          "**Links**: Use `<URL|display text>` to create clickable links.",
          "  Example: `<https://example.com|Click here>` renders as a clickable link.",
          "",
          "**File sharing**: Include a publicly accessible URL to share files or images.",
          "  The NAS will download and attach the file (max 32 MB).",
          "",
          "**Limitations**:",
          "- No markdown, bold, italic, or code blocks",
          "- No buttons, cards, or interactive elements",
          "- No message editing after send",
          "- Keep messages under 2000 characters for best readability",
          "",
          "**Best practices**:",
          "- Use short, clear responses (Synology Chat has a minimal UI)",
          "- Use line breaks to separate sections",
          "- Use numbered or bulleted lists for clarity",
          "- Wrap URLs with `<URL|label>` for user-friendly links",
        ],
      },
    },
    pairing: {
      text: {
        idLabel: "synologyChatUserId",
        message: "OpenClaw: your access has been approved.",
        normalizeAllowEntry: (entry: string) => normalizeLowercaseStringOrEmpty(entry),
        notify: async ({ cfg, id, message }) => {
          const account = resolveAccount(cfg);
          if (!account.incomingUrl) {
            return;
          }
          await sendMessage(account.incomingUrl, message, id, account.allowInsecureSsl);
        },
      },
    },
    security: {
      resolveDmPolicy: resolveSynologyChatDmPolicy,
      collectWarnings: composeWarningCollectors(
        projectAccountWarningCollector<ResolvedSynologyChatAccount, SynologySecurityWarningContext>(
          collectSynologyChatSecurityWarnings,
        ),
        collectSynologyChatRoutingWarnings,
      ),
      collectAuditFindings: collectSynologyChatSecurityAuditFindings,
    },
    outbound: {
      deliveryMode: "gateway" as const,
      textChunkLimit: 2000,

      sendText: async ({ to, text, accountId, cfg }: SynologyChannelSendTextContext) => {
        const account = resolveOutboundAccount(cfg ?? {}, accountId);
        const incomingUrl = requireIncomingUrl(account);
        const ok = await sendMessage(incomingUrl, text, to, account.allowInsecureSsl);
        if (!ok) {
          throw new Error("Failed to send message to Synology Chat");
        }
        return attachChannelToResult(CHANNEL_ID, { messageId: `sc-${Date.now()}`, chatId: to });
      },

      sendMedia: async ({ to, mediaUrl, accountId, cfg }: SynologyChannelOutboundContext) => {
        const account = resolveOutboundAccount(cfg ?? {}, accountId);
        const incomingUrl = requireIncomingUrl(account);
        if (!mediaUrl) {
          throw new Error("No media URL provided");
        }

        const ok = await sendFileUrl(incomingUrl, mediaUrl, to, account.allowInsecureSsl);
        if (!ok) {
          throw new Error("Failed to send media to Synology Chat");
        }
        return attachChannelToResult(CHANNEL_ID, { messageId: `sc-${Date.now()}`, chatId: to });
      },
    },
  }) as unknown as SynologyChatPlugin;
}

export const synologyChatPlugin = createSynologyChatPlugin();
