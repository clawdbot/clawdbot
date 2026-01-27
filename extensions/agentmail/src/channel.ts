import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "clawdbot/plugin-sdk";

import {
  listAgentMailAccountIds,
  resolveAgentMailAccount,
  resolveDefaultAgentMailAccountId,
  resolveCredentials,
} from "./accounts.js";
import { getAgentMailClient } from "./client.js";
import { AgentMailConfigSchema } from "./config-schema.js";
import { agentmailOnboardingAdapter } from "./onboarding.js";
import { agentmailOutbound } from "./outbound.js";
import { createAgentMailTools } from "./tools.js";
import type { CoreConfig, ResolvedAgentMailAccount } from "./utils.js";

const meta = {
  id: "agentmail",
  label: "AgentMail (Email Inbox API)",
  selectionLabel: "AgentMail (Email Inbox API)",
  docsPath: "/channels/agentmail",
  docsLabel: "agentmail",
  blurb: "Email channel via AgentMail; configure token and email address.",
  order: 80,
  quickstartAllowFrom: true,
};

export const agentmailPlugin: ChannelPlugin<ResolvedAgentMailAccount> = {
  id: "agentmail",
  meta,
  capabilities: {
    chatTypes: ["direct"],
    media: true,
    threads: true,
    polls: false,
    reactions: false,
  },
  reload: { configPrefixes: ["channels.agentmail"] },
  configSchema: buildChannelConfigSchema(AgentMailConfigSchema),

  config: {
    listAccountIds: (cfg) => listAgentMailAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) =>
      resolveAgentMailAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) =>
      resolveDefaultAgentMailAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "agentmail",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "agentmail",
        accountId,
        clearBaseFields: [
          "name",
          "token",
          "emailAddress",
          "webhookPath",
          "allowFrom",
        ],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      emailAddress: account.inboxId,
    }),
    resolveAllowFrom: ({ cfg }) =>
      ((cfg as CoreConfig).channels?.agentmail?.allowFrom ?? []).map((entry) =>
        String(entry)
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).toLowerCase().trim())
        .filter(Boolean),
  },

  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: "open",
      allowFrom: account.config.allowFrom ?? [],
      policyPath: "channels.agentmail.allowFrom",
      allowFromPath: "channels.agentmail.allowFrom",
      approveHint:
        "Add email addresses or domains to channels.agentmail.allowFrom",
      normalizeEntry: (raw) => raw.toLowerCase().trim(),
    }),
    collectWarnings: ({ account }) => {
      const warnings: string[] = [];
      const { allowFrom = [] } = account.config;

      if (allowFrom.length === 0) {
        warnings.push(
          "- AgentMail: No allowFrom configured. All senders will be allowed."
        );
      }

      return warnings;
    },
  },

  messaging: {
    normalizeTarget: (raw) => raw.trim() || undefined,
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) return false;
        // Check if it looks like an email
        return trimmed.includes("@") && trimmed.includes(".");
      },
      hint: "<email@example.com>",
    },
  },

  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg as CoreConfig,
        channelKey: "agentmail",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (input.useEnv) return null;
      if (!input.token?.trim()) return "AgentMail requires --token";
      if (!input.emailAddress?.trim())
        return "AgentMail requires --email-address";
      return null;
    },
    applyAccountConfig: ({ cfg, input }) => {
      const existing = (cfg as CoreConfig).channels?.agentmail ?? {};
      return {
        ...cfg,
        channels: {
          ...(cfg as CoreConfig).channels,
          agentmail: {
            ...existing,
            enabled: true,
            ...(input.useEnv
              ? {}
              : {
                  ...(input.token?.trim() ? { token: input.token.trim() } : {}),
                  ...(input.emailAddress?.trim()
                    ? { emailAddress: input.emailAddress.trim() }
                    : {}),
                  ...(input.webhookPath?.trim()
                    ? { webhookPath: input.webhookPath.trim() }
                    : {}),
                }),
          },
        },
      };
    },
  },

  outbound: agentmailOutbound,

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError =
          typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) return [];
        return [
          {
            channel: "agentmail",
            accountId: account.accountId,
            kind: "runtime",
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      emailAddress: snapshot.emailAddress ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ cfg }) => {
      try {
        const { apiKey, inboxId } = resolveCredentials(cfg as CoreConfig);

        if (!apiKey || !inboxId) {
          return {
            ok: false,
            error: "Missing token or email address",
            elapsedMs: 0,
          };
        }

        const start = Date.now();
        const client = getAgentMailClient(apiKey);

        // Probe by getting inbox info
        const inbox = await client.inboxes.get(inboxId);
        const elapsedMs = Date.now() - start;

        return {
          ok: true,
          elapsedMs,
          meta: {
            inboxId: inbox.inboxId, // inboxId is the email address
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          elapsedMs: 0,
        };
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      emailAddress: account.inboxId,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastProbeAt: runtime?.lastProbeAt ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        emailAddress: account.inboxId,
      });
      ctx.log?.info(
        `[${account.accountId}] starting AgentMail provider (email: ${
          account.inboxId ?? "unknown"
        })`
      );

      // Lazy import: avoid ESM init cycles
      const { monitorAgentMailProvider } = await import("./monitor.js");
      return monitorAgentMailProvider({
        accountId: account.accountId,
        abortSignal: ctx.abortSignal,
      });
    },
  },

  onboarding: agentmailOnboardingAdapter,

  agentTools: () => createAgentMailTools(),
};
