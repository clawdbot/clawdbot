import { describeWebhookAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
  mapAllowFromEntries,
} from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import {
  buildChannelConfigSchema,
  createChatChannelPlugin,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import {
  buildOpenGroupPolicyRestrictSendersWarning,
  buildOpenGroupPolicyWarning,
  createOpenProviderGroupPolicyWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import {
  createEmptyChannelResult,
  createRawChannelSendResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { buildTokenChannelStatusSummary } from "openclaw/plugin-sdk/channel-status";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { createStaticReplyToModeResolver } from "openclaw/plugin-sdk/conversation-runtime";
import { createChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { listResolvedDirectoryUserEntriesFromAllowFrom } from "openclaw/plugin-sdk/directory-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  isNumericTargetId,
  sendPayloadWithChunkedTextAndMedia,
} from "openclaw/plugin-sdk/reply-payload";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import {
  listZaloAccountIds,
  resolveDefaultZaloAccountId,
  resolveZaloAccount,
  type ResolvedZaloAccount,
} from "./accounts.js";
import { zaloMessageActions } from "./actions.js";
import { zaloApprovalAuth } from "./approval-auth.js";
import { ZaloConfigSchema } from "./config-schema.js";
import type { ZaloProbeResult } from "./probe.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { resolveZaloOutboundSessionRoute } from "./session-route.js";
import { createZaloSetupWizardProxy, zaloSetupAdapter } from "./setup-core.js";
import { collectZaloStatusIssues } from "./status-issues.js";

const meta = {
  id: "zalo",
  label: "Zalo",
  selectionLabel: "Zalo (Bot API)",
  docsPath: "/channels/zalo",
  docsLabel: "zalo",
  blurb: "Vietnam-focused messaging platform with Bot API.",
  aliases: ["zl"],
  order: 80,
  quickstartAllowFrom: true,
};

function normalizeZaloMessagingTarget(raw: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^(zalo|zl):/i, "").trim();
}

const loadZaloChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime.js"));
const zaloSetupWizard = createZaloSetupWizardProxy(
  async () => (await import("./setup-surface.js")).zaloSetupWizard,
);
const zaloTextChunkLimit = 2000;

const zaloRawSendResultAdapter = createRawChannelSendResultAdapter({
  channel: "zalo",
  sendText: async ({ to, text, accountId, cfg }) =>
    await (
      await loadZaloChannelRuntime()
    ).sendZaloText({
      to,
      text,
      accountId: accountId ?? undefined,
      cfg,
    }),
  sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) =>
    await (
      await loadZaloChannelRuntime()
    ).sendZaloText({
      to,
      text,
      accountId: accountId ?? undefined,
      mediaUrl,
      cfg,
    }),
});

const zaloConfigAdapter = createScopedChannelConfigAdapter<ResolvedZaloAccount>({
  sectionKey: "zalo",
  listAccountIds: listZaloAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveZaloAccount),
  defaultAccountId: resolveDefaultZaloAccountId,
  clearBaseFields: ["botToken", "tokenFile", "name"],
  resolveAllowFrom: (account: ResolvedZaloAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(zalo|zl):/i }),
});

const resolveZaloDmPolicy = createScopedDmSecurityResolver<ResolvedZaloAccount>({
  channelKey: "zalo",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) => raw.trim().replace(/^(zalo|zl):/i, ""),
});

const collectZaloSecurityWarnings = createOpenProviderGroupPolicyWarningCollector<{
  cfg: OpenClawConfig;
  account: ResolvedZaloAccount;
}>({
  providerConfigPresent: (cfg) => cfg.channels?.zalo !== undefined,
  resolveGroupPolicy: ({ account }) => account.config.groupPolicy,
  collect: ({ account, groupPolicy }) => {
    if (groupPolicy !== "open") {
      return [];
    }
    const explicitGroupAllowFrom = mapAllowFromEntries(account.config.groupAllowFrom);
    const dmAllowFrom = mapAllowFromEntries(account.config.allowFrom);
    const effectiveAllowFrom =
      explicitGroupAllowFrom.length > 0 ? explicitGroupAllowFrom : dmAllowFrom;
    if (effectiveAllowFrom.length > 0) {
      return [
        buildOpenGroupPolicyRestrictSendersWarning({
          surface: "Zalo groups",
          openScope: "any member",
          groupPolicyPath: "channels.zalo.groupPolicy",
          groupAllowFromPath: "channels.zalo.groupAllowFrom",
        }),
      ];
    }
    return [
      buildOpenGroupPolicyWarning({
        surface: "Zalo groups",
        openBehavior:
          "with no groupAllowFrom/allowFrom allowlist; any member can trigger (mention-gated)",
        remediation: 'Set channels.zalo.groupPolicy="allowlist" + channels.zalo.groupAllowFrom',
      }),
    ];
  },
});

