import type {
  ChannelPlugin,
  ClawdbotConfig,
} from "clawdbot/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
} from "clawdbot/plugin-sdk";

import type { ResolvedGoogleChatAccount } from "./accounts.js";
import {
  listGoogleChatAccountIds,
  resolveDefaultGoogleChatAccountId,
  resolveGoogleChatAccount,
} from "./accounts.js";
import { probeGoogleChat } from "./probe.js";
import {
  chunkGoogleChatText,
  sendGoogleChatMedia,
  sendGoogleChatText,
} from "./send.js";

const meta = {
  id: "googlechat",
  label: "Google Chat",
  selectionLabel: "Google Chat (Pub/Sub)",
  docsPath: "/channels/google-chat",
  docsLabel: "google-chat",
  blurb: "Google Chat via Pub/Sub webhooks",
  order: 70,
} as const;

export const googlechatPlugin: ChannelPlugin<ResolvedGoogleChatAccount> = {
  id: "googlechat",
  meta: {
    ...meta,
  },
  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    threads: true,
    media: false, // Google Chat doesn't support direct media upload via API
  },
  reload: { configPrefixes: ["channels.googlechat"] },
  config: {
    listAccountIds: (cfg: ClawdbotConfig) => listGoogleChatAccountIds(cfg),
    resolveAccount: (cfg: ClawdbotConfig, accountId?: string) =>
      resolveGoogleChatAccount({ cfg, accountId }),
    defaultAccountId: (cfg: ClawdbotConfig) =>
      resolveDefaultGoogleChatAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const googlechat = cfg.channels?.googlechat ?? {};
      const accounts = googlechat.accounts ?? {};

      // Single account mode
      if (accountId === DEFAULT_ACCOUNT_ID && !accounts[accountId]) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            googlechat: {
              ...googlechat,
              enabled,
            },
          },
        };
      }

      // Multi-account mode
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          googlechat: {
            ...googlechat,
            accounts: {
              ...accounts,
              [accountId]: {
                ...accounts[accountId],
                enabled,
              },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const googlechat = cfg.channels?.googlechat ?? {};
      const accounts = { ...googlechat.accounts };

      delete accounts[accountId];

      // If deleting default account in single-account mode, clear top-level config
      if (accountId === DEFAULT_ACCOUNT_ID && Object.keys(accounts).length === 0) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            googlechat: undefined,
          },
        };
      }

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          googlechat: {
            ...googlechat,
            accounts,
          },
        },
      };
    },
    isConfigured: (account: ResolvedGoogleChatAccount) =>
      Boolean(account.projectId?.trim() && account.subscriptionName?.trim()),
    describeAccount: (account: ResolvedGoogleChatAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(
        account.projectId?.trim() && account.subscriptionName?.trim(),
      ),
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveGoogleChatAccount({ cfg, accountId }).config.allowFrom ?? [],
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean),
  },
  pairing: {
    idLabel: "email",
    normalizeAllowEntry: (entry) => entry.toLowerCase().trim(),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const googlechat = cfg.channels?.googlechat ?? {};
      const accounts = googlechat.accounts ?? {};
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(accounts[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.googlechat.accounts.${resolvedAccountId}.`
        : "channels.googlechat.";

      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: `${basePath}allowFrom`,
        approveHint: `clawdbot channels pair googlechat --approve <email>`,
        normalizeEntry: (raw) => raw.toLowerCase().trim(),
      };
    },
  },
  threading: {
    resolveReplyToMode: () => "first",
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildProviderSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      probeGoogleChat(account, timeoutMs),
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const configured = Boolean(
        account.projectId?.trim() && account.subscriptionName?.trim(),
      );
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        probe,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: chunkGoogleChatText,
    textChunkLimit: 4000,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error("Delivering to Google Chat requires --to <spaceId>"),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text, accountId, cfg, replyToId }) => {
      const account = resolveGoogleChatAccount({ cfg, accountId });
      const result = await sendGoogleChatText(to, text, {
        account,
        threadKey: replyToId ?? undefined,
      });
      return { provider: "googlechat", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg, replyToId }) => {
      const account = resolveGoogleChatAccount({ cfg, accountId });
      const result = await sendGoogleChatMedia(to, mediaUrl ?? "", {
        account,
        caption: text,
        threadKey: replyToId ?? undefined,
      });
      return { provider: "googlechat", ...result };
    },
  },
};
