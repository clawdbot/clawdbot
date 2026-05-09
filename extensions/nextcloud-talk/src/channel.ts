import { describeWebhookAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createLoggedPairingApprovalNotifier } from "openclaw/plugin-sdk/channel-pairing";
import { createAllowlistProviderRouteAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import {
  buildWebhookChannelStatusSummary,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { resolveNextcloudTalkAccount, type ResolvedNextcloudTalkAccount } from "./accounts.js";
import { nextcloudTalkApprovalAuth } from "./approval-auth.js";
import { probeNextcloudTalkBotResponseFeature } from "./bot-preflight.js";
import { buildChannelConfigSchema, DEFAULT_ACCOUNT_ID, type ChannelPlugin } from "./channel-api.js";
import {
  nextcloudTalkConfigAdapter,
  nextcloudTalkPairingTextAdapter,
  nextcloudTalkSecurityAdapter,
} from "./channel.adapters.js";
import { NextcloudTalkConfigSchema } from "./config-schema.js";
import { nextcloudTalkDoctor } from "./doctor.js";
import { nextcloudTalkGatewayAdapter } from "./gateway.js";
import { nextcloudTalkMessageAdapter } from "./message-adapter.js";
import {
  looksLikeNextcloudTalkTargetId,
  normalizeNextcloudTalkMessagingTarget,
} from "./normalize.js";
import { resolveNextcloudTalkGroupToolPolicy } from "./policy.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { resolveNextcloudTalkOutboundSessionRoute } from "./session-route.js";
import { nextcloudTalkSetupAdapter } from "./setup-core.js";
import { nextcloudTalkSetupWizard } from "./setup-surface.js";
import type { CoreConfig } from "./types.js";

const meta = {
  id: "nextcloud-talk",
  label: "Nextcloud Talk",
  selectionLabel: "Nextcloud Talk (self-hosted)",
  docsPath: "/channels/nextcloud-talk",
  docsLabel: "nextcloud-talk",
  blurb: "Self-hosted chat via Nextcloud Talk webhook bots.",
  aliases: ["nc-talk", "nc"],
  order: 65,
  quickstartAllowFrom: true,
};

const collectNextcloudTalkSecurityWarnings =
  createAllowlistProviderRouteAllowlistWarningCollector<ResolvedNextcloudTalkAccount>({
    providerConfigPresent: (cfg) =>
      (cfg.channels as Record<string, unknown> | undefined)?.["nextcloud-talk"] !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    resolveRouteAllowlistConfigured: (account) =>
      Boolean(account.config.rooms) && Object.keys(account.config.rooms ?? {}).length > 0,
    restrictSenders: {
      surface: "Nextcloud Talk rooms",
      openScope: "any member in allowed rooms",
      groupPolicyPath: "channels.nextcloud-talk.groupPolicy",
      groupAllowFromPath: "channels.nextcloud-talk.groupAllowFrom",
    },
    noRouteAllowlist: {
      surface: "Nextcloud Talk rooms",
      routeAllowlistPath: "channels.nextcloud-talk.rooms",
      routeScope: "room",
      groupPolicyPath: "channels.nextcloud-talk.groupPolicy",
      groupAllowFromPath: "channels.nextcloud-talk.groupAllowFrom",
    },
  });

export const nextcloudTalkPlugin: ChannelPlugin<ResolvedNextcloudTalkAccount> =
  createChatChannelPlugin({
    base: {
      id: "nextcloud-talk",
      meta,
      setupWizard: nextcloudTalkSetupWizard,
      capabilities: {
        chatTypes: ["direct", "group"],
        reactions: true,
        threads: false,
        media: true,
        nativeCommands: false,
        blockStreaming: true,
      },
      reload: { configPrefixes: ["channels.nextcloud-talk"] },
      configSchema: buildChannelConfigSchema(NextcloudTalkConfigSchema),
      config: {
        ...nextcloudTalkConfigAdapter,
        isConfigured: (account) => Boolean(account.secret?.trim() && account.baseUrl?.trim()),
        describeAccount: (account) =>
          describeWebhookAccountSnapshot({
            account,
            configured: Boolean(account.secret?.trim() && account.baseUrl?.trim()),
            extra: {
              secretSource: account.secretSource,
              baseUrl: account.baseUrl ? "[set]" : "[missing]",
            },
          }),
      },
      approvalCapability: nextcloudTalkApprovalAuth,
      doctor: nextcloudTalkDoctor,
      groups: {
        resolveRequireMention: ({ cfg, accountId, groupId }) => {
          const account = resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId });
          const rooms = account.config.rooms;
          if (!rooms || !groupId) {
            return true;
          }

          const roomConfig = rooms[groupId];
          if (roomConfig?.requireMention !== undefined) {
            return roomConfig.requireMention;
          }

          const wildcardConfig = rooms["*"];
          if (wildcardConfig?.requireMention !== undefined) {
            return wildcardConfig.requireMention;
          }

          return true;
        },
        resolveToolPolicy: resolveNextcloudTalkGroupToolPolicy,
      },
      messaging: {
        targetPrefixes: ["nextcloud-talk", "nc-talk", "nc"],
        normalizeTarget: normalizeNextcloudTalkMessagingTarget,
        resolveOutboundSessionRoute: (params) => resolveNextcloudTalkOutboundSessionRoute(params),
        targetResolver: {
          looksLikeId: looksLikeNextcloudTalkTargetId,
          hint: "<roomToken>",
        },
      },
      secrets: {
        secretTargetRegistryEntries,
        collectRuntimeConfigAssignments,
      },
      setup: nextcloudTalkSetupAdapter,
      status: createComputedAccountStatusAdapter<ResolvedNextcloudTalkAccount>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        buildChannelSummary: ({ snapshot }) =>
          buildWebhookChannelStatusSummary(snapshot, {
            secretSource: snapshot.secretSource ?? "none",
          }),
        collectStatusIssues: (accounts) =>
          accounts.flatMap((account) => {
            const probe = account.probe as
              | { ok?: boolean; code?: string; message?: string }
              | undefined;
            if (
              !probe ||
              probe.ok !== false ||
              probe.code !== "missing_response_feature" ||
              !probe.message
            ) {
              return [];
            }
            return [
              {
                channel: "nextcloud-talk",
                accountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
                kind: "config",
                message: probe.message,
                fix: "Add --feature response to the Talk bot.",
              } as const,
            ];
          }),
        probeAccount: async ({ account, timeoutMs }) =>
          await probeNextcloudTalkBotResponseFeature({ account, timeoutMs }),
        resolveAccountSnapshot: ({ account }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: Boolean(account.secret?.trim() && account.baseUrl?.trim()),
          extra: {
            secretSource: account.secretSource,
            baseUrl: account.baseUrl ? "[set]" : "[missing]",
            mode: "webhook",
          },
        }),
      }),
      gateway: nextcloudTalkGatewayAdapter,
      message: nextcloudTalkMessageAdapter,
    },
    pairing: {
      text: {
        ...nextcloudTalkPairingTextAdapter,
        notify: createLoggedPairingApprovalNotifier(
          ({ id }) => `[nextcloud-talk] User ${id} approved for pairing`,
        ),
      },
    },
    security: {
      ...nextcloudTalkSecurityAdapter,
      collectWarnings: collectNextcloudTalkSecurityWarnings,
    },
    outbound: {
      base: {
        deliveryMode: "direct",
        chunker: (text, limit) =>
          getNextcloudTalkRuntime().channel.text.chunkMarkdownText(text, limit),
        chunkerMode: "markdown",
        textChunkLimit: 4000,
      },
      attachedResults: {
        channel: "nextcloud-talk",
        sendText: async ({ cfg, to, text, accountId, replyToId }) =>
          await nextcloudTalkMessageAdapter.send.text({
            cfg,
            to,
            text,
            accountId,
            replyToId,
          }),
        sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) =>
          await nextcloudTalkMessageAdapter.send.media({
            cfg,
            to,
            text,
            mediaUrl: mediaUrl ?? "",
            accountId,
            replyToId,
          }),
      },
    },
  });