export const zaloPlugin: ChannelPlugin<ResolvedZaloAccount, ZaloProbeResult> =
  createChatChannelPlugin({
    base: {
      id: "zalo",
      meta,
      setup: zaloSetupAdapter,
      setupWizard: zaloSetupWizard,
      capabilities: {
        chatTypes: ["direct", "group"],
        media: true,
        reactions: false,
        threads: false,
        polls: false,
        nativeCommands: false,
        blockStreaming: true,
      },
      reload: { configPrefixes: ["channels.zalo"] },
      configSchema: buildChannelConfigSchema(ZaloConfigSchema),
      config: {
        ...zaloConfigAdapter,
        isConfigured: (account) => Boolean(account.token?.trim()),
        describeAccount: (account): ChannelAccountSnapshot =>
          describeWebhookAccountSnapshot({
            account,
            configured: Boolean(account.token?.trim()),
            mode: account.config.webhookUrl ? "webhook" : "polling",
            extra: {
              tokenSource: account.tokenSource,
            },
          }),
      },
      approvalCapability: zaloApprovalAuth,
      secrets: {
        secretTargetRegistryEntries,
        collectRuntimeConfigAssignments,
      },
      groups: {
        resolveRequireMention: () => true,
      },
      actions: zaloMessageActions,
      messaging: {
        targetPrefixes: ["zalo", "zl"],
        normalizeTarget: normalizeZaloMessagingTarget,
        resolveOutboundSessionRoute: (params) => resolveZaloOutboundSessionRoute(params),
        targetResolver: {
          looksLikeId: isNumericTargetId,
          hint: "<chatId>",
        },
      },
      directory: createChannelDirectoryAdapter({
        listPeers: async (params) =>
          listResolvedDirectoryUserEntriesFromAllowFrom<ResolvedZaloAccount>({
            ...params,
            resolveAccount: adaptScopedAccountAccessor(resolveZaloAccount),
            resolveAllowFrom: (account) => account.config.allowFrom,
            normalizeId: (entry) => entry.trim().replace(/^(zalo|zl):/i, ""),
          }),
        listGroups: async () => [],
      }),
      status: createComputedAccountStatusAdapter<ResolvedZaloAccount, ZaloProbeResult>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        collectStatusIssues: collectZaloStatusIssues,
        buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
        probeAccount: async ({ account, timeoutMs }) =>
          await (await loadZaloChannelRuntime()).probeZaloAccount({ account, timeoutMs }),
        resolveAccountSnapshot: ({ account }) => {
          const configured = Boolean(account.token?.trim());
          return {
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured,
            extra: {
              tokenSource: account.tokenSource,
              mode: account.config.webhookUrl ? "webhook" : "polling",
              dmPolicy: account.config.dmPolicy ?? "pairing",
            },
          };
        },
      }),
      gateway: {
        startAccount: async (ctx) =>
          await (await loadZaloChannelRuntime()).startZaloGatewayAccount(ctx),
      },
    },
    security: {
      resolveDmPolicy: resolveZaloDmPolicy,
      collectWarnings: collectZaloSecurityWarnings,
    },
    pairing: {
      text: {
        idLabel: "zaloUserId",
        message: "Your pairing request has been approved.",
        normalizeAllowEntry: (entry) => entry.trim().replace(/^(zalo|zl):/i, ""),
        notify: async (params) =>
          await (await loadZaloChannelRuntime()).notifyZaloPairingApproval(params),
      },
    },
    threading: {
      resolveReplyToMode: createStaticReplyToModeResolver("off"),
    },
    outbound: {
      deliveryMode: "direct",
      chunker: chunkTextForOutbound,
      chunkerMode: "text",
      textChunkLimit: zaloTextChunkLimit,
      sendPayload: async (ctx) =>
        await sendPayloadWithChunkedTextAndMedia({
          ctx,
          textChunkLimit: zaloTextChunkLimit,
          chunker: chunkTextForOutbound,
          sendText: (nextCtx) => zaloRawSendResultAdapter.sendText!(nextCtx),
          sendMedia: (nextCtx) => zaloRawSendResultAdapter.sendMedia!(nextCtx),
          emptyResult: createEmptyChannelResult("zalo"),
        }),
      ...zaloRawSendResultAdapter,
    },
  });
